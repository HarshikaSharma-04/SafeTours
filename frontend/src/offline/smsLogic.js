'use strict';

/**
 * SOS text-message state machine (pure). The native layer (services/smsSender.js) does the sending; this module
 * decides what to try, turns raw results into one honest outcome, and says what the UI may claim.
 *
 * Outcomes recorded on the SOS row (payload.sms.outcome):
 *   sent             every contact was texted (direct send confirmed by the radio, or iOS composer reported 'sent')
 *   partial          some contacts were texted, others failed: the rest may be retried
 *   composer_opened  the message composer was opened but nobody can tell whether the user pressed Send
 *                    (Android never reports it): NOT counted as sent
 *   failed           nothing was sent (no signal / no SMS service / user cancelled the composer)
 *   no_permission    Android SEND_SMS was denied AND the composer could not be used either
 *   no_contacts      there is nobody to text
 */
const OUTCOMES = ['sent', 'partial', 'composer_opened', 'failed', 'no_permission', 'no_contacts'];

/**
 * What to try, given what the platform offers right now.
 * @param {{platform:'android'|'ios'|string, permission:'granted'|'denied'|'undetermined'|'unavailable', directAvailable:boolean, composerAvailable:boolean, contactCount:number}} env
 * @returns {{strategy:'direct'|'composer'|'none', reason:string|null}}
 */
function planSms({ platform, permission, directAvailable, composerAvailable, contactCount }) {
  if (!contactCount) return { strategy: 'none', reason: 'no_contacts' };
  if (platform === 'android' && directAvailable && permission === 'granted') return { strategy: 'direct', reason: null };
  if (composerAvailable) {
    // iOS has no silent send at all; on Android we only land here without permission / native module.
    const reason = platform === 'android' ? (permission === 'granted' ? 'direct_unavailable' : 'no_permission') : 'ios_composer_only';
    return { strategy: 'composer', reason };
  }
  return { strategy: 'none', reason: platform === 'android' && permission !== 'granted' ? 'no_permission' : 'unavailable' };
}

const emptySms = (total = 0) => ({ outcome: null, sentTo: [], failedTo: [], total, via: null, reason: null, attempts: 0, lastAttemptAt: null });

/** Aggregates per-contact direct results [{phone, ok}] into the row's sms state. */
function reduceDirect(prev, results, now) {
  const base = prev || emptySms(results.length);
  const sentTo = [...new Set([...(base.sentTo || []), ...results.filter((r) => r.ok).map((r) => r.phone)])];
  const failedTo = results.filter((r) => !r.ok && !sentTo.includes(r.phone)).map((r) => r.phone);
  const total = Math.max(base.total || 0, sentTo.length + failedTo.length);
  const outcome = sentTo.length >= total && total > 0 ? 'sent' : sentTo.length > 0 ? 'partial' : 'failed';
  return {
    ...base,
    outcome,
    sentTo,
    failedTo,
    total,
    via: 'direct',
    reason: outcome === 'sent' ? null : results.find((r) => !r.ok)?.error || 'send failed',
    attempts: (base.attempts || 0) + 1,
    lastAttemptAt: now,
  };
}

/**
 * Turns the composer's raw result into an outcome.
 * @param {'sent'|'cancelled'|'unknown'} raw  expo-sms result
 * @param {string[]} phones everyone in the composer
 * @param {string|null} reasonForComposer why we used the composer (e.g. 'no_permission')
 */
function reduceComposer(prev, raw, phones, now, reasonForComposer) {
  const base = prev || emptySms(phones.length);
  let outcome;
  let sentTo = base.sentTo || [];
  if (raw === 'sent') {
    outcome = 'sent'; // iOS reports it after the user taps Send
    sentTo = [...new Set([...sentTo, ...phones])];
  } else if (raw === 'cancelled') {
    // The user closed the composer. If the only reason we were here is a denied permission, say so.
    outcome = reasonForComposer === 'no_permission' ? 'no_permission' : 'failed';
  } else {
    outcome = 'composer_opened'; // Android: cannot know whether Send was pressed
  }
  return {
    ...base,
    outcome,
    sentTo,
    failedTo: outcome === 'sent' ? [] : phones.filter((p) => !sentTo.includes(p)),
    total: Math.max(base.total || 0, phones.length),
    via: 'composer',
    reason: outcome === 'failed' ? 'composer closed without sending' : outcome === 'no_permission' ? 'SMS permission denied' : reasonForComposer,
    attempts: (base.attempts || 0) + 1,
    lastAttemptAt: now,
  };
}

/** Nothing could be tried at all. */
function reduceNone(prev, reason, now, total = 0) {
  const base = prev || emptySms(total);
  const outcome = reason === 'no_contacts' ? 'no_contacts' : reason === 'no_permission' ? 'no_permission' : 'failed';
  return { ...base, outcome, via: null, reason, attempts: (base.attempts || 0) + 1, lastAttemptAt: now, total: Math.max(base.total || 0, total) };
}

/**
 * Should a send be tried by itself?
 * No attempt recorded yet (the app was killed right after the SOS was saved), and outcomes that mean "the radio
 * could not do it right now" (failed, partial), inside the window after the SOS was triggered. The gap doubles on
 * each try. A denied permission or an opened composer needs the user, not a timer.
 */
function shouldRetrySms(sms, { now, triggeredAt, cfg }) {
  if (now - triggeredAt > cfg.retryWindowMs) return false;
  if (!sms) return true;
  if (!['failed', 'partial'].includes(sms.outcome)) return false;
  if (sms.via === 'composer') return false; // never re-open the composer on a timer
  const gap = Math.min(cfg.retryMaxEveryMs || Infinity, cfg.retryEveryMs * 2 ** Math.max(0, (sms.attempts || 1) - 1));
  return sms.lastAttemptAt === null || now - sms.lastAttemptAt >= gap;
}

/** Contacts still to text on a retry (partial: only the ones that failed; failed: everyone). */
function contactsToRetry(sms, contacts) {
  const done = new Set(sms && sms.sentTo ? sms.sentTo : []);
  return contacts.filter((c) => !done.has(c.phone));
}

/** "+91 98000-00001" -> "+919800000001". '' when nothing dialable is left. */
function normalizePhone(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  return digits.length < 3 ? '' : (s.startsWith('+') ? '+' : '') + digits;
}

/** Contacts with a dialable number, one per number however it was typed. Keeps each contact's stored phone. */
function uniqueContacts(contacts) {
  const seen = new Set();
  return contacts.filter((c) => {
    const n = normalizePhone(c.phone);
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

// These say the phone cannot text anyone right now, so trying the next contact only burns Android's SMS allowance.
const RADIO_FAILURES = ['no_sim', 'radio_off', 'no_service', 'timeout', 'limit_exceeded', 'no_permission', 'security_exception'];

/**
 * Texts one phone at a time. Stops calling the radio after a failure that would hit every contact (the rest are
 * reported with the same error, and are retried later). `onResult` gets the results so far after each contact, so
 * a kill half way cannot make the retry text someone twice.
 * @returns {Promise<Array<{phone:string, ok:boolean, error?:string}>>}
 */
async function sendToEach(phones, sendOne, onResult) {
  const results = [];
  let blocked = null;
  for (const phone of phones) {
    let res;
    if (blocked) res = { phone, ok: false, error: blocked };
    else {
      try {
        res = await sendOne(phone);
      } catch (e) {
        res = { phone, ok: false, error: e.message || 'send failed' };
      }
    }
    results.push(res);
    if (!res.ok && RADIO_FAILURES.includes(res.error)) blocked = res.error;
    if (onResult) await onResult(results);
  }
  return results;
}

/**
 * The SOS a new press should join instead of starting another: recent, not cancelled, and either still on its way
 * or already delivered. A row the server refused is joined only if contacts were already texted from it.
 */
function findReusableSos(rows, now, windowMs = 10 * 60 * 1000) {
  return rows.find((r) => {
    const p = r.payload || {};
    if (p.cancelled || p.cancelRequested || now - r.createdAt >= windowMs) return false;
    if (r.status === 'dead') return Boolean(p.sms && (p.sms.sentTo || []).length);
    return ['pending', 'sending', 'failed', 'sent'].includes(r.status);
  }) || null;
}

/** While a call is running, every other call gets the same promise. The guard is set before anything is awaited. */
function singleFlight(fn) {
  let running = null;
  return (...args) => {
    if (!running) {
      running = Promise.resolve()
        .then(() => fn(...args))
        .finally(() => {
          running = null;
        });
    }
    return running;
  };
}

const REASON_TEXT = {
  no_sim: 'no SIM card',
  radio_off: 'airplane mode or the mobile radio is off',
  no_service: 'no mobile signal',
  timeout: 'the network did not confirm it',
  limit_exceeded: "Android's SMS limit was reached",
  generic_failure: 'the network refused it',
  invalid_number: 'invalid phone number',
};
const reasonText = (reason) => REASON_TEXT[reason] || reason;

/** "SMS sent to 2 of 3 contacts" */
function smsSummary(sms) {
  if (!sms || !sms.outcome) return null;
  const n = (sms.sentTo || []).length;
  const t = sms.total || n;
  switch (sms.outcome) {
    case 'sent': return `SMS sent to ${n} of ${t} contact${t === 1 ? '' : 's'}`;
    case 'partial': return `SMS sent to ${n} of ${t} contacts (the rest failed${REASON_TEXT[sms.reason] ? `: ${REASON_TEXT[sms.reason]}` : ''})`;
    case 'composer_opened': return 'Message opened for you to send: tap Send. We cannot tell whether it was sent';
    case 'no_permission': return 'SMS permission is off, so no text was sent';
    case 'no_contacts': return 'No emergency contacts to text';
    default: return 'No SMS was sent' + (sms.reason ? ` (${reasonText(sms.reason)})` : '');
  }
}

/**
 * What the screen may say about an SOS row. Three separate facts, never merged:
 *   queued   it is stored on this phone
 *   sms      the texts (outcome above)
 *   server   the server has it
 * `headline` never says the SOS was "sent" unless the server or the SMS radio confirmed it.
 *
 * @param {{status:string, lastError?:string, payload:{sms?:Object, serverId?:string, cancelled?:boolean, cancelRequested?:boolean}}} row  an outbox 'sos' row
 */
function sosView(row) {
  const sms = (row.payload && row.payload.sms) || null;
  const delivered = row.status === 'sent';
  const rejected = row.status === 'dead';
  const smsDone = sms && (sms.outcome === 'sent' || sms.outcome === 'partial');
  const smsLine = smsSummary(sms);

  const chips = [
    { key: 'queued', label: 'Queued on this phone', on: !delivered },
    { key: 'sms', label: smsDone ? `SMS sent ${(sms.sentTo || []).length}/${sms.total}` : sms && sms.outcome === 'composer_opened' ? 'SMS: waiting for you to send' : 'SMS not sent', on: Boolean(smsDone) },
    { key: 'server', label: delivered ? 'Delivered to server' : rejected ? 'Server rejected it' : 'Not delivered to server yet', on: delivered },
  ];

  let headline;
  let tone;
  if (row.payload && row.payload.cancelled) {
    headline = 'SOS cancelled';
    tone = 'ok';
  } else if (delivered) {
    headline = 'SOS delivered to the server';
    tone = 'ok';
  } else if (rejected) {
    headline = 'The server rejected this SOS';
    tone = 'error';
  } else if (smsDone) {
    headline = `${smsSummary(sms)}. Not delivered to the server yet`;
    tone = 'warn';
  } else if (sms && sms.outcome === 'composer_opened') {
    headline = 'SOS saved. Your message app is open: tap Send. Not delivered to the server yet';
    tone = 'warn';
  } else {
    headline = 'SOS saved on this phone. Nobody has been alerted yet';
    tone = 'error';
  }

  const detail = [];
  if (smsLine && !smsDone) detail.push(smsLine);
  if (!delivered && !rejected) detail.push('It will be sent to the server automatically when you have signal.');
  if (row.lastError && !delivered) detail.push(`Last error: ${row.lastError}`);

  const pendingNoSignal = !delivered && !rejected && !(row.payload && row.payload.cancelled);
  return { headline, tone, chips, detail, pendingNoSignal };
}

module.exports = { OUTCOMES, planSms, emptySms, reduceDirect, reduceComposer, reduceNone, shouldRetrySms, contactsToRetry, normalizePhone, uniqueContacts, sendToEach, findReusableSos, singleFlight, smsSummary, sosView };
