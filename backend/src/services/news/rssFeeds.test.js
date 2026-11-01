const test = require('node:test');
const assert = require('node:assert');
const { parseRss, fetchRssArticles } = require('./rssFeeds');
const { buildNewsScores } = require('./newsPipeline');

const NOW = new Date('2026-11-01T12:00:00Z');

const FEED = `<?xml version="1.0"?><rss><channel><title>Mumbai News</title>
  <item>
    <title><![CDATA[Fire breaks out at Kurla building &amp; 3 injured]]></title>
    <description><![CDATA[<p>Fire tenders reached the spot.</p><img src="x.jpg"/>]]></description>
    <pubDate>Sun, 01 Nov 2026 11:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Plain title with &quot;quotes&quot; and &#8217;apostrophe</title>
    <description>&lt;b&gt;Escaped&lt;/b&gt; summary</description>
    <pubDate>not a date</pubDate>
  </item>
  <item><description>No title, so this one is skipped</description></item>
</channel></rss>`;

test('parseRss reads CDATA, removes HTML, decodes entities and reads the time', () => {
  const [first, second, third] = parseRss(FEED, 'Test');
  assert.strictEqual(first.title, 'Fire breaks out at Kurla building & 3 injured');
  assert.strictEqual(first.description, 'Fire tenders reached the spot.');
  assert.strictEqual(first.publishedAt, '2026-11-01T11:00:00.000Z');
  assert.strictEqual(first.source, 'Test');
  assert.strictEqual(second.title, 'Plain title with "quotes" and ’apostrophe');
  assert.strictEqual(second.description, 'Escaped summary');
  assert.strictEqual(second.publishedAt, null);
  assert.strictEqual(third, undefined);
});

test('parseRss copes with empty or broken input', () => {
  assert.deepStrictEqual(parseRss('', 'Test'), []);
  assert.deepStrictEqual(parseRss('<html>Not a feed</html>', 'Test'), []);
  assert.deepStrictEqual(parseRss(undefined, 'Test'), []);
});

test('one failing feed does not lose the others', async () => {
  const feeds = [{ name: 'Good', url: 'good' }, { name: 'Bad', url: 'bad' }];
  const http = { get: async (url) => { if (url === 'bad') throw new Error('timeout'); return { data: FEED }; } };
  const { articles, failed } = await fetchRssArticles({ feeds, http });
  assert.strictEqual(articles.length, 2);
  assert.deepStrictEqual(failed, ['Bad']);
});

test('when every feed fails it says so, so the score is marked stale rather than "no news"', async () => {
  const http = { get: async () => { throw new Error('offline'); } };
  await assert.rejects(fetchRssArticles({ feeds: [{ name: 'A', url: 'a' }], http }), /All news RSS feeds failed/);
});

test('a parsed article raises the score of the place it names, and its neighbours less', async () => {
  const articles = parseRss(FEED, 'Test');
  const { scores, itemsByCell, stats } = await buildNewsScores(articles, { now: NOW });
  assert.strictEqual(stats.counted, 1);
  const [cell] = Object.keys(itemsByCell);
  assert.ok(scores[cell] > 0);
  assert.strictEqual(itemsByCell[cell][0].location, 'Kurla');
  assert.strictEqual(itemsByCell[cell][0].source, 'Test');
  const neighbours = Object.keys(scores).filter((c) => c !== cell);
  assert.strictEqual(neighbours.length, 6);
  for (const c of neighbours) assert.ok(scores[c] < scores[cell]);
});
