const test = require('node:test');
const assert = require('node:assert');
const h3 = require('h3-js');
const { findLocality, localityTotals, localityProfiles, scoreCellsByLocality } = require('./crimeLocality');
const mockScores = require('../../config/crime.mock');
const { localities } = require('../../config/mumbaiGazetteer');
const { parseCsv } = require('./crimePipeline');

const NOW = new Date('2024-06-01T00:00:00Z');
const row = (location, type = 'Theft', date = '2024-05-01') => ({ location, crime_type: type, date, latitude: '29.9', longitude: '77.9' });
const cellAt = (lat, lng) => ({ h3Index: h3.latLngToCell(lat, lng, 9), center: { lat, lng } });

const ANDHERI = cellAt(19.1197, 72.8464);
const VILE_PARLE = cellAt(19.1, 72.844);
const BORIVALI = cellAt(19.2307, 72.8567);

test('localities are found by name and alias, whatever the case; other cities are not', () => {
  assert.strictEqual(findLocality('andheri').name, 'Andheri');
  assert.strictEqual(findLocality('Andheri West').name, 'Andheri');
  assert.strictEqual(findLocality(' VILE PARLE ').name, 'Vile Parle');
  assert.strictEqual(findLocality('Karol Bagh'), null);
  assert.strictEqual(findLocality(''), null);
});

test('the file\'s wrong coordinates are ignored: an incident counts at its locality', () => {
  const { totals } = localityTotals([row('Andheri'), row('Andheri', 'Assault')], { now: NOW });
  assert.strictEqual(totals.length, 1);
  assert.strictEqual(totals[0].name, 'Andheri');
  assert.strictEqual(totals[0].incidents, 2);
  assert.deepStrictEqual(totals[0].types, { theft: 1, assault: 1 });
});

test('places outside Mumbai are counted as unmatched and add nothing', () => {
  const { totals, unmatched } = localityTotals([row('Saket'), row('Saket'), row('Karol Bagh'), row('Juhu')], { now: NOW });
  assert.deepStrictEqual(unmatched, { Saket: 2, 'Karol Bagh': 1 });
  assert.deepStrictEqual(totals.map((t) => t.name), ['Juhu']);
});

test('severity and recency come from the normal crime rules', () => {
  const recent = localityTotals([row('Andheri', 'Assault', '2024-05-30')], { now: NOW }).totals[0];
  const old = localityTotals([row('Andheri', 'Assault', '2023-05-30')], { now: NOW }).totals[0];
  const minor = localityTotals([row('Andheri', 'Theft', '2024-05-30')], { now: NOW }).totals[0];
  assert.ok(recent.weight > old.weight);
  assert.ok(recent.weight > minor.weight);
});

const DHARAVI = cellAt(19.043, 72.8553);
const MALABAR_HILL = cellAt(18.9548, 72.7985);
const FAR_AWAY = cellAt(19.45, 72.8);

test('a locality with records in the file uses them, even if it also has a mock figure', () => {
  const { totals } = localityTotals(Array.from({ length: 10 }, () => row('Dharavi')), { now: NOW });
  const profile = localityProfiles(totals, { Dharavi: 5 }).find((p) => p.name === 'Dharavi');
  assert.strictEqual(profile.source, 'records');
  assert.strictEqual(profile.score, 75);
  assert.strictEqual(profile.incidents, 10);
});

test('a locality without records uses its mock figure and says so', () => {
  const profile = localityProfiles([], { Dharavi: 80 }).find((p) => p.name === 'Dharavi');
  assert.strictEqual(profile.source, 'mock');
  assert.strictEqual(profile.score, 80);
  assert.strictEqual(profile.incidents, null);
});

test('among localities with records the busiest gets the peak score and the others keep their differences', () => {
  const rows = [...Array.from({ length: 200 }, () => row('Andheri')), ...Array.from({ length: 100 }, () => row('Colaba'))];
  const { totals } = localityTotals(rows, { now: NOW });
  const profiles = localityProfiles(totals, {});
  assert.strictEqual(profiles.find((p) => p.name === 'Andheri').score, 75);
  assert.strictEqual(profiles.find((p) => p.name === 'Colaba').score, 37.5);
});

test('risk changes with location: Dharavi scores far above Malabar Hill', () => {
  const { scores } = scoreCellsByLocality(localityProfiles([]), [DHARAVI, MALABAR_HILL]);
  assert.ok(scores[DHARAVI.h3Index] > 70, `Dharavi ${scores[DHARAVI.h3Index]}`);
  assert.ok(scores[MALABAR_HILL.h3Index] < 25, `Malabar Hill ${scores[MALABAR_HILL.h3Index]}`);
});

test('a cell says which localities its score came from, nearest first', () => {
  const { sourcesByCell } = scoreCellsByLocality(localityProfiles([]), [DHARAVI]);
  assert.strictEqual(sourcesByCell[DHARAVI.h3Index][0].locality, 'Dharavi');
  assert.strictEqual(sourcesByCell[DHARAVI.h3Index][0].source, 'mock');
});

test('between two localities the score lies between theirs', () => {
  const profiles = localityProfiles([], { Andheri: 80, 'Vile Parle': 20 });
  const between = cellAt(19.11, 72.845);
  const { scores } = scoreCellsByLocality(profiles, [between]);
  assert.ok(scores[between.h3Index] > 20 && scores[between.h3Index] < 80);
});

test('out of reach of every locality there is no score, not a score of 0', () => {
  const { scores } = scoreCellsByLocality(localityProfiles([]), [FAR_AWAY]);
  assert.ok(!(FAR_AWAY.h3Index in scores));
});

test('no localities means no scores', () => {
  assert.deepStrictEqual(scoreCellsByLocality([], [ANDHERI]).scores, {});
});

test('every mock figure names a known locality and is a valid score', () => {
  const known = new Set(localities.map((l) => l.name));
  for (const [name, score] of Object.entries(mockScores)) {
    assert.ok(known.has(name), `${name} is not in the locality list`);
    assert.ok(score >= 0 && score <= 100);
  }
});

test('works on rows parsed from the project CSV format', () => {
  const csv = 'Crime_ID,City,Date,Time,Crime_Type,Location,Latitude,Longitude,Crime_Severity\n2,Mumbai,2024-04-08,02:39,Burglary,Andheri,22.3,73.3,8\n3,Mumbai,2024-04-09,02:39,Theft,Saket,28.5,77.2,2';
  const { totals, unmatched } = localityTotals(parseCsv(csv), { now: NOW });
  assert.strictEqual(totals[0].name, 'Andheri');
  assert.deepStrictEqual(totals[0].types, { burglary: 1 });
  assert.deepStrictEqual(unmatched, { Saket: 1 });
});
