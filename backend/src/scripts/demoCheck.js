/**
 * demoCheck.js: "is this ready to demo?" Read-only. Prints a PASS / WARN / FAIL table and one verdict.
 *
 *   npm run demo:check
 *
 * What it does (and does not do)
 *   - reads environment variable NAMES only; values are never printed (except the two non-secret switches
 *     USE_DEMO_CRIME_DATA and GEMINI_MODEL)
 *   - reads MongoDB: counts, feed heartbeats, index lists, and evaluates three sample cells. It never writes.
 *     (autoIndex is switched off, so merely loading the models builds nothing)
 *   - makes two small outbound calls: one tiny Gemini request, and one cold nearby lookup straight to the place
 *     provider (it bypasses the app's cache, so nothing is cached or stored)
 *   Exit code: 0 for READY / READY WITH DEMO DATA, 1 for NOT READY.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
require('../config/envAliases');
const mongoose = require('mongoose');

mongoose.set('autoIndex', false); // must be set before the models are loaded

const riskCfg = require('../config/risk.config');
const nearbyCfg = require('../config/nearby.config');
const assistantCfg = require('../config/assistant.config');

// Three fixed test points in Mumbai: south, west suburbs, north-west suburbs.
const TEST_POINTS = [
  { name: 'Colaba (south Mumbai)', lat: 18.922, lng: 72.8347 },
  { name: 'Bandra (west suburbs)', lat: 19.0596, lng: 72.8295 },
  { name: 'Andheri (north-west suburbs)', lat: 19.1136, lng: 72.8697 },
];
const NEARBY_POINT = TEST_POINTS[0];

const rows = [];
const add = (section, item, status, detail) => rows.push({ section, item, status, detail });
const has = (name) => Boolean(process.env[name] && String(process.env[name]).trim());
const mins = (ms) => Math.round(ms / 60000);
const fmtAge = (m) => (m < 120 ? `${m} min` : m < 3000 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`);

// ── 1. environment ────────────────────────────────────────────────────────────────────────────────
function checkEnv() {
  for (const name of ['MONGO_URI', 'ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET']) {
    add('env', name, has(name) ? 'PASS' : 'FAIL', has(name) ? 'set' : 'MISSING (required)');
  }
  const optional = [
    ['OPENWEATHER_API_KEY', 'weather component will be unavailable'],
    ['GEOAPIFY_API_KEY', 'nearby uses the keyless Overpass fallback; crowd component unavailable'],
    ['NEWSDATA_API_KEY', 'optional: news still comes from the publishers\' RSS feeds'],
    ['GEMINI_API_KEY', 'assistant answers with the rule-based "offline assistant"'],
    ['GEMINI_MODEL', `assistant uses the built-in default (${assistantCfg.gemini.model}); set it explicitly`],
  ];
  for (const [name, impact] of optional) add('env', name, has(name) ? 'PASS' : 'WARN', has(name) ? 'set' : `not set: ${impact}`);

  const twilio = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'].filter(has).length;
  add('env', 'TWILIO_* (3 names)', twilio === 3 ? 'PASS' : twilio === 0 ? 'WARN' : 'FAIL',
    twilio === 3 ? 'all set: the server texts contacts' : twilio === 0 ? 'none set: contacts are texted by the phone only' : `only ${twilio} of 3 set: server SMS will not work`);
  add('env', 'EXPO_ACCESS_TOKEN', has('EXPO_ACCESS_TOKEN') ? 'PASS' : 'PASS', has('EXPO_ACCESS_TOKEN') ? 'set' : 'not set (optional)');
  const demo = String(process.env.USE_DEMO_CRIME_DATA || '').toLowerCase() === 'true';
  add('env', 'USE_DEMO_CRIME_DATA', demo ? 'WARN' : 'PASS', demo ? 'true: crime scores are DEMO data' : 'false');
}

// ── 2. database ───────────────────────────────────────────────────────────────────────────────────
async function checkDatabase() {
  const GridCell = require('../models/GridCell');
  const Incident = require('../models/Incident');
  const IncidentConfirmation = require('../models/IncidentConfirmation');

  const flag = (k) => ({ $sum: { $cond: [{ $isNumber: `$components.${k}.score` }, 1, 0] } });
  const [g] = await GridCell.aggregate([
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        crime: flag('crime'),
        crimeDemo: { $sum: { $cond: [{ $and: [{ $isNumber: '$components.crime.score' }, { $eq: ['$components.crime.meta.demo', true] }] }, 1, 0] } },
        weather: flag('weather'),
        crowd: flag('crowd'),
        news: flag('news'),
        communityScored: { $sum: { $cond: [{ $gt: ['$components.community.score', 0] }, 1, 0] } },
      },
    },
  ]);
  const total = g ? g.total : 0;
  add('db', 'GridCell total', total > 0 ? 'PASS' : 'FAIL', total > 0 ? `${total} cells` : 'grid is empty: run the grid generation / migrate scripts');
  if (!total) return { total, crimeReal: 0, crimeDemo: 0 };

  const pct = (n) => `${n} (${Math.round((100 * n) / total)}%)`;
  const crimeReal = g.crime - g.crimeDemo;
  add('db', 'crime: real', crimeReal > 0 ? 'PASS' : 'WARN', `${pct(crimeReal)} cells with real crime scores`);
  add('db', 'crime: demo', g.crimeDemo > 0 ? 'WARN' : 'PASS', `${pct(g.crimeDemo)} cells with DEMO crime scores`);
  if (g.crime === 0) add('db', 'crime: none', 'FAIL', 'no crime scores at all: every area would be low confidence');
  add('db', 'weather', g.weather > 0 ? 'PASS' : 'WARN', `${pct(g.weather)} cells with weather scores`);
  add('db', 'crowd', g.crowd > 0 ? 'PASS' : 'WARN', `${pct(g.crowd)} cells with crowd scores`);
  add('db', 'news', g.news > 0 ? 'PASS' : 'WARN', `${pct(g.news)} cells with a news score (0 is a real value)`);

  const [active, all, confirmations] = await Promise.all([
    Incident.countDocuments({ status: 'ACTIVE', expiresAt: { $gt: new Date() } }),
    Incident.countDocuments({}),
    IncidentConfirmation.countDocuments({}),
  ]);
  add('db', 'community incidents', 'PASS', `${active} active, ${all} total, ${confirmations} confirmations, ${g.communityScored} cells with a score above 0`);
  if (all === 0) add('db', 'community reports', 'WARN', 'no reports yet: file one from two accounts before the demo so the score has something to show');
  return { total, crimeReal, crimeDemo: g.crimeDemo };
}

// ── 3. feeds ──────────────────────────────────────────────────────────────────────────────────────
async function checkFeeds() {
  const FeedStatus = require('../models/FeedStatus');
  const docs = await FeedStatus.find({}).lean();
  const byKey = Object.fromEntries(docs.map((d) => [d.key, d]));
  for (const key of ['weather', 'news', 'crowd', 'community', 'crime']) {
    const f = byKey[key];
    const ttl = riskCfg.components[key] && riskCfg.components[key].ttlMinutes;
    if (!f || !f.updatedAt) {
      add('feeds', key, key === 'crime' ? 'PASS' : 'WARN', `never succeeded${f && f.lastError ? `; last error: ${String(f.lastError).slice(0, 80)}` : ''}`);
      continue;
    }
    const age = mins(Date.now() - new Date(f.updatedAt).getTime());
    const stale = ttl ? age > ttl : false;
    add('feeds', key, stale ? 'WARN' : 'PASS', `last success ${fmtAge(age)} ago${ttl ? ` (fresh within ${fmtAge(ttl)})` : ''}${stale ? ': STALE' : ''}${f.lastError ? `; last error: ${String(f.lastError).slice(0, 60)}` : ''}`);
  }
}

// ── 4. Gemini ─────────────────────────────────────────────────────────────────────────────────────
async function checkGemini() {
  const gemini = require('../services/assistant/gemini');
  const { parseModelOutput } = require('../services/assistant/assistant.service');
  const model = assistantCfg.gemini.model;
  if (!has('GEMINI_API_KEY')) {
    add('gemini', 'test call', 'WARN', `skipped: no key. Model would be ${model}. The assistant will answer from rules`);
    return;
  }
  const started = Date.now();
  try {
    const out = await gemini.generate({
      systemInstruction: { parts: [{ text: 'Reply with one JSON object only.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Return {"reply":"pong","reportProposal":null}' }] }],
    });
    const parsed = parseModelOutput(out.text);
    const ok = typeof parsed.reply === 'string' && parsed.reply.length > 0 && /^\s*\{/.test(out.text.replace(/^```(?:json)?\s*/i, ''));
    add('gemini', `test call (${out.model})`, ok ? 'PASS' : 'WARN', `${out.latencyMs} ms, JSON ${ok ? 'parsed' : 'NOT parsed (the app will still use the text, without report proposals)'}`);
  } catch (e) {
    add('gemini', `test call (${model})`, 'WARN', `failed after ${Date.now() - started} ms: ${e.code || e.message}. The assistant will answer from rules`);
  }
}

// ── 5. nearby ─────────────────────────────────────────────────────────────────────────────────────
async function checkNearby() {
  const providers = require('../services/nearby/providers');
  const core = require('../services/nearby/nearbyCore');
  const cells = core.cellsForRadius(NEARBY_POINT.lat, NEARBY_POINT.lng, 1000);
  const bbox = core.bboxOfCells(cells);
  const center = { lat: NEARBY_POINT.lat, lng: NEARBY_POINT.lng };
  const attempts = [];
  for (const provider of [providers.geoapify, providers.overpass]) {
    if (!provider.available()) {
      attempts.push(`${provider.name}: no key`);
      continue;
    }
    const started = Date.now();
    try {
      const r = await provider.fetch({ bbox, center });
      const byType = {};
      for (const p of r.places) byType[p.type] = (byType[p.type] || 0) + 1;
      add('nearby', `cold call near ${NEARBY_POINT.name}`, r.places.length > 0 ? 'PASS' : 'WARN',
        `source ${provider.name}, ${r.places.length} places (${Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}), ${Date.now() - started} ms${r.credits ? `, ~${r.credits} Geoapify credits` : ''}${attempts.length ? `; before that: ${attempts.join('; ')}` : ''}`);
      return;
    } catch (e) {
      attempts.push(`${provider.name}: ${e.code || e.message}`.slice(0, 90));
    }
  }
  add('nearby', 'cold call', 'WARN', `no provider answered (${attempts.join('; ')}). The app will use cached/seed places or say unavailable`);
  void nearbyCfg;
}

// ── 6. indexes ────────────────────────────────────────────────────────────────────────────────────
async function checkIndexes() {
  const db = mongoose.connection.db;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const wanted = [
    { coll: 'idempotencyrecords', label: 'idempotency unique {user,scope,key}', test: (i) => same(i.key, { user: 1, scope: 1, key: 1 }) && i.unique, required: true },
    { coll: 'idempotencyrecords', label: 'idempotency TTL on createdAt', test: (i) => same(i.key, { createdAt: 1 }) && Number.isFinite(i.expireAfterSeconds), required: false },
    { coll: 'locations', label: 'locations unique {userId,idempotencyKey} (partial)', test: (i) => same(i.key, { userId: 1, idempotencyKey: 1 }) && i.unique, required: true },
    { coll: 'geofenceevents', label: 'geofence events unique {userId,idempotencyKey}', test: (i) => same(i.key, { userId: 1, idempotencyKey: 1 }) && i.unique, required: true },
    { coll: 'soshistories', label: 'SOS unique {user,idempotencyKey} (one SOS per key)', test: (i) => same(i.key, { user: 1, idempotencyKey: 1 }) && i.unique, required: true },
    { coll: 'soshistories', label: 'SOS deadline poller {status,confirmBy}', test: (i) => same(i.key, { status: 1, confirmBy: 1 }), required: false },
    { coll: 'usergeofencestates', label: 'geofence state unique {userId}', test: (i) => same(i.key, { userId: 1 }) && i.unique, required: true },
  ];
  const cache = {};
  for (const w of wanted) {
    if (!cache[w.coll]) {
      try {
        cache[w.coll] = await db.collection(w.coll).indexes();
      } catch (e) {
        cache[w.coll] = null; // collection does not exist yet
      }
    }
    const found = cache[w.coll] && cache[w.coll].some(w.test);
    add('indexes', w.label, found ? 'PASS' : w.required ? 'FAIL' : 'WARN', found ? 'present' : cache[w.coll] ? 'MISSING: run npm run create:indexes -- --apply' : 'collection missing: run npm run create:indexes -- --apply');
  }
}

// ── 7. sample cells ───────────────────────────────────────────────────────────────────────────────
async function checkSamples() {
  const cellRisk = require('../services/risk/cellRisk.service');
  const details = [];
  for (const p of TEST_POINTS) {
    try {
      const v = await cellRisk.getRiskAt(p.lat, p.lng);
      const flags = [
        v.demo ? 'DEMO' : null,
        v.lowConfidence ? 'lowConfidence' : null,
        v.missing && v.missing.length ? `missing: ${v.missing.join(',')}` : null,
        v.stale && v.stale.length ? `stale: ${v.stale.join(',')}` : null,
        !v.insideCoverage ? 'outside grid' : null,
      ].filter(Boolean);
      const status = v.riskLevel === 'UNKNOWN' || !v.insideCoverage ? 'WARN' : 'PASS';
      add('cells', p.name, status, `${v.riskLevel}${v.totalRiskScore !== null ? ` ${v.totalRiskScore}/100` : ''}, confidence ${Math.round((v.dataConfidence || 0) * 100)}%, top ${v.topFactor || '-'}${flags.length ? ` [${flags.join(' | ')}]` : ' [no flags]'}`);
      details.push({ p, v });
    } catch (e) {
      add('cells', p.name, 'FAIL', `evaluation failed: ${e.message}`);
    }
  }
  return details;
}

// ── output ────────────────────────────────────────────────────────────────────────────────────────
function print(details) {
  const mark = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' };
  const w1 = Math.max(...rows.map((r) => r.section.length), 7);
  const w2 = Math.max(...rows.map((r) => r.item.length), 4);
  console.log('');
  console.log(`SafeTours demo check  ${new Date().toISOString()}`);
  console.log('='.repeat(100));
  let last = null;
  for (const r of rows) {
    if (r.section !== last) {
      console.log('');
      last = r.section;
    }
    console.log(`${mark[r.status].padEnd(5)} ${r.section.padEnd(w1)}  ${r.item.padEnd(w2)}  ${r.detail}`);
  }

  if (details && details.length) {
    console.log('\nComponent breakdown at the 3 test points (score / status per component)');
    console.log('-'.repeat(100));
    for (const { p, v } of details) {
      console.log(`${p.name}  cell ${v.h3Index}`);
      for (const k of Object.keys(riskCfg.components)) {
        const d = v.componentDetails[k] || {};
        const score = v.breakdown[k];
        const note = [d.status, d.stale ? 'stale' : null, d.demo ? 'DEMO' : null, d.lowConfidence && !d.demo ? 'lowConfidence' : null, d.noReports ? 'no reports' : null, d.reports ? `${d.reports} report(s)` : null, `weight ${d.appliedWeight}`]
          .filter(Boolean)
          .join(', ');
        console.log(`    ${k.padEnd(10)} ${score === null || score === undefined ? '  -  ' : String(score).padStart(5)}   ${note}`);
      }
      console.log(`    time modifier: ${v.modifiers.time ? v.modifiers.time.label : '-'} x${v.modifiers.combinedMultiplier}${v.notes && v.notes.length ? `; note: ${v.notes[0]}` : ''}`);
    }
  }
}

function verdict(db) {
  const fails = rows.filter((r) => r.status === 'FAIL');
  const reasons = [];
  if (fails.length) {
    fails.forEach((f) => reasons.push(`${f.section}/${f.item}: ${f.detail}`));
    return { label: 'NOT READY', reasons };
  }
  const demo = db && db.crimeDemo > 0;
  if (demo) reasons.push(`crime scores are DEMO data in ${db.crimeDemo} cells: say so in the presentation`);
  if (db && db.crimeReal === 0 && !demo) reasons.push('no real or demo crime data');
  rows.filter((r) => r.status === 'WARN').forEach((w) => reasons.push(`${w.section}/${w.item}: ${w.detail}`));
  return { label: demo ? 'READY WITH DEMO DATA' : 'READY', reasons };
}

(async () => {
  let dbInfo = null;
  let details = [];
  checkEnv();

  if (has('MONGO_URI')) {
    try {
      await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
      add('db', 'MongoDB', 'PASS', `reachable (${mongoose.connection.host})`);
      dbInfo = await checkDatabase();
      await checkFeeds();
      await checkIndexes();
      if (dbInfo && dbInfo.total > 0) details = await checkSamples();
    } catch (e) {
      add('db', 'MongoDB', 'FAIL', `not reachable or failed: ${e.message}`);
    }
  } else {
    add('db', 'MongoDB', 'FAIL', 'MONGO_URI is not set');
  }

  await checkGemini();
  await checkNearby();

  print(details);
  const v = verdict(dbInfo);
  console.log('\n' + '='.repeat(100));
  console.log(`VERDICT: ${v.label}`);
  if (v.reasons.length) v.reasons.forEach((r) => console.log(`  - ${r}`));
  else console.log('  - every check passed');
  console.log('');

  await mongoose.disconnect().catch(() => {});
  process.exit(v.label === 'NOT READY' ? 1 : 0);
})().catch((e) => {
  console.error('demo:check crashed:', e.message);
  process.exit(2);
});
