const h3 = require('h3-js');
const GridCell = require('../../models/GridCell');
const cfg = require('../../config/risk.config');
const { evaluate } = require('./riskEngine');
const feedStatus = require('./feedStatus.service');
const ApiError = require('../../utils/apiError');
const logger = require('../../utils/logger');

const H3_RESOLUTION = 9;
const MAX_CELLS_RETURNED = 3000; // response cap
const MAX_CELLS_SCANNED = 15000; // more than the whole grid, so a city-wide box is never silently cut
const LEVEL_ORDER = cfg.thresholds.map((t) => t.level); // SAFE..EXTREME

const COMPONENT_KEYS = Object.keys(cfg.components);

function toCell(lat, lng) {
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new ApiError(400, 'Latitude and longitude must be valid numbers.');
  }
  return h3.latLngToCell(latitude, longitude, H3_RESOLUTION);
}

/** Compact public view of an evaluation result (shared by every risk endpoint). */
function publicView(h3Index, cell, result) {
  const flat = {};
  const details = {};
  for (const k of COMPONENT_KEYS) {
    const b = result.breakdown[k];
    flat[k] = b.score;
    details[k] = {
      status: b.status,
      available: b.available,
      stale: b.stale,
      appliedWeight: b.appliedWeight,
      ageMinutes: b.ageMinutes,
      lowConfidence: b.lowConfidence,
      demo: b.demo,
      reports: b.reports,
      noReports: b.noReports,
    };
  }
  const [lat, lng] = cell && cell.center ? [cell.center.lat, cell.center.lng] : h3.cellToLatLng(h3Index);
  return {
    h3Index,
    cellId: cell ? cell._id : null,
    insideCoverage: Boolean(cell),
    center: { latitude: lat, longitude: lng },
    riskLevel: result.level,
    totalRiskScore: result.totalRisk,
    dataConfidence: result.dataConfidence,
    confidenceLabel: result.confidenceLabel,
    lowConfidence: result.lowConfidence,
    lowConfidenceReasons: result.lowConfidenceReasons,
    notes: result.notes,
    demo: result.demo,
    missing: result.missing,
    stale: result.stale,
    topFactor: result.topFactor,
    breakdown: flat,
    componentDetails: details,
    modifiers: result.modifiers,
    computedAt: result.computedAt,
  };
}

async function loadFeeds() {
  try {
    return await feedStatus.getAll();
  } catch (e) {
    logger.error('[cellRisk] could not read feed status; treating all feeds as unknown', e);
    return {};
  }
}

/** Full evaluation of one cell (also used by the admin debug endpoint). */
async function evaluateCell(h3Index, { now = new Date() } = {}) {
  const cell = await GridCell.findOne({ h3Index }).select('h3Index center components').lean();
  const feeds = await loadFeeds();
  const result = evaluate({ components: (cell && cell.components) || {}, feeds, now });
  return { cell, feeds, result };
}

async function getCellRisk(h3Index, opts) {
  const { cell, result } = await evaluateCell(h3Index, opts);
  return publicView(h3Index, cell, result);
}

/** Evaluates many cells with one grid query and one feed lookup. Cells outside the grid come back UNKNOWN. */
async function getCellsRisk(h3Indexes, { now = new Date() } = {}) {
  const docs = await GridCell.find({ h3Index: { $in: h3Indexes } }).select('h3Index center components').lean();
  const byIndex = new Map(docs.map((d) => [d.h3Index, d]));
  const feeds = await loadFeeds();
  return h3Indexes.map((h3Index) => {
    const cell = byIndex.get(h3Index) || null;
    return { h3Index, cell, result: evaluate({ components: (cell && cell.components) || {}, feeds, now }) };
  });
}

async function getRiskAt(lat, lng, opts) {
  return getCellRisk(toCell(lat, lng), opts);
}

/**
 * Cells inside a bounding box whose evaluated level is at least `minLevel`.
 * UNKNOWN cells are excluded unless includeUnknown is set (an area with no data is not drawn).
 * Result shape matches what the map component already renders (polygon + riskLevel).
 */
async function listCellsInBox({ minLat, maxLat, minLng, maxLng, minLevel = 'LOW', includeUnknown = false, limit = 1500, compact = false }) {
  const minRank = LEVEL_ORDER.indexOf(String(minLevel).toUpperCase());
  if (minRank < 0) throw new ApiError(400, `minLevel must be one of ${LEVEL_ORDER.join(', ')}`);

  const cap = Math.min(Number(limit) || 1500, MAX_CELLS_RETURNED);
  const docs = await GridCell.find({
    'center.lat': { $gte: Number(minLat), $lte: Number(maxLat) },
    'center.lng': { $gte: Number(minLng), $lte: Number(maxLng) },
  })
    .select('h3Index center components')
    .limit(MAX_CELLS_SCANNED)
    .lean();

  const feeds = await loadFeeds();
  const now = new Date();
  const out = [];
  let unknownCount = 0;

  for (const doc of docs) {
    const result = evaluate({ components: doc.components || {}, feeds, now });
    if (result.unknown) {
      unknownCount += 1;
      if (!includeUnknown) continue;
    } else if (LEVEL_ORDER.indexOf(result.level) < minRank) {
      continue;
    }
    if (compact) {
      // Lean row for on-device caching: no polygon (the phone derives it from the H3 index).
      // baseRisk lets the phone re-apply the time-of-day modifier itself while offline.
      const components = {};
      for (const k of COMPONENT_KEYS) components[k] = result.breakdown[k].score;
      out.push({
        h3Index: doc.h3Index,
        riskLevel: result.level,
        totalRiskScore: result.totalRisk,
        baseRisk: result.baseRisk,
        dataConfidence: result.dataConfidence,
        lowConfidence: result.lowConfidence,
        demo: result.demo,
        topFactor: result.topFactor,
        components,
        // community reports filed in this cell (the community score itself is components.community)
        communityReports: result.breakdown.community ? result.breakdown.community.reports : 0,
      });
      if (out.length >= cap) break;
      continue;
    }
    out.push({
      _id: doc.h3Index,
      h3Index: doc.h3Index,
      location: { type: 'Point', coordinates: [doc.center.lng, doc.center.lat] },
      polygon: h3.cellToBoundary(doc.h3Index), // [[lat, lng], ...]
      radius: 200,
      riskLevel: result.level,
      totalRiskScore: result.totalRisk,
      dataConfidence: result.dataConfidence,
      lowConfidence: result.lowConfidence,
      demo: result.demo,
      topFactor: result.topFactor,
    });
    if (out.length >= cap) break;
  }

  // Most dangerous first, so a truncated response keeps the cells that matter.
  out.sort((a, b) => (b.totalRiskScore ?? -1) - (a.totalRiskScore ?? -1));
  return { cells: out, scanned: docs.length, unknownCells: unknownCount, truncated: out.length >= cap || docs.length >= MAX_CELLS_SCANNED };
}

/**
 * Writes one component for many cells in a single bulkWrite.
 * scoresByH3: { [h3Index]: 0..100 }. Cells that do not exist in the grid are ignored.
 * meta may be an object (same for every cell) or a function h3Index -> object.
 * `now` is written as the component's updatedAt (producers may pass an older time to age the data).
 */
async function setComponentScores(key, scoresByH3, { meta, now = new Date() } = {}) {
  if (!COMPONENT_KEYS.includes(key)) throw new Error(`Unknown risk component "${key}"`);
  const entries = Object.entries(scoresByH3 || {});
  if (entries.length === 0) return { matched: 0, modified: 0 };

  const ops = entries.map(([h3Index, score]) => ({
    updateOne: {
      filter: { h3Index },
      update: {
        $set: {
          [`components.${key}.score`]: Math.max(0, Math.min(100, Number(score))),
          [`components.${key}.updatedAt`]: now,
          ...(meta ? { [`components.${key}.meta`]: typeof meta === 'function' ? meta(h3Index) : meta } : {}),
        },
      },
    },
  }));

  let matched = 0;
  let modified = 0;
  const CHUNK = 1000;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const res = await GridCell.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
    matched += res.matchedCount || 0;
    modified += res.modifiedCount || 0;
  }
  return { matched, modified };
}

/**
 * Sets a component to 0 on every cell that currently holds a positive score for it,
 * except the listed cells (used after writing the fresh scores of a feed run).
 */
async function clearComponent(key, { now = new Date(), except = [] } = {}) {
  const filter = { [`components.${key}.score`]: { $gt: 0 } };
  if (except.length > 0) filter.h3Index = { $nin: except };
  const res = await GridCell.updateMany(
    filter,
    { $set: { [`components.${key}.score`]: 0, [`components.${key}.updatedAt`]: now }, $unset: { [`components.${key}.meta`]: '' } }
  );
  return res.modifiedCount || 0;
}

module.exports = {
  H3_RESOLUTION,
  toCell,
  evaluateCell,
  getCellRisk,
  getCellsRisk,
  getRiskAt,
  listCellsInBox,
  setComponentScores,
  clearComponent,
  publicView,
};
