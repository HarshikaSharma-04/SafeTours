const test = require('node:test');
const assert = require('node:assert/strict');
const h3 = require('h3-js');
const scoring = require('./communityScoring');
const cfg = require('../../config/communityConfig');

const NOW = new Date('2026-10-10T06:30:00Z');
const cell = h3.latLngToCell(19.076, 72.8777, 9);
const ring1 = h3.gridDisk(cell, 1).filter((c) => c !== cell);
const ring2 = h3.gridDisk(cell, 2).filter((c) => !h3.gridDisk(cell, 1).includes(c));
const far = h3.gridDisk(cell, 4).filter((c) => !h3.gridDisk(cell, 3).includes(c))[0];

const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000);
const inc = (o = {}) => ({
  userId: 'u1',
  incidentType: 'Harassment', // severity 25, 12 h
  h3CellId: cell,
  createdAt: hoursAgo(1),
  expiresAt: new Date(NOW.getTime() + 11 * 3600000),
  confirmationCount: 0,
  falseReportCount: 0,
  ...o,
});
const score = (incidents, target = cell, opts) => scoring.scoreCells([target], incidents, NOW, opts)[target];

// ── severity: one config ────────────────────────────────────────────────────────
test('severity comes from the single category config, and its label is derived from the same number', () => {
  assert.equal(cfg.severityLabel(cfg.incidentCategories.Harassment.severity), 'HIGH');
  assert.equal(cfg.severityLabel(cfg.incidentCategories.Fire.severity), 'CRITICAL');
  assert.equal(cfg.severityLabel(cfg.incidentCategories['Street Light Failure'].severity), 'LOW');
  for (const c of Object.values(cfg.incidentCategories)) {
    assert.deepEqual(Object.keys(c).sort(), ['expiryHours', 'severity']); // no second weight/severity field
  }
  const assault = score([inc({ incidentType: 'Assault' })]);
  const light = score([inc({ incidentType: 'Street Light Failure' })]);
  assert.ok(assault > light);
});

// ── time decay ─────────────────────────────────────────────────────────────────
test('decay: weight falls linearly from creation to expiry and is zero afterwards', () => {
  const w = (hAgo, left) => scoring.incidentWeight(inc({ createdAt: hoursAgo(hAgo), expiresAt: new Date(NOW.getTime() + left * 3600000) }), NOW);
  assert.ok(Math.abs(w(0, 12) - 25 * 0.5) < 1e-9); // brand new, unconfirmed: severity x 0.5 verification
  assert.ok(Math.abs(w(6, 6) - 25 * 0.5 * 0.5) < 1e-9); // half life
  assert.equal(w(13, -1), 0);
  assert.equal(score([inc({ expiresAt: new Date(NOW.getTime() - 1000) })]), 0);
});

test('each category uses its own TTL: the same age leaves Medical Emergency weaker than Theft', () => {
  const mk = (type) => {
    const hours = cfg.incidentCategories[type].expiryHours;
    return inc({ incidentType: type, createdAt: hoursAgo(3), expiresAt: new Date(hoursAgo(3).getTime() + hours * 3600000) });
  };
  const medicalRemaining = (6 - 3) / 6;
  const theftRemaining = (24 - 3) / 24;
  assert.ok(medicalRemaining < theftRemaining);
  assert.ok(Math.abs(scoring.incidentWeight(mk('Medical Emergency'), NOW) - 15 * 0.5 * medicalRemaining) < 1e-9);
});

// ── votes ──────────────────────────────────────────────────────────────────────
test('votes: confirmations raise the weight up to the full-weight count; false reports lower it', () => {
  const w = (o) => scoring.incidentWeight(inc(o), NOW);
  assert.ok(w({ confirmationCount: 1 }) > w({ confirmationCount: 0 }));
  assert.equal(w({ confirmationCount: 3 }), w({ confirmationCount: 10 })); // capped at full weight
  assert.ok(w({ confirmationCount: 3, falseReportCount: 2 }) < w({ confirmationCount: 3 }));
  assert.equal(w({ confirmationCount: 3, falseReportCount: 4 }), 0); // 4 x 0.25 = fully discounted
});

test('one unconfirmed report cannot spike a cell', () => {
  const s = score([inc()]);
  assert.ok(s > 0 && s < 20, `got ${s}`);
});

// ── reporter reliability ───────────────────────────────────────────────────────
test('reliability: a new reporter is exactly neutral (factor 1.0)', () => {
  assert.equal(scoring.reliabilityOf({ confirmed: 0, rejected: 0 }), 0.5);
  assert.ok(Math.abs(scoring.reporterFactor({ confirmed: 0, rejected: 0 }) - 1) < 1e-9);
});

test('reliability: confirmed reports raise the factor, rejected ones lower it, within the configured bounds', () => {
  const good = scoring.reporterFactor({ confirmed: 20, rejected: 0 });
  const bad = scoring.reporterFactor({ confirmed: 0, rejected: 20 });
  assert.ok(good > 1.2 && good <= cfg.scoring.reliability.maxFactor);
  assert.ok(bad < 0.8 && bad >= cfg.scoring.reliability.minFactor);
  assert.ok(scoring.reporterFactor({ confirmed: 3, rejected: 1 }) > 1);
});

test('reliability: a trusted reporter moves the cell more than an unreliable one for the same report', () => {
  const factors = new Map([['good', scoring.reporterFactor({ confirmed: 20, rejected: 0 })], ['bad', scoring.reporterFactor({ confirmed: 0, rejected: 20 })]]);
  const trusted = score([inc({ userId: 'good' })], cell, { factorByUser: factors });
  const doubtful = score([inc({ userId: 'bad' })], cell, { factorByUser: factors });
  const neutral = score([inc({ userId: 'new' })], cell, { factorByUser: factors });
  assert.ok(trusted > neutral && neutral > doubtful);
});

// ── neighbour spread ───────────────────────────────────────────────────────────
test('spread: only CONFIRMED incidents raise neighbouring cells, and the effect falls with distance', () => {
  const unconfirmed = scoring.scoreCells([cell, ring1[0]], [inc({ confirmationCount: 1 })], NOW);
  assert.equal(unconfirmed[ring1[0]], 0); // 1 < minConfirmations (2)

  const confirmed = scoring.scoreCells([cell, ring1[0], ring2[0], far], [inc({ confirmationCount: 3 })], NOW);
  assert.ok(confirmed[cell] > confirmed[ring1[0]]);
  assert.ok(confirmed[ring1[0]] > confirmed[ring2[0]]);
  assert.ok(confirmed[ring2[0]] > 0);
  assert.equal(confirmed[far], 0);
});

// ── spam caps ──────────────────────────────────────────────────────────────────
test('spam cap: one user cannot push a cell beyond the per-user cap by filing many reports', () => {
  const spam = Array.from({ length: 30 }, () => inc({ userId: 'spammer', incidentType: 'Assault', confirmationCount: 0 }));
  const capped = score(spam);
  const onceCapped = Math.round(100 * (1 - Math.exp(-cfg.scoring.perUserCellCap / cfg.scoring.saturation)) * 10) / 10;
  assert.equal(capped, onceCapped);

  // many different people reporting the same thing DO add up past the single-user cap
  const crowd = Array.from({ length: 30 }, (_, i) => inc({ userId: `u${i}`, incidentType: 'Assault' }));
  assert.ok(score(crowd) > capped);
});

test('spam cap also limits what a single spammer can spread to neighbours', () => {
  const spam = Array.from({ length: 30 }, () => inc({ userId: 'spammer', incidentType: 'Assault', confirmationCount: 5 }));
  const one = scoring.scoreCells([ring1[0]], [inc({ userId: 'spammer', incidentType: 'Assault', confirmationCount: 5 })], NOW)[ring1[0]];
  const many = scoring.scoreCells([ring1[0]], spam, NOW)[ring1[0]];
  assert.ok(many < one * 2.5, `capped spread: ${many} vs single ${one}`);
});

// ── duplicates ─────────────────────────────────────────────────────────────────
test('duplicates: same user same type nearby recently is rejected; another user is merged as a confirmation', () => {
  const existing = { _id: 'i1', userId: 'u1', incidentType: 'Theft', latitude: 19.076, longitude: 72.8777, createdAt: new Date(NOW.getTime() - 10 * 60000) };
  const near = { latitude: 19.0765, longitude: 72.8777 }; // ~55 m
  assert.equal(scoring.classifyDuplicate({ userId: 'u1', incidentType: 'Theft', ...near }, [existing], NOW).kind, 'own_duplicate');
  const merge = scoring.classifyDuplicate({ userId: 'u2', incidentType: 'Theft', ...near }, [existing], NOW);
  assert.equal(merge.kind, 'merge');
  assert.equal(merge.incident._id, 'i1');
});

test('duplicates: the same user describing a different incident is a new report, the same words are a resend', () => {
  const existing = { _id: 'i1', userId: 'u1', incidentType: 'Theft', latitude: 19.076, longitude: 72.8777, createdAt: new Date(NOW.getTime() - 60000), description: 'Phone snatched near the bus stop' };
  const base = { userId: 'u1', incidentType: 'Theft', latitude: 19.076, longitude: 72.8777 };
  assert.equal(scoring.classifyDuplicate({ ...base, description: 'Wallet stolen at the station' }, [existing], NOW).kind, 'new');
  assert.equal(scoring.classifyDuplicate({ ...base, description: '  phone snatched near the BUS stop ' }, [existing], NOW).kind, 'own_duplicate');
});

test('duplicates: a different type, a far location or an old report is a new report', () => {
  const existing = { _id: 'i1', userId: 'u1', incidentType: 'Theft', latitude: 19.076, longitude: 72.8777, createdAt: new Date(NOW.getTime() - 10 * 60000) };
  const base = { userId: 'u2', incidentType: 'Theft', latitude: 19.0761, longitude: 72.8777 };
  assert.equal(scoring.classifyDuplicate({ ...base, incidentType: 'Fire' }, [existing], NOW).kind, 'new');
  assert.equal(scoring.classifyDuplicate({ ...base, latitude: 19.08 }, [existing], NOW).kind, 'new'); // ~440 m
  const old = { ...existing, createdAt: new Date(NOW.getTime() - 3 * 3600000) };
  assert.equal(scoring.classifyDuplicate(base, [old], NOW).kind, 'new');
});

// ── no demo, no reports ────────────────────────────────────────────────────────
test('no incidents scores exactly 0, and the component never carries demo data', () => {
  assert.equal(score([]), 0);
  const detailed = scoring.scoreCellsDetailed([cell], [inc()], NOW);
  assert.equal(detailed.reports[cell], 1);
  assert.ok(!('demo' in detailed));
});
