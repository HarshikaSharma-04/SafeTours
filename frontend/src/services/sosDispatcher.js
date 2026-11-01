import * as Location from 'expo-location';
import { outboxStore, newIdempotencyKey } from '../storage/outboxStore';
import { outboxRunner } from './outboxRunner';
import { outbox } from './outbox';
import { connectivityStore } from '../connectivity/connectivityStore';
import { contactsCache } from './contactsCache';
import { profileService } from './profile';
import { apiClient } from './apiClient';
import { smsEnvironment, sendDirect, openComposer, requestSmsPermission } from './smsSender';
import { locationBus } from '../utils/locationBus';
import { planSms, emptySms, reduceDirect, reduceComposer, reduceNone, shouldRetrySms, contactsToRetry, uniqueContacts, findReusableSos, singleFlight } from '../offline/smsLogic';
import { buildSosSms, buildSafeSms } from '../offline/sosMessage';
import { planCancel } from '../offline/outboxLogic';
import { outbox as outboxCfg, sms as smsCfg } from '../offline/offlineConfig';

/**
 * SOS dispatcher: what happens between "the user triggered SOS" and "somebody was alerted".
 *
 * 1. The SOS is written to the outbox FIRST (so it survives a crash, a kill, a dead network), under an
 *    idempotency key that never changes.
 * 2. The phone texts the contacts itself, with or without internet (direct SMS on Android with permission, the
 *    prefilled composer otherwise), and records the result on the row. SEND_SMS is asked for once, on the first SOS,
 *    if nothing asked before; the retry timer never asks.
 * 3. Online: it is uploaded once the texts went out, or after outbox.smsFirstWaitMs if they are slow. Whatever is not
 *    delivered stays in the outbox and is uploaded when the connection returns; the upload carries the SMS report so
 *    the server (Twilio, if configured) does not text the same contacts again.
 * 4. A FAILED text (no signal / no service), or one never attempted because the app was killed, is retried on a timer
 *    for sms.retryWindowMs. The timer only runs while the app's JS is alive.
 *
 * The UI reads the row (offline/smsLogic.sosView) and shows three separate facts: queued on the phone, SMS sent,
 * delivered to the server. It never says "sent" when only the local queue succeeded.
 */
const HOLD_TYPES = ['sos'];
const volatile = new Map(); // SOS rows that could not be stored (SQLite unavailable): the text still goes out
const attempting = new Set();
const creatingKeys = new Set(); // rows createSos is still working on: the retry timer leaves them alone
const listeners = new Set();
let askingPermission = null; // the SEND_SMS dialog, while it is open
let lastCancelled = null;
let retryTimer = null;
let started = false;

const emit = () => listeners.forEach((fn) => { try { fn(); } catch (e) { /* listener bug */ } });

// ── row access (SQLite, or memory when SQLite is unavailable) ─────────────────────────────────────
const read = async (h) => (h.volatile ? volatile.get(h.key) : outboxStore.get(h.id));
async function patch(h, fields) {
  if (h.volatile) {
    const row = volatile.get(h.key);
    if (!row) return null; // cancelled in the meantime
    volatile.set(h.key, { ...row, payload: { ...row.payload, ...fields } });
    return volatile.get(h.key);
  }
  return outboxStore.updatePayload(h.id, fields);
}

// ── location ─────────────────────────────────────────────────────────────────────────────────────
const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

/** Best position available within a few seconds. Never invented: null when the phone has none. */
async function bestLocation() {
  const last = locationBus.getLast();
  if (last && Date.now() - last.timestamp < 120000) return toPayload(last);
  try {
    const fresh = await withTimeout(Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }), 5000);
    if (fresh) return toPayload({ latitude: fresh.coords.latitude, longitude: fresh.coords.longitude, accuracy: fresh.coords.accuracy, timestamp: fresh.timestamp });
    const known = await Location.getLastKnownPositionAsync();
    if (known) return toPayload({ latitude: known.coords.latitude, longitude: known.coords.longitude, accuracy: known.coords.accuracy, timestamp: known.timestamp });
  } catch (e) {
    /* no permission / no GPS */
  }
  return last ? toPayload(last) : null;
}
const toPayload = (l) => ({ latitude: l.latitude, longitude: l.longitude, accuracy: l.accuracy ?? undefined, timestamp: new Date(l.timestamp || Date.now()).toISOString() });

/** The newest position held right now, without waiting: a GPS update newer than `saved` wins. Null when there is none. */
function latestLocation(saved) {
  const last = locationBus.getLast();
  if (!last) return saved || null;
  return saved && saved.timestamp && Date.parse(saved.timestamp) >= last.timestamp ? saved : toPayload(last);
}

// ── SMS ──────────────────────────────────────────────────────────────────────────────────────────
async function smsContext() {
  let cached = await contactsCache.get();
  if ((!cached || cached.contacts.length === 0) && !connectivityStore.getState().isOffline) {
    await contactsCache.refresh();
    cached = await contactsCache.get();
  }
  let profile = await profileService.getCachedSosProfile();
  if (!profile && !connectivityStore.getState().isOffline) {
    try {
      await profileService.getProfile();
      profile = await profileService.getCachedSosProfile();
    } catch (e) {
      /* offline: no name */
    }
  }
  return { contacts: uniqueContacts(((cached && cached.contacts) || []).filter((c) => c.phone)), name: profile && profile.name, customText: profile && profile.customSosMessage };
}

/**
 * One text-message attempt for an SOS row (all contacts the phone has not texted yet).
 * Without `force` it does nothing when the row already has a final answer: 'sent' (everyone texted),
 * 'composer_opened' (never re-open the composer by itself) or 'no_permission' (needs the user).
 * `background` (timer, late upload): nobody just pressed anything, so the composer is not opened.
 */
async function attemptSms(handle, { force = false, background = false } = {}) {
  const key = handle.key;
  if (attempting.has(key)) return null;
  attempting.add(key);
  try {
    const row = await read(handle);
    if (!row || row.payload.cancelled || row.payload.cancelRequested) return null;
    const prev = row.payload.sms || null;
    if (!force && prev && ['sent', 'composer_opened', 'no_permission'].includes(prev.outcome)) return prev;
    const ctx = await smsContext();
    const targets = contactsToRetry(prev, ctx.contacts);
    if (prev && targets.length === 0 && (prev.sentTo || []).length > 0) return prev; // everyone already has it
    const env = await smsEnvironment();
    const plan = planSms({ ...env, contactCount: targets.length });
    if (background && plan.strategy === 'composer') return prev;
    const loc = latestLocation(row.payload.location) || {};
    const built = buildSosSms({ name: ctx.name, lat: loc.latitude, lng: loc.longitude, accuracy: loc.accuracy, fixAt: loc.timestamp, staleFixMs: smsCfg.staleFixMs, triggeredAt: row.createdAt, customText: ctx.customText, maxSegments: smsCfg.maxSegments });
    const phones = targets.map((c) => c.phone);
    const now = Date.now();
    const report = (state) => ({ ...state, total: Math.max(state.total || 0, ctx.contacts.length), message: { text: built.text, segments: built.segments, encoding: built.encoding, cut: built.cut } });

    let next;
    if (plan.strategy === 'direct') {
      // `base` knows the real total, so a report saved half way reads 'partial', never 'sent'.
      const base = prev || emptySms(ctx.contacts.length);
      const results = await sendDirect(phones, built.text, async (soFar) => {
        await patch(handle, { sms: report(reduceDirect(base, soFar, now)) });
        emit();
      });
      next = reduceDirect(base, results, now);
    } else if (plan.strategy === 'composer') next = reduceComposer(prev, await openComposerSafe(phones, built.text), phones, now, plan.reason);
    else next = reduceNone(prev, plan.reason, now, ctx.contacts.length);

    next = report(next);
    await patch(handle, { sms: next, holdUntil: null });
    emit();
    outboxRunner.kick(0); // the report is complete: let the upload go
    return next;
  } finally {
    attempting.delete(key);
  }
}

/**
 * The attempt that follows a press. Only here is SEND_SMS asked for, and only if it never was. An unanswered dialog
 * does not hold the SOS up: its answer sends the text whenever it comes (and nothing opens over the dialog meanwhile).
 */
async function smsAfterPress(handle) {
  const env = await smsEnvironment();
  if (env.directAvailable && env.permission === 'undetermined') {
    if (askingPermission) return null;
    askingPermission = requestSmsPermission();
    const answer = await withTimeout(askingPermission, smsCfg.permissionWaitMs);
    if (!answer) {
      askingPermission.then(() => {
        askingPermission = null;
        return attemptSms(handle, { force: true });
      }).catch(() => {});
      return null;
    }
    askingPermission = null;
  }
  return attemptSms(handle);
}

async function openComposerSafe(phones, text) {
  try {
    return await openComposer(phones, text);
  } catch (e) {
    return 'cancelled'; // composer could not open: reported as a failure, never as sent
  }
}

/** Waits (up to ms) until the row is no longer 'sending'. */
async function waitSettled(handle, ms) {
  const until = Date.now() + ms;
  let row = await read(handle);
  while (row && row.status === 'sending' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 400));
    row = await read(handle);
  }
  return row;
}

// ── trigger ──────────────────────────────────────────────────────────────────────────────────────
/**
 * @param {{source?:string, reason?:string, journeyId?:string, location?:Object}} p
 * @returns {Promise<{handle:Object, queued:boolean, storage:boolean}>}
 */
export const triggerSos = singleFlight(async (args = {}) => {
  // A double tap, or the volume buttons plus the screen button, must not make two SOS. singleFlight covers presses
  // while one is being created; after that, a recent SOS that was not cancelled is reused, and only contacts not
  // texted yet can get a text from it.
  const existing = findReusableSos(await getSosRows(), Date.now());
  if (existing) {
    const handle = { key: existing.idempotencyKey, id: existing.id, volatile: !existing.id };
    emit();
    if (existing.payload.deviceSms !== false) smsAfterPress(handle).catch(() => {});
    return { handle, queued: true, storage: Boolean(existing.id), reused: true };
  }
  return createSos(args);
});

async function createSos({ source = 'manual', reason = 'Manual SOS', journeyId, location } = {}) {
  const createdAt = Date.now();
  const key = newIdempotencyKey();
  const known = latestLocation(location);
  const payload = { source, reason, journeyId: journeyId || undefined, location: known || undefined, deviceSms: true, holdUntil: createdAt + outboxCfg.smsHoldMs };

  // 1) the outbox, before anything else (and before waiting for GPS)
  creatingKeys.add(key);
  try {
    const enq = await outboxStore.enqueue({ type: 'sos', payload, idempotencyKey: key, createdAt });
    let handle;
    if (enq.ok) handle = { key, id: enq.row.id };
    else {
      handle = { key, id: null, volatile: true };
      volatile.set(key, { id: null, idempotencyKey: key, type: 'sos', status: 'pending', createdAt, payload, lastError: 'Could not be stored on this phone' });
    }
    emit();
    await outboxRunner.refresh();

    // 2) a better position, if the one held is old or of unknown age (a few seconds at most)
    if (!known || !known.timestamp || createdAt - Date.parse(known.timestamp) > 120000) {
      const fresh = await bestLocation();
      if (fresh) await patch(handle, { location: fresh });
    }

    // 3) text the contacts from this phone, with or without internet
    await withTimeout(smsAfterPress(handle).catch(() => null), outboxCfg.smsFirstWaitMs);

    // 4) upload (a text still in flight carries on; the outbox uploads the report with what it has)
    if (!connectivityStore.getState().isOffline && enq.ok) {
      await patch(handle, { holdUntil: null });
      await withTimeout(outboxRunner.drain({ onlyTypes: HOLD_TYPES }), outboxCfg.sosImmediateTimeoutMs);
      const after = await waitSettled(handle, 3000); // another drain may have the request in flight
      if (after && after.status === 'sent') {
        const mode = after.payload.delivery && after.payload.delivery.contactsSms;
        if (mode === 'twilio') await patch(handle, { deviceSms: false }); // the server texts whoever the phone could not
        emit();
        return { handle, queued: false, storage: enq.ok };
      }
    }
    // not delivered (offline, slow or failing server): the outbox uploads it later
    outboxRunner.kick(500);
    emit();
    return { handle, queued: true, storage: enq.ok };
  } finally {
    creatingKeys.delete(key);
  }
}

// ── cancel ───────────────────────────────────────────────────────────────────────────────────────
/**
 * Cancel an SOS. Depending on how far it got (see outboxLogic.planCancel):
 *   not sent yet  -> removed from the queue, nothing ever reaches the server
 *   in flight     -> flagged; cancelled on the server the moment it lands
 *   delivered     -> cancelled on the server (queued if offline)
 * @returns {Promise<{action:string, offerSafeSms:boolean, textedPhones:string[], triggeredAt:number}>}
 */
export async function cancelSos(handle) {
  const row = await read(handle);
  if (!row) return { action: 'none', offerSafeSms: false, textedPhones: [], triggeredAt: Date.now() };
  const action = planCancel(row);
  const sms = row.payload.sms || {};
  const texted = sms.outcome === 'sent' || sms.outcome === 'partial' ? sms.sentTo || [] : [];
  // After a composer was opened we cannot know who was texted: the follow-up goes to everyone it was opened for.
  const maybe = sms.outcome === 'composer_opened' ? (await contactsCache.get() || { contacts: [] }).contacts.map((c) => c.phone) : [];
  const phones = [...new Set([...texted, ...maybe])];

  if (action === 'remove') {
    if (handle.volatile) volatile.delete(handle.key);
    else await outboxStore.discard(row.id);
  } else if (action === 'flag') {
    await patch(handle, { cancelRequested: true });
  } else if (action === 'cancel_server') {
    await outbox.sendOrQueue({
      type: 'sos_cancel',
      payload: { sosId: row.payload.serverId, reason: 'Cancelled by user' },
      send: (k) => apiClient.post(`/sos/${row.payload.serverId}/cancel`, { reason: 'Cancelled by user' }, { headers: { 'Idempotency-Key': k } }),
    });
    await patch(handle, { cancelled: true });
  }
  lastCancelled = { handle, snapshot: row, phones, triggeredAt: row.createdAt };
  await outboxRunner.refresh();
  emit();
  return { action, offerSafeSms: phones.length > 0, textedPhones: phones, triggeredAt: row.createdAt };
}

/** The "I'm safe" follow-up text to the contacts that got the SOS text (or had the composer opened for them). */
export async function sendSafeFollowUp({ phones, triggeredAt }) {
  const ctx = await smsContext();
  const env = await smsEnvironment();
  const targets = ctx.contacts.filter((c) => phones.some((p) => p === c.phone)).map((c) => c.phone);
  const list = targets.length ? targets : phones;
  const msg = buildSafeSms({ name: ctx.name, triggeredAt });
  const plan = planSms({ ...env, contactCount: list.length });
  let next;
  if (plan.strategy === 'direct') next = reduceDirect(null, await sendDirect(list, msg.text), Date.now());
  else if (plan.strategy === 'composer') next = reduceComposer(null, await openComposerSafe(list, msg.text), list, Date.now(), plan.reason);
  else next = reduceNone(null, plan.reason, Date.now(), list.length);
  return next;
}

// ── test message to the user's own number ────────────────────────────────────────────────────────
/** "Test SMS to myself": goes ONLY to the number on the user's own profile. */
export async function sendTestSmsToSelf() {
  const profile = (await profileService.getCachedSosProfile()) || {};
  if (!profile.phone) return { ok: false, outcome: 'no_number', message: 'Add your own phone number in your profile first.' };
  const env = await smsEnvironment();
  const loc = locationBus.getLast();
  const built = buildSosSms({ name: profile.name, lat: loc && loc.latitude, lng: loc && loc.longitude, accuracy: loc && loc.accuracy, triggeredAt: Date.now(), customText: profile.customSosMessage, maxSegments: smsCfg.maxSegments });
  const text = `TEST - ${built.text}`;
  const plan = planSms({ ...env, contactCount: 1 });
  let state;
  if (plan.strategy === 'direct') state = reduceDirect(null, await sendDirect([profile.phone], text), Date.now());
  else if (plan.strategy === 'composer') state = reduceComposer(null, await openComposerSafe([profile.phone], text), [profile.phone], Date.now(), plan.reason);
  else state = reduceNone(null, plan.reason, Date.now(), 1);
  return { ok: state.outcome === 'sent', outcome: state.outcome, via: state.via, reason: state.reason, segments: built.segments, cut: built.cut };
}

/** What the SOS text would say right now (Settings preview). */
export async function previewSosSms() {
  const ctx = await smsContext();
  const loc = locationBus.getLast();
  const built = buildSosSms({ name: ctx.name, lat: loc ? loc.latitude : 19.07612, lng: loc ? loc.longitude : 72.87771, accuracy: loc ? loc.accuracy : 12, triggeredAt: Date.now(), customText: ctx.customText, maxSegments: smsCfg.maxSegments });
  return { ...built, contactCount: ctx.contacts.length, usingExampleLocation: !loc };
}

// ── live SOS rows for the UI ─────────────────────────────────────────────────────────────────────
export async function getSosRows() {
  let rows = [];
  try {
    rows = await outboxStore.list({ types: ['sos'], limit: 20 });
  } catch (e) {
    /* storage unavailable */
  }
  return [...rows, ...volatile.values()].filter((r) => !(r.payload && r.payload.cancelled)).sort((a, b) => b.createdAt - a.createdAt);
}
/** User pressed "Resend text": tries again, even after a composer was opened or permission was missing. */
export const resendSms = (handle) => attemptSms(handle, { force: true });

export const getLastCancelled = () => lastCancelled;
export const clearLastCancelled = () => { lastCancelled = null; emit(); };

export const sosDispatcher = {
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /** Once at startup: server-delivery hook + the SMS retry timer. */
  start() {
    if (started) return;
    started = true;
    outboxRunner.onSent(async (row, p) => {
      if (row.type !== 'sos') return;
      const handle = { key: row.idempotencyKey, id: row.id };
      const mode = p && p.delivery && p.delivery.contactsSms;
      if (mode === 'twilio') await patch(handle, { deviceSms: false });
      else if (row.payload.deviceSms !== false && !creatingKeys.has(row.idempotencyKey)) await attemptSms(handle, { background: true }); // a late upload: the server will not text, the phone does
      emit();
    });
    retryTimer = setInterval(async () => {
      try {
        const rows = await getSosRows();
        for (const row of rows) {
          if (creatingKeys.has(row.idempotencyKey)) continue;
          if (row.payload.deviceSms === false || row.payload.cancelled || row.payload.cancelRequested) continue;
          if (shouldRetrySms(row.payload.sms, { now: Date.now(), triggeredAt: row.createdAt, cfg: smsCfg })) attemptSms({ key: row.idempotencyKey, id: row.id, volatile: !row.id }, { background: true });
        }
      } catch (e) {
        /* storage unavailable */
      }
    }, 10000);
  },

  stop() {
    started = false;
    clearInterval(retryTimer);
  },
};
