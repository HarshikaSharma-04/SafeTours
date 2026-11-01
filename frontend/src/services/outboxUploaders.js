import { apiClient } from './apiClient';
import { classifyResult } from '../offline/outboxLogic';
import { sendWithBisect } from '../offline/batchSend';
import { session } from './session';

/**
 * How each outbox type reaches the server. Every request carries the row's Idempotency-Key header (or one key
 * per point for batches), so a re-send after a lost response never creates a second record.
 *
 * sendGroup(rows) -> [{ row, outcome:{kind:'sent'|'retry'|'dead'|'hold', error?, retryAfterMs?, holdMs?}, patch? }]
 *   patch = payload fields to merge into the row (e.g. the server's id for an SOS)
 */

/** axios error -> outcome (see offline/outboxLogic.classifyResult for the 4xx / 5xx rules). */
export function outcomeFromError(error, { transient409 = false } = {}) {
  const status = error && error.response ? error.response.status : undefined;
  const message = (error && error.response && error.response.data && error.response.data.message) || (error && error.message) || 'request failed';
  const retryAfter = Number(error && error.response && error.response.headers && error.response.headers['retry-after']);
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;

  // Signed out / token could not be refreshed: nobody is to blame, wait until the user signs in again.
  if (status === 401) return { kind: 'hold', error: 'Signed out: sign in again to upload', holdMs: 60000 };
  // The geofence sync answers 409 when two updates raced: that is a retry, not a rejection.
  if (status === 409 && transient409) return { kind: 'retry', error: `HTTP 409: ${message}`, retryAfterMs };

  const kind = classifyResult({ status, networkError: !status });
  return { kind, error: status ? `HTTP ${status}: ${message}` : message, retryAfterMs };
}

const iso = (ms) => new Date(ms).toISOString();
const keyHeader = (key) => ({ headers: { 'Idempotency-Key': key } });

async function post(url, body, key, opts) {
  try {
    const res = await apiClient.post(url, body, { ...keyHeader(key), timeout: 20000 });
    return { ok: true, res };
  } catch (error) {
    return { ok: false, outcome: outcomeFromError(error, opts) };
  }
}

const one = (row, r, patchFrom) =>
  r.ok ? [{ row, outcome: { kind: 'sent' }, patch: patchFrom ? patchFrom(r.res) : undefined }] : [{ row, outcome: r.outcome }];

const senders = {
  async sos(rows, ctx) {
    const row = rows[0];
    const p = row.payload;
    // The upload waits for the SMS attempt of this SOS (at most smsHoldMs) so the report it carries is complete.
    if (p.holdUntil && p.holdUntil > ctx.now) return [{ row, outcome: { kind: 'hold', holdMs: p.holdUntil - ctx.now + 250 } }];

    // The server's word for "nobody to text" is 'none': it rejects the whole SOS on an outcome it does not know.
    const sms = p.sms && p.sms.outcome ? { outcome: p.sms.outcome === 'no_contacts' ? 'none' : p.sms.outcome, sentTo: p.sms.sentTo || [], total: p.sms.total || 0, attemptedAt: p.sms.lastAttemptAt ? iso(p.sms.lastAttemptAt) : undefined } : undefined;
    const body = {
      ...(p.location ? { location: p.location } : {}),
      ...(p.journeyId ? { journeyId: p.journeyId } : {}),
      reason: p.reason || 'Manual SOS',
      clientCreatedAt: iso(row.createdAt),
      ...(sms ? { sms } : {}),
    };
    const r = await post('/sos', body, row.idempotencyKey);
    return one(row, r, (res) => {
      const rec = (res.data && res.data.data) || {};
      return { serverId: rec.id || rec._id || null, delivery: res.data && res.data.delivery, serverStatus: rec.status, lateDelivery: Boolean(rec.lateDelivery) };
    });
  },

  async sos_cancel(rows) {
    const row = rows[0];
    const r = await post(`/sos/${row.payload.sosId}/cancel`, { reason: row.payload.reason || 'Cancelled by user' }, row.idempotencyKey);
    return one(row, r);
  },

  async journey_update(rows) {
    const row = rows[0];
    const r = await post(`/journey/update/${row.payload.journeyId}`, row.payload.update || {}, row.idempotencyKey);
    return one(row, r);
  },

  async community_report(rows) {
    const row = rows[0];
    const r = await post('/community/report', row.payload.report || row.payload, row.idempotencyKey);
    return one(row, r);
  },

  /** Device geofence events: history only (POST /geofence/events). */
  async geofence_event(rows) {
    const events = rows.map((row) => ({
      event: row.payload.event,
      timestamp: row.payload.timestamp,
      h3Index: row.payload.h3Index,
      riskLevel: row.payload.riskLevel || 'UNKNOWN',
      totalRisk: row.payload.totalRisk,
      latitude: row.payload.latitude,
      longitude: row.payload.longitude,
    }));
    const results = await sendWithBisect(rows.map((row, i) => ({ row, event: events[i] })), async (group) => {
      const r = await post('/geofence/events', { events: group.map((g) => g.event) }, group[0].row.idempotencyKey);
      return r.ok ? { kind: 'sent' } : r.outcome;
    });
    return results.map((x) => ({ row: x.item.row, outcome: { kind: x.kind, error: x.error, retryAfterMs: x.retryAfterMs } }));
  },

  /** Location points: 'geofence' channel -> /geofence/sync (server replays them); 'track' -> /location/batch. */
  async location_point(rows) {
    const out = [];
    const geofence = rows.filter((r) => r.payload.channel === 'geofence');
    const track = rows.filter((r) => r.payload.channel !== 'geofence');

    if (geofence.length) {
      const items = geofence.map((row) => ({ row, point: { latitude: row.payload.latitude, longitude: row.payload.longitude, accuracy: row.payload.accuracy ?? undefined, timestamp: row.payload.timestamp } }));
      const results = await sendWithBisect(items, async (group) => {
        const r = await post('/geofence/sync', { locations: group.map((g) => g.point) }, group[0].row.idempotencyKey, { transient409: true });
        return r.ok ? { kind: 'sent' } : r.outcome;
      });
      results.forEach((x) => out.push({ row: x.item.row, outcome: { kind: x.kind, error: x.error, retryAfterMs: x.retryAfterMs } }));
    }
    if (track.length) {
      const items = track.map((row) => ({ row, point: { idempotencyKey: row.idempotencyKey, latitude: row.payload.latitude, longitude: row.payload.longitude, accuracy: row.payload.accuracy, speed: row.payload.speed, heading: row.payload.heading, timestamp: row.payload.timestamp } }));
      const results = await sendWithBisect(items, async (group) => {
        const r = await post('/location/batch', { points: group.map((g) => g.point) }, group[0].row.idempotencyKey);
        return r.ok ? { kind: 'sent' } : r.outcome;
      });
      results.forEach((x) => out.push({ row: x.item.row, outcome: { kind: x.kind, error: x.error, retryAfterMs: x.retryAfterMs } }));
    }
    return out;
  },
};

/** @param {Array} rows a group of the same type, as returned by outboxStore.claimNext() */
export async function sendGroup(rows, now = Date.now()) {
  const send = senders[rows[0].type];
  if (!send) return rows.map((row) => ({ row, outcome: { kind: 'dead', error: `unknown type ${row.type}` } }));

  // Rows of another account (or of nobody who is signed in yet) wait: they are never uploaded under the wrong user.
  const me = session.get();
  const mine = [];
  const held = [];
  for (const row of rows) {
    const owner = row.payload && row.payload._owner;
    if (owner && owner !== me) held.push({ row, outcome: { kind: 'hold', error: 'waiting for its owner to sign in', holdMs: 60000 } });
    else mine.push(row);
  }
  if (mine.length === 0) return held;
  try {
    return [...held, ...(await send(mine, { now }))];
  } catch (error) {
    // A bug must not lose the row: treat it as a retryable failure.
    return rows.map((row) => ({ row, outcome: { kind: 'retry', error: `uploader error: ${error.message}` } }));
  }
}
