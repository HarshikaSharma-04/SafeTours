const fs = require('fs');
const path = require('path');
const GridCell = require('../models/GridCell');
const wcfg = require('../config/weather.config');
const weatherService = require('../services/weather/weather.service');
const { scoreObservation, interpolateScore, applyFloodBoost } = require('../services/weather/weatherScore');
const { setComponentScores } = require('../services/risk/cellRisk.service');
const feedStatus = require('../services/risk/feedStatus.service');
const logger = require('../utils/logger');

/**
 * Weather producer (quota-friendly).
 *  1. One OpenWeather request per sample point (12 in config/weather.config.js), every 30 minutes.
 *  2. Each observation is scored from rain intensity, visibility, wind/gust, heat/cold and
 *     thunderstorm condition (services/weather/weatherScore.js).
 *  3. Every grid cell gets an inverse-distance-weighted blend of its 3 nearest usable samples.
 *     A cell with no sample within 15 km gets nothing (missing, not guessed).
 *  4. Optional flood-prone boost, only if data/flood-prone-cells.json exists (see weather.config.js).
 *
 * Failure behaviour: a sample whose request fails is served from the 3-hour cache flagged stale and is
 * then left out of the interpolation. If every sample fails nothing is written: the previous values
 * age and the risk engine flags them stale and finally drops them.
 */

let floodProne; // undefined = not loaded, null = no data file
function loadFloodProne() {
  if (floodProne !== undefined) return floodProne;
  const file = path.resolve(__dirname, '../../', wcfg.floodProne.file);
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    floodProne = new Set(Array.isArray(list) ? list : list.h3 || []);
    logger.info(`[weatherScheduler] flood-prone boost enabled: ${floodProne.size} cells from ${wcfg.floodProne.file}`);
  } catch (e) {
    floodProne = null;
    logger.info('[weatherScheduler] no flood-prone data file: flood boost is OFF (heavy rain still scores high).');
  }
  return floodProne;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function processWeatherUpdate() {
  try {
    if (!process.env.OPENWEATHER_API_KEY) {
      throw new Error('OPENWEATHER_API_KEY is not set; weather data unavailable');
    }

    const observed = await mapLimit(wcfg.samplePoints, 4, async (pt) => {
      try {
        const obs = await weatherService.getCurrentWeather(pt.lat, pt.lng);
        const scored = scoreObservation(obs);
        return { ...pt, ok: !obs.stale && scored.score !== null, stale: Boolean(obs.stale), obs, scored };
      } catch (err) {
        logger.warn(`[weatherScheduler] sample ${pt.name} failed: ${err.message}`);
        return { ...pt, ok: false, error: err.message };
      }
    });

    const usable = observed.filter((s) => s.ok).map((s) => ({ lat: s.lat, lng: s.lng, score: s.scored.score, rain: s.scored.factors.rain ?? null }));
    if (usable.length === 0) throw new Error('all weather samples failed or were stale');

    // A cell without a centre cannot be interpolated, and one such document must not cost the whole city its weather.
    const cells = await GridCell.find({ 'center.lat': { $type: 'number' }, 'center.lng': { $type: 'number' } }).select('h3Index center').lean();
    const flood = loadFloodProne();
    const scores = {};
    let outOfRange = 0;
    for (const cell of cells) {
      let score = interpolateScore(usable, cell.center);
      if (score === null) {
        outOfRange += 1;
        continue;
      }
      if (flood && flood.has(cell.h3Index)) {
        const rain = interpolateScore(usable.map((u) => ({ ...u, score: u.rain ?? 0 })), cell.center);
        score = applyFloodBoost(score, rain);
      }
      scores[cell.h3Index] = score;
    }

    const failed = observed.filter((s) => !s.ok).map((s) => s.name);
    const meta = {
      source: 'openweathermap',
      samples: usable.length,
      failedSamples: failed,
      lowConfidence: usable.length < wcfg.samplePoints.length / 2,
      floodBoost: Boolean(flood),
    };
    const { modified } = await setComponentScores('weather', scores, { meta });

    await feedStatus.markSuccess('weather', {
      samplesOk: usable.length,
      samplesFailed: failed,
      cellsWritten: modified,
      cellsOutOfRange: outOfRange,
      floodBoost: Boolean(flood),
      // Latest observations, used by the admin debug view and later by the assistant for context.
      observations: observed.map((s) => ({
        name: s.name,
        ok: s.ok,
        score: s.scored ? s.scored.score : null,
        reasons: s.scored ? s.scored.reasons : [],
        condition: s.obs ? s.obs.weatherDescription : null,
        temperatureC: s.obs ? s.obs.temperature : null,
        rainMmPerHour: s.obs ? s.obs.rainMmPerHour : null,
        visibilityM: s.obs ? s.obs.visibility : null,
        error: s.error || (s.stale ? 'stale' : undefined),
      })),
    });
    logger.info(`[weatherScheduler] ${usable.length}/${wcfg.samplePoints.length} samples, ${modified} cells written, ${outOfRange} out of range.`);
  } catch (error) {
    await feedStatus.markFailure('weather', error);
  }
}

function startWeatherScheduler(intervalMs = Number(process.env.WEATHER_REFRESH_MS) || wcfg.refreshMs) {
  logger.info(`[weatherScheduler] Starting (interval ${intervalMs / 1000}s, ${wcfg.samplePoints.length} sample points)...`);
  processWeatherUpdate();
  return setInterval(processWeatherUpdate, intervalMs);
}

module.exports = { processWeatherUpdate, startWeatherScheduler };
