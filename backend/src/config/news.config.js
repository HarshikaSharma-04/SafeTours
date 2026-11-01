/**
 * news.config.js: tunables of the news component (services/news, scheduler/newsScheduler.js).
 *
 * An article only counts if (1) it describes a hazard event (phrase-level rules below, with exclusions
 * and a negation check), AND (2) a location can be extracted from it, AND (3) it is recent. Its
 * effect is limited to the matched H3 cell and its six neighbours. An article with no extractable
 * location contributes nothing: there is no city-wide news score.
 */
module.exports = {
  // NewsData.io query. If the API rejects the boolean form (HTTP 400/422) the fetch retries once
  // with fallbackQuery. Override with env NEWS_QUERY.
  query:
    'Mumbai AND (fire OR flood OR flooding OR waterlogging OR accident OR collapse OR stampede OR blast OR explosion OR robbery OR stabbing OR murder OR protest OR landslide OR riot)',
  fallbackQuery: 'Mumbai',
  maxPages: 2, // NewsData free plan: 10 articles per request, so 2 requests per run
  // Publishers' own Mumbai feeds: real-time and keyless. NewsData.io is added on top when it has a key.
  rssFeeds: [
    { name: 'Times of India', url: 'https://timesofindia.indiatimes.com/rssfeeds/-2128838597.cms' },
    { name: 'Hindustan Times', url: 'https://www.hindustantimes.com/feeds/rss/cities/mumbai-news/rssfeed.xml' },
    { name: 'Indian Express', url: 'https://indianexpress.com/section/cities/mumbai/feed/' },
    { name: 'Free Press Journal', url: 'https://www.freepressjournal.in/stories.rss?section=mumbai' },
  ],
  rssTimeoutMs: 12000,
  maxAgeHours: 24, // older articles are ignored
  halfLifeHours: 6, // contribution halves every 6 hours

  // cellScore = 100 * (1 - exp(-raw / saturation)); raw sums severity x decay of the articles
  saturation: 35,
  neighbourFactor: 0.5, // the six neighbouring cells get this share
  descriptionLocationFactor: 0.8, // a location found only in the description counts a bit less

  geocode: { minConfidence: 0.6, maxCandidatesPerArticle: 2 },

  // Whole-article skip: not an actual event.
  // Includes court and compensation stories: they are about an event in the past, not a hazard happening now.
  nonEvent: /\b(drill|mock|rehearsal|simulation|anniversary|documentary|movie|film|web series|trailer|compensation|tribunal|liable|verdict|sentenced|convicted|acquitted|bail|chargesheet)\b/i,
  // A match is ignored if one of these appears in the ~35 characters before it.
  negation: /\b(no|not|without|averted|avoid(s|ed)?|prevent(s|ed)?|denies|denied|rules? out|false|fake|rumou?rs?|hoax)\b/i,

  /**
   * Hazards: phrase-level patterns. `exclude` patterns disable that hazard for the whole article.
   * Examples of what this prevents: "a flood of tourists", "flooded with calls", "landslide victory",
   * "fire drill", "under fire", "stock market crash".
   */
  hazards: [
    {
      key: 'fire',
      severity: 25,
      patterns: [
        /\b(caught|catches|catching) fire\b/gi,
        /\bfire (broke|breaks) out\b/gi,
        /\b(fire|blaze) (erupt\w*|engulf\w*|ravag\w*|gut\w*)/gi,
        /\b(massive|major|huge|big|level[- ]?\d) (fire|blaze)\b/gi,
        /\bfire brigade\b/gi,
        /^fire (breaks?|erupts?|guts?|kills?|injures?|damages?|ravages?|engulfs?|destroys?)\b/gi, // headline starting "Fire breaks ..."
        /\bfire (at|in|near|on)\b/gi,
        /\bfire tenders?\b/gi,
        /\bblaze\b/gi,
        /\b(building|shop|factory|godown|slum|hotel|mall|chawl|market|warehouse|vehicle|bus|car|restaurant|hospital) fire\b/gi,
      ],
      exclude: [/\bunder fire\b/i, /\bopen(s|ed)? fire\b/i, /\bfire (sale|up|power|safety|drill)\b/i, /\bfirebrand\b/i, /\bfire in the (belly|hole)\b/i],
    },
    {
      key: 'explosion',
      severity: 35,
      patterns: [/\bexplosions?\b/gi, /\bblasts?\b/gi, /\bcylinder (blast|burst)\b/gi, /\bbomb\b/gi],
      exclude: [/\bblast(ed|s)? (off|past|through)\b/i, /\bblast furnace\b/i],
    },
    {
      key: 'collapse',
      severity: 35,
      patterns: [
        /\b(building|wall|bridge|roof|slab|structure|flyover|chawl|tunnel|ceiling|balcony|hoarding|house|footbridge) (has |had )?(collapse[sd]?|caved in|came down)\b/gi,
        /\bcollapse[sd]? of (a |an |the )?(building|wall|bridge|roof|slab|structure|flyover|chawl|tunnel|ceiling|balcony|hoarding|house|footbridge)\b/gi,
      ],
      exclude: [],
    },
    { key: 'stampede', severity: 35, patterns: [/\bstampede\b/gi], exclude: [] },
    {
      key: 'landslide',
      severity: 30,
      patterns: [/\blandslides?\b/gi, /\bmudslide\b/gi],
      exclude: [/\blandslide (victory|win|wins|majority|defeat|loss|mandate)\b/i],
    },
    {
      key: 'violence',
      severity: 30,
      patterns: [
        /\bstabb(ed|ing)\b/gi,
        /\bshot dead\b/gi,
        /\bgunfire\b/gi,
        /\blynch(ed|ing)\b/gi,
        /\b(mob|communal) (attack|violence|clash\w*)\b/gi,
        /\bhacked to death\b/gi,
        /\bmolest(ed|ation)?\b/gi,
        /\bassault(ed)?\b/gi,
        /\bsexual (assault|harassment)\b/gi,
        /\bmurder(ed)?\b/gi,
        /\bacid attack\b/gi,
        /\bkidnap\w*\b/gi,
      ],
      exclude: [],
    },
    { key: 'riot', severity: 30, patterns: [/\briot(s|ing|ers)?\b/gi], exclude: [/\briot of colou?rs?\b/i] },
    {
      key: 'flood',
      severity: 20,
      patterns: [/\b(flash )?flood(s|ed|ing)?\b/gi, /\bwater ?logg(ed|ing)\b/gi, /\binundat(ed|ion)\b/gi],
      exclude: [/\bflood(s|ed|ing)? (of|with|by)\b/i],
    },
    {
      key: 'robbery',
      severity: 18,
      patterns: [/\b(robbery|robbed|dacoity|burglary|burglar\w*)\b/gi, /\bchain[- ]snatch\w*\b/gi, /\bsnatch(ed|ing|ers?)\b/gi, /\bloot(ed|ing)?\b/gi],
      exclude: [],
    },
    {
      key: 'accident',
      severity: 15,
      patterns: [
        /\b(road|car|bus|truck|bike|taxi|auto|rickshaw|train|plane|vehicle|highway|expressway) (accident|crash|collision|mishap)\b/gi,
        /\b(accident|crash|collision|mishap) (involving|between|on|at|near|claims|kills|leaves)\b/gi,
        /\bhit[- ]and[- ]run\b/gi,
        /^(accident|crash|collision)\b/gi,
        /\bderail(ed|ment)?\b/gi,
      ],
      exclude: [/\b(market|stock|stocks|share|shares|sensex|nifty) crash/i, /\bcrash (course|diet|pad)\b/i],
    },
    {
      key: 'protest',
      severity: 12,
      patterns: [
        /\bprotest(s|ed|ers|ing)?\b/gi,
        /\bmorcha\b/gi,
        /\bagitation\b/gi,
        /\bbandh\b/gi,
        /\brasta roko\b/gi,
        /\bblock(ed|ing)? (the )?(road|highway|traffic|tracks?)\b/gi,
      ],
      exclude: [],
    },
  ],
};
