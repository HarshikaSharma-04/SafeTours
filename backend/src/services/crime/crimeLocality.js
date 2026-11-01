const crimeCfg = require('../../config/crime.config');
const defaultMock = require('../../config/crime.mock');
const { localities } = require('../../config/mumbaiGazetteer');
const { haversineMeters } = require('../../config/region.config');
const { normalizeRows } = require('./crimePipeline');

/**
 * Crime scores per Mumbai locality (pure functions, no database). Data in the repo comes first:
 *
 *   records  a locality named in the crime file: score = peakScore x its weight / weight of the busiest locality.
 *            Only the file's locality names are used, because its coordinates are unusable.
 *   mock     any other locality in config/crime.mock.js: its hand-picked placeholder figure.
 *
 * A cell blends the localities around it, the nearest counting most:
 *   k(locality) = exp(-(distance / sigma)^2)
 *   score(cell) = sum(k x locality score) / sum(k), over localities within reach
 *
 * Risk therefore changes from one neighbourhood to the next, with no street-level hotspots that the data cannot support.
 * The score tops out at peakScore for records because this file cannot justify calling anywhere the worst possible.
 * A cell out of reach of every locality gets NO score: that is "no data", not "no crime".
 */

const byName = new Map();
for (const place of localities) {
  byName.set(place.name.toLowerCase(), place);
  for (const alias of place.aliases) byName.set(alias.toLowerCase(), place);
}

const findLocality = (name) => byName.get(String(name || '').trim().toLowerCase()) || null;

const locationOf = (row) => row.location ?? row.locality ?? row.area ?? '';

/**
 * Adds up each locality's incidents, using the severity and recency rules of crimePipeline.normalizeRows.
 * @returns {{totals:Array, unmatched:Object, dropped:Object}} unmatched: rows per place name that is not in Mumbai's list
 */
function localityTotals(rows, { now = new Date(), cfg = crimeCfg } = {}) {
  const groups = new Map();
  const unmatched = {};
  for (const row of rows) {
    const place = findLocality(locationOf(row));
    if (!place) {
      const label = String(locationOf(row)).trim() || '(blank)';
      unmatched[label] = (unmatched[label] || 0) + 1;
      continue;
    }
    if (!groups.has(place.name)) groups.set(place.name, { place, rows: [] });
    // The file's own coordinates are replaced by the locality's centre.
    groups.get(place.name).rows.push({ ...row, lat: place.lat, lng: place.lng, latitude: undefined, longitude: undefined });
  }

  const dropped = {};
  const totals = [];
  for (const { place, rows: placeRows } of groups.values()) {
    const { incidents, dropped: d } = normalizeRows(placeRows, { now, cfg });
    for (const [reason, count] of Object.entries(d)) dropped[reason] = (dropped[reason] || 0) + count;
    if (incidents.length === 0) continue;
    const types = {};
    for (const inc of incidents) types[inc.type] = (types[inc.type] || 0) + 1;
    totals.push({
      name: place.name,
      lat: place.lat,
      lng: place.lng,
      incidents: incidents.length,
      weight: incidents.reduce((sum, inc) => sum + inc.weight, 0),
      types,
    });
  }
  return { totals, unmatched, dropped };
}

const topTypes = (types, count = 3) =>
  Object.entries(types)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([type, n]) => ({ type, incidents: n }));

/**
 * One profile per locality: from the file's records when it has any, otherwise from the mock figures.
 * @param {Array} totals from localityTotals
 * @param {Object} [mock] locality name -> score
 */
function localityProfiles(totals, mock = defaultMock, { cfg = crimeCfg } = {}) {
  const busiest = Math.max(0, ...totals.map((place) => place.weight));
  const profiles = totals.map((place) => ({
    name: place.name,
    lat: place.lat,
    lng: place.lng,
    source: 'records',
    score: busiest > 0 ? (cfg.locality.peakScore * place.weight) / busiest : 0,
    incidents: place.incidents,
    types: topTypes(place.types),
  }));
  const withRecords = new Set(totals.map((place) => place.name));
  for (const [name, score] of Object.entries(mock)) {
    const place = findLocality(name);
    if (!place || withRecords.has(place.name)) continue;
    profiles.push({ name: place.name, lat: place.lat, lng: place.lng, source: 'mock', score, incidents: null, types: [] });
  }
  return profiles;
}

/**
 * @param {Array} profiles from localityProfiles
 * @param {Array<{h3Index:string, center:{lat:number,lng:number}}>} cells
 * @returns {{scores:Object, sourcesByCell:Object}} sourcesByCell[cell] = the localities behind this score, nearest first
 */
function scoreCellsByLocality(profiles, cells, { cfg = crimeCfg } = {}) {
  const { sigmaMeters, reachMeters, minShare, maxSources } = cfg.locality;
  const scores = {};
  const sourcesByCell = {};

  for (const cell of cells) {
    const here = [];
    let total = 0;
    let weighted = 0;
    for (const place of profiles) {
      const d = haversineMeters(cell.center.lat, cell.center.lng, place.lat, place.lng);
      if (d > reachMeters) continue;
      const k = Math.exp(-((d / sigmaMeters) ** 2));
      total += k;
      weighted += k * place.score;
      here.push({ place, k });
    }
    if (here.length === 0 || total <= 0) continue;

    scores[cell.h3Index] = Math.round((weighted / total) * 10) / 10;
    sourcesByCell[cell.h3Index] = here
      .sort((a, b) => b.k - a.k)
      .filter(({ k }, index) => index === 0 || k / total >= minShare)
      .slice(0, maxSources)
      .map(({ place }) => ({ locality: place.name, source: place.source, incidents: place.incidents, types: place.types }));
  }
  return { scores, sourcesByCell };
}

module.exports = { findLocality, localityTotals, localityProfiles, scoreCellsByLocality, topTypes };
