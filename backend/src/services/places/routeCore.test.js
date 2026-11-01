const test = require('node:test');
const assert = require('node:assert');
const { samplePath, straightLine, summariseRisk } = require('./routeCore');
const { haversineMeters } = require('../../config/region.config');

const LEVELS = ['SAFE', 'LOW', 'MODERATE', 'HIGH', 'EXTREME'];

test('samplePath keeps both ends and never steps further than requested', () => {
  const path = [[19.0, 72.8], [19.01, 72.81]];
  const points = samplePath(path, 100);
  assert.deepStrictEqual(points[0], path[0]);
  assert.deepStrictEqual(points[points.length - 1], path[1]);
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(haversineMeters(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]) <= 100.5);
  }
});

test('samplePath of an empty path is empty', () => {
  assert.deepStrictEqual(samplePath([]), []);
});

test('straightLine labels itself and estimates duration from the mode', () => {
  const from = { lat: 19.0, lng: 72.8 };
  const to = { lat: 19.01, lng: 72.8 };
  const foot = straightLine(from, to, 'foot');
  const car = straightLine(from, to, 'car');
  assert.strictEqual(foot.source, 'straight-line');
  assert.ok(foot.distanceMeters > 1000 && foot.distanceMeters < 1200);
  assert.ok(foot.durationSeconds > car.durationSeconds);
});

test('summariseRisk reports the worst level and counts each level', () => {
  const r = summariseRisk([{ level: 'SAFE' }, { level: 'HIGH' }, { level: 'LOW' }, { level: 'HIGH' }], LEVELS);
  assert.strictEqual(r.worstLevel, 'HIGH');
  assert.strictEqual(r.counts.HIGH, 2);
  assert.strictEqual(r.cellsChecked, 4);
});

test('cells with no data count as unknown, never as safe', () => {
  const r = summariseRisk([{ level: 'UNKNOWN' }, { level: 'UNKNOWN' }], LEVELS);
  assert.strictEqual(r.worstLevel, 'UNKNOWN');
  assert.strictEqual(r.unknownCells, 2);
  assert.strictEqual(r.counts.SAFE, undefined);
});
