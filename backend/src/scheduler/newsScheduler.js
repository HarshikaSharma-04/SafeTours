const newsService = require('../services/newsService');
const { geocodePlace } = require('../services/geocodingService');
const { buildNewsScores } = require('../services/news/newsPipeline');
const { setComponentScores, clearComponent } = require('../services/risk/cellRisk.service');
const feedStatus = require('../services/risk/feedStatus.service');
const logger = require('../utils/logger');

/**
 * News producer: fetch -> classify -> locate -> score (services/news/newsPipeline.js) -> write the news
 * component for the matched cells and their neighbours.
 *
 * Failure behaviour: if the fetch fails (no key, timeout, rate limit) nothing is touched and the feed
 * heartbeat does not advance, so existing scores age and the risk engine flags them stale. "No news
 * reported" only becomes a valid observation after a successful run.
 */
async function processNewsUpdates() {
  logger.info('[newsScheduler] Executing periodic news processing...');

  try {
    const articles = await newsService.fetchNews();
    const geocode = async (name) => geocodePlace(name);
    const { scores, itemsByCell, stats } = await buildNewsScores(articles, { geocode });

    const now = new Date();
    const { modified } = await setComponentScores('news', scores, {
      now,
      meta: (h3Index) => {
        const items = itemsByCell[h3Index];
        return items ? { source: 'news-feeds', items: items.slice(0, 3) } : { source: 'news-feeds', spillover: true };
      },
    });
    const cleared = await clearComponent('news', { now, except: Object.keys(scores) });

    await feedStatus.markSuccess('news', { ...stats, cellsScored: Object.keys(scores).length });
    logger.info(`[newsScheduler] done: ${JSON.stringify(stats)}, ${modified} cells written, ${cleared} cleared.`);
  } catch (error) {
    await feedStatus.markFailure('news', error);
  }
}

/** @param {number} [intervalMs] env NEWS_REFRESH_MS, default 30 minutes. */
function startNewsScheduler(intervalMs = Number(process.env.NEWS_REFRESH_MS) || 30 * 60 * 1000) {
  logger.info(`[newsScheduler] Starting news scheduler (interval ${intervalMs / 1000}s)...`);
  processNewsUpdates();
  return setInterval(processNewsUpdates, intervalMs);
}

module.exports = { processNewsUpdates, startNewsScheduler };
