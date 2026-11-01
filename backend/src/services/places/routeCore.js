const { haversineMeters } = require('../../config/region.config');

// Speeds for the straight-line estimate, used only when no routing provider answers.
const WALKING_METERS_PER_SECOND = 1.4; // 5 km/h
const DRIVING_METERS_PER_SECOND = 8.3; // about 30 km/h, a city average

/**
 * Points along a path about every `stepMeters`, including both ends, so that every H3 resolution 9 cell the path
 * crosses is sampled (a cell edge is about 175 m, so 100 m steps cannot jump over one).
 * @param {Array<[number, number]>} path [lat, lng] pairs
 */
function samplePath(path, stepMeters = 100) {
  if (!path.length) return [];
  const out = [path[0]];
  for (let i = 1; i < path.length; i += 1) {
    const [aLat, aLng] = path[i - 1];
    const [bLat, bLng] = path[i];
    const pieces = Math.max(1, Math.ceil(haversineMeters(aLat, aLng, bLat, bLng) / stepMeters));
    for (let p = 1; p <= pieces; p += 1) {
      out.push([aLat + ((bLat - aLat) * p) / pieces, aLng + ((bLng - aLng) * p) / pieces]);
    }
  }
  return out;
}

function straightLine(from, to, mode) {
  const distanceMeters = haversineMeters(from.lat, from.lng, to.lat, to.lng);
  const speed = mode === 'car' ? DRIVING_METERS_PER_SECOND : WALKING_METERS_PER_SECOND;
  return {
    source: 'straight-line',
    path: [[from.lat, from.lng], [to.lat, to.lng]],
    distanceMeters: Math.round(distanceMeters),
    durationSeconds: Math.round(distanceMeters / speed),
  };
}

/**
 * Sums up the risk along a route. Cells with no data are counted as unknown, never as safe.
 * @param {Array<{level:string}>} cells
 * @param {string[]} levelOrder lowest to highest
 */
function summariseRisk(cells, levelOrder) {
  const counts = {};
  let worstRank = -1;
  let unknown = 0;
  for (const { level } of cells) {
    const rank = levelOrder.indexOf(level);
    if (rank < 0) {
      unknown += 1;
      continue;
    }
    counts[level] = (counts[level] || 0) + 1;
    if (rank > worstRank) worstRank = rank;
  }
  return {
    cellsChecked: cells.length,
    unknownCells: unknown,
    worstLevel: worstRank >= 0 ? levelOrder[worstRank] : 'UNKNOWN',
    counts,
  };
}

module.exports = { samplePath, straightLine, summariseRisk };
