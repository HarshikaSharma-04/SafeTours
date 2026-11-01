const axios = require('axios');
const newsCfg = require('../config/news.config');
const { fetchRssArticles } = require('./news/rssFeeds');
const logger = require('../utils/logger');
const ApiError = require('../utils/apiError');

/**
 * NewsData.io client. Fetches up to newsCfg.maxPages pages (10 articles each on the free plan) for the
 * hazard query. If the API rejects the boolean query (400/422) it retries once with the plain
 * fallback query. Publication times are parsed to ISO UTC (NewsData returns "YYYY-MM-DD HH:mm:ss" in UTC).
 * Every request has a timeout; failures throw ApiError and the scheduler keeps the previous scores.
 */

function parsePubDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

async function requestPage(apiUrl, params) {
  const response = await axios.get(apiUrl, { params, timeout: 10000 });
  return response.data || {};
}

function toApiError(error) {
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') return new ApiError(504, 'NewsData.io request timed out.');
  const status = error.response?.status;
  const apiMessage = error.response?.data?.results?.message || error.response?.data?.message || error.message;
  if (status === 401) return new ApiError(401, 'NewsData.io: invalid or missing API key.');
  if (status === 403) return new ApiError(403, 'NewsData.io: access denied or plan limit reached.');
  if (status === 429) return new ApiError(429, 'NewsData.io: rate limit exceeded.');
  if (status >= 500) return new ApiError(502, 'NewsData.io is temporarily unavailable.');
  return new ApiError(status || 502, `NewsData.io error: ${apiMessage}`);
}

/** NewsData.io only. @returns {Promise<Array<{title,description,source,publishedAt}>>} deduplicated by title */
async function fetchNewsData() {
  const apiKey = process.env.NEWSDATA_API_KEY;
  if (!apiKey) throw new ApiError(503, 'NEWSDATA_API_KEY is not set; news data unavailable.');

  const apiUrl = process.env.NEWS_API_URL || 'https://newsdata.io/api/1/news';
  let query = process.env.NEWS_QUERY || newsCfg.query;
  const base = { apikey: apiKey, country: 'in', language: 'en', size: 10 };

  const raw = [];
  let nextPage = null;
  let retriedWithFallback = false;

  for (let page = 0; page < newsCfg.maxPages; page += 1) {
    try {
      const data = await requestPage(apiUrl, { ...base, q: query, ...(nextPage ? { page: nextPage } : {}) });
      raw.push(...(Array.isArray(data.results) ? data.results : []));
      nextPage = data.nextPage || null;
      if (!nextPage) break;
    } catch (error) {
      const status = error.response?.status;
      if ((status === 400 || status === 422) && !retriedWithFallback && query !== newsCfg.fallbackQuery) {
        logger.warn(`[newsService] query rejected (HTTP ${status}); retrying with the plain "${newsCfg.fallbackQuery}" query.`);
        retriedWithFallback = true;
        query = newsCfg.fallbackQuery;
        nextPage = null;
        page -= 1;
        continue;
      }
      if (raw.length > 0) {
        logger.warn(`[newsService] page ${page + 1} failed (${error.message}); using the ${raw.length} articles already fetched.`);
        break;
      }
      throw toApiError(error);
    }
  }

  const seen = new Set();
  const articles = [];
  for (const a of raw) {
    if (!a || !a.title) continue;
    const key = a.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    articles.push({
      title: a.title.trim(),
      description: a.description || '',
      source: a.source_id || a.source_name || 'unknown',
      publishedAt: parsePubDate(a.pubDate),
    });
  }
  logger.info(`[newsService] fetched ${raw.length} articles, ${articles.length} unique.`);
  return articles;
}

/**
 * Every available source, with each headline once. Throws only if nothing could be fetched, so the feed then goes stale
 * rather than reading as "no news".
 * @returns {Promise<Array<{title,description,source,publishedAt}>>}
 */
async function fetchNews() {
  const sources = [fetchRssArticles().then((r) => r.articles)];
  if (process.env.NEWSDATA_API_KEY) sources.push(fetchNewsData());

  const results = await Promise.allSettled(sources);
  const fetched = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
  if (results.every((r) => r.status === 'rejected')) {
    throw new ApiError(503, `News unavailable: ${results.map((r) => r.reason.message).join('; ')}`);
  }
  results.filter((r) => r.status === 'rejected').forEach((r) => logger.warn(`[newsService] one source failed: ${r.reason.message}`));

  const seen = new Set();
  const articles = fetched.filter((a) => {
    const key = a.title.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  logger.info(`[newsService] ${articles.length} unique articles from ${fetched.length} fetched.`);
  return articles;
}

module.exports = { fetchNews, fetchNewsData, parsePubDate };
