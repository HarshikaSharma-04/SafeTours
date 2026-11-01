/**
 * buildCrimeByLocality.js: writes crime scores per Mumbai locality. Data in the repo comes first, then mock figures.
 *
 *   npm run crime:build:localities                  # report only, no database writes
 *   npm run crime:build:localities -- --apply       # writes to MongoDB
 *   (default file: ../preprocessing/crime_clean.csv; pass another path as the first argument)
 *
 * Localities named in the file use its records. Other major localities use config/crime.mock.js. Every value is flagged
 * lowConfidence and records where it came from. See services/crime/crimeLocality.js for the method.
 *
 * Real data from `npm run crime:build` is never overwritten: the script stops if it finds any.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const h3 = require('h3-js');
const mongoose = require('mongoose');
const GridCell = require('../models/GridCell');
const { parseCsv } = require('../services/crime/crimePipeline');
const { localityTotals, localityProfiles, scoreCellsByLocality } = require('../services/crime/crimeLocality');
const riskCfg = require('../config/risk.config');
const { evaluate } = require('../services/risk/riskEngine');
const { setComponentScores } = require('../services/risk/cellRisk.service');
const feedStatus = require('../services/risk/feedStatus.service');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const file = args.find((a) => !a.startsWith('--')) || path.resolve(__dirname, '../../../preprocessing/crime_clean.csv');

// Places to report on, so the result can be checked by eye before writing.
const CHECK_POINTS = [
  { name: 'Dharavi', lat: 19.043, lng: 72.8553 },
  { name: 'Kurla', lat: 19.0726, lng: 72.8845 },
  { name: 'Andheri', lat: 19.1197, lng: 72.8464 },
  { name: 'Bandra', lat: 19.0596, lng: 72.8295 },
  { name: 'Dadar', lat: 19.0178, lng: 72.8478 },
  { name: 'Vile Parle', lat: 19.1, lng: 72.844 },
  { name: 'Borivali', lat: 19.2307, lng: 72.8567 },
  { name: 'Powai', lat: 19.1176, lng: 72.906 },
  { name: 'Malabar Hill', lat: 18.9548, lng: 72.7985 },
];

const REPLACEABLE_SOURCES = ['demo', 'csv-locality', 'mock-locality'];

(async () => {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  mongoose.set('autoIndex', false);
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });

  const realCells = await GridCell.countDocuments({ 'components.crime.meta.source': 'csv' });
  if (realCells > 0) {
    throw new Error(`${realCells} cells already hold real data from crime:build. Nothing written, so it is not lost.`);
  }

  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const { totals, unmatched, dropped } = localityTotals(rows);
  const profiles = localityProfiles(totals);
  const cells = await GridCell.find({ 'center.lat': { $type: 'number' }, 'center.lng': { $type: 'number' } }).select('h3Index center').lean();
  if (cells.length === 0) throw new Error('GridCell collection is empty: generate the grid first.');

  const { scores, sourcesByCell } = scoreCellsByLocality(profiles, cells);

  console.log(`\nInput: ${path.basename(file)} (${rows.length} rows)`);
  console.log(`Not in Mumbai's locality list, ignored: ${JSON.stringify(unmatched)}`);
  console.log(`Dropped by the crime rules: ${JSON.stringify(dropped)}`);
  console.log('Localities from records:');
  for (const p of profiles.filter((x) => x.source === 'records')) {
    console.log(`  ${p.name.padEnd(12)} score ${p.score.toFixed(1).padStart(5)}  ${p.incidents} incidents`);
  }
  console.log(`Localities from mock figures: ${profiles.filter((x) => x.source === 'mock').length}`);
  console.log(`Cells that get a score: ${Object.keys(scores).length} of ${cells.length}.`);

  // What each place will show overall, using the other live components already stored.
  const docs = await GridCell.find({ h3Index: { $in: CHECK_POINTS.map((p) => h3.latLngToCell(p.lat, p.lng, 9)) } }).select('h3Index components').lean();
  const feeds = await feedStatus.getAll({ fresh: true });
  const now = new Date();
  const preview = (doc, score) => evaluate({
    components: { ...((doc && doc.components) || {}), crime: { score, updatedAt: now, meta: { lowConfidence: true } } },
    feeds,
    now,
  });
  const nightBand = riskCfg.timeModifier.bands.find((band) => band.label === 'night');

  console.log('\nResult at the check points (crime, then overall risk with no time-of-day change, and at night):');
  for (const p of CHECK_POINTS) {
    const cell = h3.latLngToCell(p.lat, p.lng, 9);
    const doc = docs.find((d) => d.h3Index === cell);
    if (!(cell in scores)) {
      console.log(`  ${p.name.padEnd(12)} crime     -  no data`);
      continue;
    }
    const { baseRisk } = preview(doc, scores[cell]);
    const atNight = Math.round(Math.min(100, baseRisk * nightBand.multiplier) * 10) / 10;
    const from = sourcesByCell[cell].map((s) => `${s.locality} (${s.source})`).join(', ');
    console.log(`  ${p.name.padEnd(12)} crime ${String(scores[cell]).padStart(5)}  day ${riskCfg.levelForScore(baseRisk)} ${baseRisk}, night ${riskCfg.levelForScore(atNight)} ${atNight}  from ${from}`);
  }

  if (!apply) {
    console.log('\nDRY RUN: nothing written. Add --apply to write.');
    await mongoose.disconnect();
    return;
  }

  const builtAt = new Date().toISOString();
  const res = await setComponentScores('crime', scores, {
    meta: (h3Index) => {
      const sources = sourcesByCell[h3Index];
      const fromRecords = sources[0].source === 'records';
      return {
        source: fromRecords ? 'csv-locality' : 'mock-locality',
        // The API stays honest about mock values, whatever a screen chooses to show.
        demo: !fromRecords,
        lowConfidence: true,
        builtAt,
        localities: sources,
      };
    },
  });
  console.log(`\nWrote crime scores to ${res.modified} cells.`);

  // Cells no longer covered must not keep values from an earlier run.
  const cleared = await GridCell.updateMany(
    { 'components.crime.meta.source': { $in: REPLACEABLE_SOURCES }, 'components.crime.meta.builtAt': { $ne: builtAt } },
    { $unset: { 'components.crime': '' } }
  );
  console.log(`Cleared older values from ${cleared.modifiedCount} cells.`);

  await feedStatus.markSuccess('crime', {
    source: 'csv',
    file: path.basename(file),
    method: 'locality',
    localitiesFromRecords: profiles.filter((x) => x.source === 'records').length,
    localitiesFromMock: profiles.filter((x) => x.source === 'mock').length,
  });
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('crime:build:localities failed:', e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
