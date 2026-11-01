const GridCell = require('../../models/GridCell');
const { demoCrimeScores } = require('./crimeDemo');
const { setComponentScores } = require('../risk/cellRisk.service');
const feedStatus = require('../risk/feedStatus.service');
const logger = require('../../utils/logger');

const DEMO_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const DEMO_META = Object.freeze({
  source: 'demo',
  demo: true,
  lowConfidence: true,
  note: 'Randomised demo values for presentations. Not real crime data.',
});

/**
 * Keeps the crime component consistent with USE_DEMO_CRIME_DATA at server start:
 *  - flag ON and no real data  -> seed (or refresh after 7 days) demo scores, tagged source "demo"
 *  - flag ON and real CSV data -> do nothing: real data always wins over demo
 *  - flag OFF and demo present -> remove the demo scores, so demo values never linger by accident
 * Real data comes from `npm run crime:build -- file.csv` and replaces demo scores cell by cell.
 */
async function syncDemoCrimeState() {
  const enabled = String(process.env.USE_DEMO_CRIME_DATA || '').toLowerCase() === 'true';
  const feeds = await feedStatus.getAll({ fresh: true });
  const crimeFeed = feeds.crime;
  const source = crimeFeed && crimeFeed.stats ? crimeFeed.stats.source : null;

  if (!enabled) {
    if (source === 'demo') {
      const res = await GridCell.updateMany(
        { 'components.crime.meta.source': 'demo' },
        { $unset: { 'components.crime': '' } }
      );
      await feedStatus.clear('crime');
      logger.info(`[crime] USE_DEMO_CRIME_DATA is off: removed demo crime scores from ${res.modifiedCount} cells.`);
    }
    return { enabled, action: source === 'demo' ? 'cleared' : 'none' };
  }

  if (source === 'csv') {
    logger.info('[crime] real crime data is loaded; demo data stays disabled.');
    return { enabled, action: 'skipped-real-data' };
  }
  if (source === 'demo' && crimeFeed.updatedAt && Date.now() - new Date(crimeFeed.updatedAt).getTime() < DEMO_MAX_AGE_MS) {
    return { enabled, action: 'already-seeded' };
  }

  const cells = await GridCell.find({ 'center.lat': { $type: 'number' }, 'center.lng': { $type: 'number' } }).select('h3Index center').lean();
  if (cells.length === 0) {
    logger.warn('[crime] demo crime data requested but the grid is empty (run the grid generation script).');
    return { enabled, action: 'no-grid' };
  }
  const scores = demoCrimeScores(cells);
  await setComponentScores('crime', scores, { meta: DEMO_META });
  await feedStatus.markSuccess('crime', { source: 'demo', cells: cells.length });
  logger.warn(`[crime] USE_DEMO_CRIME_DATA=true: seeded DEMO crime scores for ${cells.length} cells. Not real data.`);
  return { enabled, action: 'seeded' };
}

module.exports = { syncDemoCrimeState, DEMO_META };
