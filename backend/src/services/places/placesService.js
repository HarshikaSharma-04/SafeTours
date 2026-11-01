const axios = require('axios');
const h3 = require('h3-js');
const riskCfg = require('../../config/risk.config');
const cellRisk = require('../risk/cellRisk.service');
const { samplePath, straightLine, summariseRisk } = require('./routeCore');
const ApiError = require('../../utils/apiError');
const logger = require('../../utils/logger');

const LEVEL_ORDER = riskCfg.thresholds.map((t) => t.level);
const MAX_ROUTE_CELLS = 500;
const ORS_PROFILE = { foot: 'foot-walking', car: 'driving-car' };

/** Place suggestions from Geoapify, biased towards where the user is. 503 tells the app to use the phone's geocoder. */
async function search(text, { lat, lng } = {}) {
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey) throw new ApiError(503, 'Place search is not configured on the server.');

  let response;
  try {
    response = await axios.get('https://api.geoapify.com/v1/geocode/autocomplete', {
      params: {
        text,
        limit: 6,
        format: 'json',
        ...(Number.isFinite(lat) && Number.isFinite(lng) ? { bias: `proximity:${lng},${lat}` } : {}),
        apiKey,
      },
      timeout: 8000,
    });
  } catch (error) {
    logger.warn(`[places] search failed: ${error.message}`);
    throw new ApiError(503, 'Place search is unavailable right now.');
  }

  return (response.data?.results || [])
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon))
    .map((r) => ({
      name: r.name || r.address_line1 || r.formatted,
      address: r.formatted || r.address_line2 || '',
      latitude: r.lat,
      longitude: r.lon,
    }));
}

async function fetchRoute(from, to, mode) {
  const apiKey = process.env.ORS_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await axios.post(
      `https://api.openrouteservice.org/v2/directions/${ORS_PROFILE[mode]}/geojson`,
      { coordinates: [[from.lng, from.lat], [to.lng, to.lat]] },
      { headers: { Authorization: apiKey, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    const feature = response.data?.features?.[0];
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    const summary = feature.properties?.summary || {};
    return {
      source: 'openrouteservice',
      path: coordinates.map(([lng, lat]) => [lat, lng]),
      distanceMeters: Math.round(summary.distance || 0),
      durationSeconds: Math.round(summary.duration || 0),
    };
  } catch (error) {
    logger.warn(`[places] routing failed, using a straight line: ${error.message}`);
    return null;
  }
}

/**
 * A route between two points plus the risk of the cells it crosses. When no routing provider answers, the result is a
 * straight line with source 'straight-line', so the app can say that it is not a road route.
 */
async function route(from, to, mode = 'foot') {
  const result = (await fetchRoute(from, to, mode)) || straightLine(from, to, mode);

  const cells = [...new Set(samplePath(result.path).map(([lat, lng]) => h3.latLngToCell(lat, lng, cellRisk.H3_RESOLUTION)))];
  const evaluated = await cellRisk.getCellsRisk(cells.slice(0, MAX_ROUTE_CELLS));

  return {
    ...result,
    mode,
    risk: {
      ...summariseRisk(evaluated.map(({ result: r }) => ({ level: r.level })), LEVEL_ORDER),
      truncated: cells.length > MAX_ROUTE_CELLS,
    },
  };
}

module.exports = { search, route };
