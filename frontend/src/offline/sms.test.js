const test = require('node:test');
const assert = require('node:assert/strict');
const sms = require('./smsLogic');
const { buildSosSms, buildSafeSms, measure, formatIst } = require('./sosMessage');
const { createPressDetector } = require('./pressDetector');
const { uuidv4 } = require('./uuid');
const { sms: smsCfg, hardware } = require('./offlineConfig');

const PHONES = ['+919800000001', '+919800000002', '+919800000003'];
const TRIGGERED = Date.parse('2026-10-06T16:05:00Z'); // 21:35 IST

// ── which route is tried ─────────────────────────────────────────────────────────────────────────
test('plan: Android with permission and the native module sends silently', () => {
  assert.deepEqual(sms.planSms({ platform: 'android', permission: 'granted', directAvailable: true, composerAvailable: true, contactCount: 3 }), { strategy: 'direct', reason: null });
});

test('plan: Android without permission falls back to the composer (and remembers why)', () => {
  const p = sms.planSms({ platform: 'android', permission: 'denied', directAvailable: true, composerAvailable: true, contactCount: 3 });
  assert.deepEqual(p, { strategy: 'composer', reason: 'no_permission' });
  assert.equal(sms.planSms({ platform: 'android', permission: 'undetermined', directAvailable: true, composerAvailable: true, contactCount: 1 }).strategy, 'composer');
});

test('plan: iOS can only use the composer; no contacts or no SMS service at all means nothing can be tried', () => {
  assert.deepEqual(sms.planSms({ platform: 'ios', permission: 'unavailable', directAvailable: false, composerAvailable: true, contactCount: 2 }), { strategy: 'composer', reason: 'ios_composer_only' });
  assert.equal(sms.planSms({ platform: 'ios', permission: 'unavailable', directAvailable: false, composerAvailable: true, contactCount: 0 }).reason, 'no_contacts');
  assert.deepEqual(sms.planSms({ platform: 'ios', permission: 'unavailable', directAvailable: false, composerAvailable: false, contactCount: 2 }), { strategy: 'none', reason: 'unavailable' });
  assert.equal(sms.planSms({ platform: 'android', permission: 'denied', directAvailable: true, composerAvailable: false, contactCount: 2 }).reason, 'no_permission');
});

// ── the four outcomes ────────────────────────────────────────────────────────────────────────────
test('outcome SENT: every contact confirmed by the radio', () => {
  const s = sms.reduceDirect(null, PHONES.map((phone) => ({ phone, ok: true })), 1000);
  assert.equal(s.outcome, 'sent');
  assert.deepEqual(s.sentTo, PHONES);
  assert.equal(sms.smsSummary(s), 'SMS sent to 3 of 3 contacts');
});

test('outcome PARTIAL then SENT: "sent to 2 of 3", and the retry only needs the failed contact', () => {
  const first = sms.reduceDirect(null, [{ phone: PHONES[0], ok: true }, { phone: PHONES[1], ok: true }, { phone: PHONES[2], ok: false, error: 'no service' }], 1000);
  assert.equal(first.outcome, 'partial');
  assert.equal(sms.smsSummary(first), 'SMS sent to 2 of 3 contacts (the rest failed)');
  assert.deepEqual(sms.contactsToRetry(first, PHONES.map((phone) => ({ phone }))).map((c) => c.phone), [PHONES[2]]);

  const retry = sms.reduceDirect(first, [{ phone: PHONES[2], ok: true }], 2000);
  assert.equal(retry.outcome, 'sent');
  assert.equal(retry.sentTo.length, 3);
  assert.equal(retry.attempts, 2);
});

test('outcome COMPOSER_OPENED: Android cannot tell whether Send was pressed, so it is NOT counted as sent', () => {
  const s = sms.reduceComposer(null, 'unknown', PHONES, 1000, 'no_permission');
  assert.equal(s.outcome, 'composer_opened');
  assert.deepEqual(s.sentTo, []); // nobody is claimed as texted
  assert.match(sms.smsSummary(s), /tap Send/i);
});

test('iOS composer: only a reported "sent" counts as sent; "cancelled" is a failure', () => {
  const sent = sms.reduceComposer(null, 'sent', PHONES, 1000, 'ios_composer_only');
  assert.equal(sent.outcome, 'sent');
  assert.deepEqual(sent.sentTo, PHONES);
  const cancelled = sms.reduceComposer(null, 'cancelled', PHONES, 1000, 'ios_composer_only');
  assert.equal(cancelled.outcome, 'failed');
  assert.deepEqual(cancelled.sentTo, []);
});

test('outcome FAILED: nothing sent (no signal or no service)', () => {
  const s = sms.reduceDirect(null, PHONES.map((phone) => ({ phone, ok: false, error: 'no service' })), 1000);
  assert.equal(s.outcome, 'failed');
  assert.equal(s.sentTo.length, 0);
  assert.equal(s.reason, 'no service');
});

test('outcome NO_PERMISSION: permission denied and the composer closed or unavailable', () => {
  assert.equal(sms.reduceComposer(null, 'cancelled', PHONES, 1000, 'no_permission').outcome, 'no_permission');
  assert.equal(sms.reduceNone(null, 'no_permission', 1000, 3).outcome, 'no_permission');
  assert.equal(sms.reduceNone(null, 'no_contacts', 1000, 0).outcome, 'no_contacts');
  assert.equal(sms.reduceNone(null, 'unavailable', 1000, 3).outcome, 'failed');
});

// ── retry window ─────────────────────────────────────────────────────────────────────────────────
test('retry: a failed send is retried every retryEveryMs inside the window, then stops', () => {
  const failed = sms.reduceDirect(null, [{ phone: PHONES[0], ok: false }], TRIGGERED + 1000);
  const ctx = (now) => ({ now, triggeredAt: TRIGGERED, cfg: smsCfg });
  assert.equal(sms.shouldRetrySms(failed, ctx(TRIGGERED + 1000 + smsCfg.retryEveryMs - 1)), false); // too soon
  assert.equal(sms.shouldRetrySms(failed, ctx(TRIGGERED + 1000 + smsCfg.retryEveryMs)), true);
  assert.equal(sms.shouldRetrySms(failed, ctx(TRIGGERED + smsCfg.retryWindowMs + 1)), false); // window over
});

test('retry: sent, composer_opened and no_permission are never retried by a timer', () => {
  const ctx = { now: TRIGGERED + 60000, triggeredAt: TRIGGERED, cfg: smsCfg };
  assert.equal(sms.shouldRetrySms(sms.reduceDirect(null, [{ phone: PHONES[0], ok: true }], 1000), ctx), false);
  assert.equal(sms.shouldRetrySms(sms.reduceComposer(null, 'unknown', PHONES, 1000, null), ctx), false);
  assert.equal(sms.shouldRetrySms(sms.reduceNone(null, 'no_permission', 1000, 3), ctx), false);
});

test('retry: an SOS saved but never texted (app killed) is attempted, inside the window only', () => {
  assert.equal(sms.shouldRetrySms(null, { now: TRIGGERED + 60000, triggeredAt: TRIGGERED, cfg: smsCfg }), true);
  assert.equal(sms.shouldRetrySms(null, { now: TRIGGERED + smsCfg.retryWindowMs + 1, triggeredAt: TRIGGERED, cfg: smsCfg }), false);
});

test('retry: the gap doubles with each try and stops growing at the cap', () => {
  const at = (attempts, wait) => sms.shouldRetrySms({ outcome: 'failed', via: 'direct', attempts, lastAttemptAt: TRIGGERED }, { now: TRIGGERED + wait, triggeredAt: TRIGGERED, cfg: smsCfg });
  assert.equal(at(1, smsCfg.retryEveryMs), true);
  assert.equal(at(2, smsCfg.retryEveryMs), false);
  assert.equal(at(2, smsCfg.retryEveryMs * 2), true);
  assert.equal(at(20, smsCfg.retryMaxEveryMs - 1), false);
  assert.equal(at(20, smsCfg.retryMaxEveryMs), true);
});

// ── several contacts ─────────────────────────────────────────────────────────────────────────────
test('numbers: formatting is removed for the radio, a number with nothing dialable is empty', () => {
  assert.equal(sms.normalizePhone('+91 98000-00001'), '+919800000001');
  assert.equal(sms.normalizePhone('(022) 2345 6789'), '02223456789');
  assert.equal(sms.normalizePhone('call me'), '');
  assert.equal(sms.normalizePhone(null), '');
});

test('contacts: one text per number however it was typed, and the stored phone is kept', () => {
  const list = sms.uniqueContacts([{ phone: '+91 98000 00001' }, { phone: '+919800000001' }, { phone: '98000-00002' }, { phone: 'n/a' }]);
  assert.deepEqual(list.map((c) => c.phone), ['+91 98000 00001', '98000-00002']);
});

test('sending: one failed contact does not stop the others, and each result is reported as it happens', async () => {
  const called = [];
  const seen = [];
  const results = await sms.sendToEach(PHONES, async (phone) => {
    called.push(phone);
    return { phone, ok: phone !== PHONES[1], error: phone === PHONES[1] ? 'generic_failure' : undefined };
  }, (soFar) => seen.push(soFar.length));
  assert.deepEqual(called, PHONES);
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(sms.reduceDirect(null, results, 1).outcome, 'partial');
});

test('sending: no SIM or no signal stops calling the radio, and everyone is reported as not sent', async () => {
  for (const error of ['no_sim', 'no_service', 'radio_off', 'timeout']) {
    const called = [];
    const results = await sms.sendToEach(PHONES, async (phone) => {
      called.push(phone);
      return { phone, ok: false, error };
    });
    assert.equal(called.length, 1);
    assert.deepEqual(results.map((r) => [r.phone, r.ok, r.error]), PHONES.map((p) => [p, false, error]));
    assert.equal(sms.reduceDirect(null, results, 1).outcome, 'failed');
  }
});

test('sending: a native exception counts as failed, never as sent', async () => {
  const results = await sms.sendToEach([PHONES[0]], async () => {
    throw new Error('boom');
  });
  assert.deepEqual(results, [{ phone: PHONES[0], ok: false, error: 'boom' }]);
});

test('a report saved half way says partial, so a kill at that point still texts only the rest', () => {
  const half = sms.reduceDirect(sms.emptySms(3), [{ phone: PHONES[0], ok: true }], 1);
  assert.equal(half.outcome, 'partial');
  assert.deepEqual(sms.contactsToRetry(half, PHONES.map((phone) => ({ phone }))).map((c) => c.phone), [PHONES[1], PHONES[2]]);
});

test('reasons are in plain words', () => {
  assert.match(sms.smsSummary(sms.reduceDirect(null, [{ phone: PHONES[0], ok: false, error: 'no_sim' }], 1)), /no SIM card/);
  assert.match(sms.smsSummary(sms.reduceDirect(null, [{ phone: PHONES[0], ok: false, error: 'radio_off' }], 1)), /airplane mode/);
});

// ── pressing SOS more than once ──────────────────────────────────────────────────────────────────
test('double press: a second call while the first runs gets the same promise, and fn runs once', async () => {
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const trigger = sms.singleFlight(async () => {
    runs += 1;
    await gate;
    return runs;
  });
  const a = trigger();
  const b = trigger();
  assert.equal(a, b);
  release();
  assert.equal(await a, 1);
  assert.equal(runs, 1);
  assert.equal(await trigger(), 2); // free again once finished
});

test('double press: a failed run does not leave the guard stuck', async () => {
  let runs = 0;
  const trigger = sms.singleFlight(async () => {
    runs += 1;
    if (runs === 1) throw new Error('storage');
    return 'ok';
  });
  await assert.rejects(trigger());
  assert.equal(await trigger(), 'ok');
});

test('a later press joins a recent SOS, delivered or not; cancelled, old and refused-untexted ones do not count', () => {
  const now = TRIGGERED;
  const row = (status, payload = {}, age = 1000) => ({ status, payload, createdAt: now - age });
  for (const s of ['pending', 'sending', 'failed', 'sent']) assert.ok(sms.findReusableSos([row(s)], now), s);
  assert.equal(sms.findReusableSos([row('sent', { cancelled: true })], now), null);
  assert.equal(sms.findReusableSos([row('pending', { cancelRequested: true })], now), null);
  assert.equal(sms.findReusableSos([row('sent', {}, 10 * 60 * 1000)], now), null);
  assert.equal(sms.findReusableSos([row('dead')], now), null);
  assert.ok(sms.findReusableSos([row('dead', { sms: { sentTo: [PHONES[0]] } })], now));
});

// ── what the screen may claim ────────────────────────────────────────────────────────────────────
const sosRow = (status, payload = {}) => ({ type: 'sos', status, payload, lastError: null });

test('UI: three separate facts: queued on the phone, SMS sent, delivered to the server', () => {
  const v = sms && require('./smsLogic').sosView(sosRow('pending', { sms: sms.reduceDirect(null, [{ phone: PHONES[0], ok: true }, { phone: PHONES[1], ok: false }], 1) }));
  assert.deepEqual(v.chips.map((c) => [c.key, c.on]), [['queued', true], ['sms', true], ['server', false]]);
  assert.match(v.headline, /SMS sent to 1 of 2/);
  assert.match(v.headline, /Not delivered to the server yet/);
});

test('UI: never says "sent" when only the local queue succeeded', () => {
  const v = sms.sosView(sosRow('pending', { sms: sms.reduceDirect(null, [{ phone: PHONES[0], ok: false }], 1) }));
  assert.match(v.headline, /saved on this phone/i);
  assert.match(v.headline, /Nobody has been alerted/i);
  assert.equal(v.tone, 'error');
  assert.ok(!/delivered|sent to/i.test(v.headline));
  assert.equal(v.pendingNoSignal, true);
  const none = sms.sosView(sosRow('pending', {}));
  assert.match(none.headline, /Nobody has been alerted/i);
});

test('UI: an opened composer is described as "tap Send", not as sent', () => {
  const v = sms.sosView(sosRow('pending', { sms: sms.reduceComposer(null, 'unknown', PHONES, 1, null) }));
  assert.match(v.headline, /tap Send/i);
  assert.equal(v.chips.find((c) => c.key === 'sms').on, false);
});

test('UI: delivered to the server, rejected by the server, and cancelled', () => {
  const ok = sms.sosView(sosRow('sent', { serverId: 'abc' }));
  assert.equal(ok.headline, 'SOS delivered to the server');
  assert.equal(ok.pendingNoSignal, false);
  assert.equal(ok.chips.find((c) => c.key === 'server').on, true);
  const dead = sms.sosView({ ...sosRow('dead'), lastError: 'No emergency contacts found' });
  assert.match(dead.headline, /rejected/i);
  assert.equal(dead.pendingNoSignal, false);
  assert.equal(sms.sosView(sosRow('sent', { cancelled: true })).headline, 'SOS cancelled');
});

// ── the message itself ───────────────────────────────────────────────────────────────────────────
test('SOS text has name, map link, accuracy, IST time and the custom text', () => {
  const m = buildSosSms({ name: 'Asha Rao', lat: 19.07612, lng: 72.87771, accuracy: 12.4, triggeredAt: TRIGGERED, customText: 'I have asthma.' });
  assert.equal(m.text, 'SafeTours SOS: Asha Rao needs help. Loc: https://maps.google.com/?q=19.07612,72.87771 (+/-12m) 06 Oct 21:35 IST. I have asthma.');
  assert.equal(m.encoding, 'GSM-7');
  assert.equal(m.segments, 1);
  assert.deepEqual(m.cut, []);
});

test('an old GPS fix is labelled with its own time; a recent one is not', () => {
  const base = { name: 'Asha', lat: 19.07612, lng: 72.87771, triggeredAt: TRIGGERED };
  const old = buildSosSms({ ...base, fixAt: TRIGGERED - 25 * 60 * 1000 });
  assert.equal(old.text, 'SafeTours SOS: Asha needs help. Loc: https://maps.google.com/?q=19.07612,72.87771, last seen 06 Oct 21:10 IST. 06 Oct 21:35 IST.');
  const recent = buildSosSms({ ...base, fixAt: new Date(TRIGGERED - 60000).toISOString() });
  assert.ok(!recent.text.includes('last seen'));
  assert.ok(!buildSosSms(base).text.includes('last seen')); // age unknown: nothing is claimed
});

test('a long custom text is shortened to stay within two segments, and the cut is reported', () => {
  const long = 'I am travelling alone and I have a heart condition. My medicine is in the red bag. Please call my brother first. '.repeat(3);
  const m = buildSosSms({ name: 'Asha Rao', lat: 19.07612, lng: 72.87771, accuracy: 12, triggeredAt: TRIGGERED, customText: long });
  assert.ok(m.segments <= 2);
  assert.ok(m.text.includes('https://maps.google.com/?q=19.07612,72.87771')); // the location is never the thing that gets cut
  assert.ok(m.cut.some((c) => /custom text shortened/.test(c)));
  assert.ok(m.text.endsWith('...'));
});

test('non-GSM characters (Hindi name) switch the whole message to UCS-2 and the cuts follow', () => {
  const m = buildSosSms({ name: 'आशा राव', lat: 19.07612, lng: 72.87771, accuracy: 12, triggeredAt: TRIGGERED, customText: 'मुझे मदद चाहिए। कृपया जल्दी आइए। मेरे भाई को फोन करें।' });
  assert.equal(m.encoding, 'UCS-2');
  assert.ok(m.segments <= 2);
  assert.ok(m.units <= 134);
  assert.ok(m.cut.length > 0);
  assert.ok(m.text.includes('maps.google.com'));
});

test('without a GPS fix the message says so instead of inventing a place', () => {
  const m = buildSosSms({ name: 'Asha', triggeredAt: TRIGGERED });
  assert.ok(m.text.includes('Location unavailable.'));
  assert.ok(!m.text.includes('maps.google.com'));
});

test('segment arithmetic: GSM-7 160/153, UCS-2 70/67, extension characters count double', () => {
  assert.deepEqual([measure('a'.repeat(160)).segments, measure('a'.repeat(161)).segments, measure('a'.repeat(306)).segments, measure('a'.repeat(307)).segments], [1, 2, 2, 3]);
  assert.equal(measure('€'.repeat(80)).segments, 1); // 160 septets
  assert.equal(measure('€'.repeat(81)).segments, 2); // 162 septets
  assert.deepEqual([measure('आ'.repeat(70)).segments, measure('आ'.repeat(71)).segments, measure('आ'.repeat(134)).segments, measure('आ'.repeat(135)).segments], [1, 2, 2, 3]);
  assert.equal(measure('aआ').encoding, 'UCS-2');
});

test('IST formatting is fixed UTC+5:30', () => {
  assert.equal(formatIst(TRIGGERED), '06 Oct 21:35 IST');
  assert.equal(formatIst(Date.parse('2026-12-31T19:00:00Z')), '01 Jan 00:30 IST');
});

test('the "I am safe" follow-up names the original alert time', () => {
  const m = buildSafeSms({ name: 'Asha', triggeredAt: TRIGGERED });
  assert.equal(m.text, 'SafeTours: Asha is safe. Please ignore the SOS alert sent at 06 Oct 21:35 IST.');
  assert.equal(m.segments, 1);
});

// ── hardware trigger and uuid ────────────────────────────────────────────────────────────────────
test('triple press: fires on the 3rd press inside 2 s, not on slow presses, not twice', () => {
  const d = createPressDetector(hardware);
  assert.equal(d.press(0), false);
  assert.equal(d.press(500), false);
  assert.equal(d.press(1000), true);
  assert.equal(d.press(1200), false); // cooldown
  assert.equal(d.press(1400), false);
  assert.equal(d.press(1600), false);

  const slow = createPressDetector(hardware);
  assert.equal(slow.press(0), false);
  assert.equal(slow.press(1500), false);
  assert.equal(slow.press(3100), false); // the first press is outside the 2 s window by now
  assert.equal(slow.press(3500), true); // 1500, 3100, 3500 are inside 2 s
});

test('triple press can fire again after the cooldown', () => {
  const d = createPressDetector(hardware);
  [0, 100, 200].forEach((t) => d.press(t));
  assert.equal(d.press(hardware.cooldownMs + 1000), false);
  assert.equal(d.press(hardware.cooldownMs + 1100), false);
  assert.equal(d.press(hardware.cooldownMs + 1200), true);
});

test('uuidv4 is well formed and unique', () => {
  const a = uuidv4();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const set = new Set(Array.from({ length: 2000 }, () => uuidv4()));
  assert.equal(set.size, 2000);
});
