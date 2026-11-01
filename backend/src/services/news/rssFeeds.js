const axios = require('axios');
const newsCfg = require('../../config/news.config');
const logger = require('../../utils/logger');

/**
 * Real-time Mumbai news from publishers' own RSS feeds. No key is needed. One failing feed does not stop the others.
 * Only headlines and summaries are read, to classify events; article text is not stored in full or republished.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole;
    const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
  });
}

/** The text of the first <name> element in an item: CDATA unwrapped, HTML tags removed, entities decoded. */
function field(item, name) {
  const match = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  if (!match) return '';
  const raw = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Feeds escape their HTML, so tags are removed again after decoding.
  return decodeEntities(raw.replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** @returns {Array<{title,description,source,publishedAt}>} articles without a title are skipped */
function parseRss(xml, source) {
  const items = String(xml || '').match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  const articles = [];
  for (const item of items) {
    const title = field(item, 'title');
    if (!title) continue;
    const time = Date.parse(field(item, 'pubDate'));
    articles.push({
      title,
      description: field(item, 'description'),
      source,
      publishedAt: Number.isNaN(time) ? null : new Date(time).toISOString(),
    });
  }
  return articles;
}

/**
 * @returns {Promise<{articles:Array, failed:string[]}>} throws only when every feed failed
 */
async function fetchRssArticles({ feeds = newsCfg.rssFeeds, http = axios } = {}) {
  const results = await Promise.allSettled(
    feeds.map(async (feed) => {
      const response = await http.get(feed.url, {
        timeout: newsCfg.rssTimeoutMs,
        responseType: 'text',
        headers: { 'User-Agent': 'SafeTours/1.0 (safety app; news reader)', Accept: 'application/rss+xml, application/xml, text/xml' },
      });
      return parseRss(response.data, feed.name);
    })
  );

  const articles = [];
  const failed = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      articles.push(...result.value);
    } else {
      failed.push(feeds[index].name);
      logger.warn(`[rssFeeds] ${feeds[index].name} failed: ${result.reason.message}`);
    }
  });
  if (failed.length === feeds.length) throw new Error('All news RSS feeds failed.');
  return { articles, failed };
}

module.exports = { parseRss, fetchRssArticles };
