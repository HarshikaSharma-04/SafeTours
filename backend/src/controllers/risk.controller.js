const h3 = require('h3-js');
const cfg = require('../config/risk.config');
const cellRisk = require('../services/risk/cellRisk.service');
const communityComponent = require('../services/risk/communityComponent');
const feedStatus = require('../services/risk/feedStatus.service');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/apiError');

// GET /api/risk/location?lat&lng — risk of the cell containing the point.
const getLocationRisk = asyncHandler(async (req, res) => {
  const { lat, lng } = req.query;
  const data = await cellRisk.getRiskAt(lat, lng);
  data.location = { latitude: lat, longitude: lng };
  res.status(200).json({ success: true, message: 'Location risk retrieved successfully.', data });
});

// GET /api/risk/live?lat&lng&previousH3Index — cheap poll: full payload only when the cell changed.
const getLiveRisk = asyncHandler(async (req, res) => {
  const { lat, lng, previousH3Index } = req.query;
  const current = cellRisk.toCell(lat, lng);
  if (previousH3Index && previousH3Index.trim() === current) {
    return res.status(200).json({ success: true, data: { h3Index: current, cellChanged: false } });
  }
  const data = await cellRisk.getCellRisk(current);
  data.location = { latitude: lat, longitude: lng };
  return res.status(200).json({ success: true, data: { ...data, cellChanged: true } });
});

// GET /api/risk/cells?minLat&maxLat&minLng&maxLng[&minLevel][&includeUnknown][&limit]
const getCells = asyncHandler(async (req, res) => {
  const { minLat, maxLat, minLng, maxLng, minLevel, includeUnknown, limit, compact } = req.query;
  if (Number(minLat) > Number(maxLat) || Number(minLng) > Number(maxLng)) {
    throw new ApiError(400, 'Bounding box is inverted (min must be <= max).');
  }
  const { cells, scanned, unknownCells, truncated } = await cellRisk.listCellsInBox({
    minLat,
    maxLat,
    minLng,
    maxLng,
    minLevel,
    // Express 5 keeps req.query read-only, so the validator's toBoolean() cannot convert these: "false" would stay truthy.
    includeUnknown: String(includeUnknown) === 'true',
    limit,
    compact: String(compact) === 'true',
  });
  res.status(200).json({
    success: true,
    message: 'Risk cells retrieved successfully.',
    count: cells.length,
    meta: { scanned, unknownCells, truncated },
    data: cells,
  });
});

// GET /api/risk/cell/:h3Index
const getCell = asyncHandler(async (req, res) => {
  const data = await cellRisk.getCellRisk(req.params.h3Index);
  res.status(200).json({ success: true, message: 'Cell risk retrieved successfully.', data });
});

// GET /api/admin/risk/debug?lat&lng — admin only. Everything needed to explain a score.
const debugRisk = asyncHandler(async (req, res) => {
  const { lat, lng } = req.query;
  const h3Index = cellRisk.toCell(lat, lng);
  const { cell, result } = await cellRisk.evaluateCell(h3Index);
  const feeds = await feedStatus.getAll({ fresh: true });
  const now = Date.now();
  // Which reports make up the community score of this cell (null if the lookup fails: debug only).
  const communityDetail = await communityComponent.explainCell(h3Index).catch(() => null);

  const feedView = {};
  for (const [key, f] of Object.entries(feeds)) {
    feedView[key] = {
      updatedAt: f.updatedAt,
      ageMinutes: f.updatedAt ? Math.round((now - new Date(f.updatedAt).getTime()) / 60000) : null,
      lastAttemptAt: f.lastAttemptAt,
      lastError: f.lastError,
      stats: f.stats || null,
    };
  }

  const sumEffective = Object.values(result.breakdown).reduce((a, b) => a + b.configuredWeight * (b.available ? (b.stale ? cfg.staleWeightFactor : 1) : 0), 0);

  res.status(200).json({
    success: true,
    data: {
      query: { latitude: lat, longitude: lng },
      h3Index,
      cell: cell
        ? { id: cell._id, center: cell.center, rawComponents: cell.components || {} }
        : { note: 'Point is outside the generated grid; no component data exists.' },
      feeds: feedView,
      evaluation: {
        level: result.level,
        totalRisk: result.totalRisk,
        baseRisk: result.baseRisk,
        dataConfidence: result.dataConfidence,
        confidenceLabel: result.confidenceLabel,
        lowConfidence: result.lowConfidence,
        lowConfidenceReasons: result.lowConfidenceReasons,
        notes: result.notes,
        community: communityDetail,
        unknown: result.unknown,
        missing: result.missing,
        stale: result.stale,
        topFactor: result.topFactor,
        // per component: score, configuredWeight, appliedWeight (renormalised), contribution,
        // status (fresh|stale|expired|missing), ageMinutes, ttlMinutes, updatedAt, flags
        components: result.breakdown,
        modifiers: result.modifiers,
        calculation: {
          formula: 'base = sum(w_i * s_i) / sum(w_i) over usable components; total = clamp(base * timeMultiplier * festivalMultiplier, 0, 100)',
          usableWeightSum: Math.round(sumEffective * 1000) / 1000,
          baseRisk: result.baseRisk,
          combinedMultiplier: result.modifiers.combinedMultiplier,
          totalRisk: result.totalRisk,
        },
        computedAt: result.computedAt,
      },
      config: {
        weights: Object.fromEntries(Object.entries(cfg.components).map(([k, v]) => [k, v.weight])),
        ttlMinutes: Object.fromEntries(Object.entries(cfg.components).map(([k, v]) => [k, v.ttlMinutes])),
        thresholds: cfg.thresholds,
        confidence: cfg.confidence,
        staleWeightFactor: cfg.staleWeightFactor,
        maxStaleFactor: cfg.maxStaleFactor,
        criticalComponents: cfg.criticalComponents,
        timeModifier: cfg.timeModifier,
        timezone: cfg.timezone,
        h3Resolution: cellRisk.H3_RESOLUTION,
      },
      neighbours: h3.gridDisk(h3Index, 1).filter((c) => c !== h3Index),
    },
  });
});

module.exports = { getLocationRisk, getLiveRisk, getCells, getCell, debugRisk };
