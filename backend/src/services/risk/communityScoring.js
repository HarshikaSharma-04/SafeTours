const h3 = require('h3-js');
const defaultCfg = require('../../config/communityConfig');

/**
 * communityScoring: pure functions (no database, no clock besides `now`) that turn active community incidents
 * into a 0-100 score per H3 cell. Configuration: config/communityConfig.js.
 */

const round1 = (n) => Math.round(n * 10) / 10;

/** Reporter reliability in [0,1]. A user with no history is exactly 0.5 (neutral). */
function reliabilityOf({ confirmed = 0, rejected = 0 } = {}, cfg = defaultCfg) {
  const r = cfg.scoring.reliability;
  return (confirmed + r.priorConfirmed) / (confirmed + rejected + r.priorConfirmed + r.priorRejected);
}

/** Multiplier applied to a reporter's incidents: 1.0 at neutral, minFactor at 0, maxFactor at 1. */
function reporterFactor(history, cfg = defaultCfg) {
  const r = cfg.scoring.reliability;
  return r.minFactor + (r.maxFactor - r.minFactor) * reliabilityOf(history, cfg);
}

/**
 * Weight of ONE incident at `now`.
 *   severity x timeDecay x verification x falsePenalty x reporterFactor
 * @param {Object} inc lean Incident { incidentType, createdAt, expiresAt, confirmationCount, falseReportCount, userId }
 * @param {Object} [opts] { factorByUser: Map|object userId -> reporter factor, cfg }
 */
function incidentWeight(inc, now, { factorByUser, cfg = defaultCfg } = {}) {
  const category = cfg.incidentCategories[inc.incidentType];
  const base = category ? category.severity : cfg.incidentCategories.Other.severity;

  const created = new Date(inc.createdAt).getTime();
  const expires = new Date(inc.expiresAt).getTime();
  const life = Math.max(1, expires - created);
  const decay = Math.min(1, Math.max(0, (expires - now.getTime()) / life));

  const s = cfg.scoring;
  const confirmations = Math.max(0, inc.confirmationCount || 0);
  const verification = 0.5 + 0.5 * Math.min(1, confirmations / s.confirmationsForFullWeight);
  const falsePenalty = Math.max(0, 1 - s.falsePenaltyPerReport * (inc.falseReportCount || 0));

  let factor = 1;
  if (factorByUser && inc.userId !== undefined && inc.userId !== null) {
    const f = factorByUser instanceof Map ? factorByUser.get(String(inc.userId)) : factorByUser[String(inc.userId)];
    if (Number.isFinite(f)) factor = f;
  }
  return base * decay * verification * falsePenalty * factor;
}

/**
 * Scores for `targetCells` given the active incidents around them.
 * @returns {{scores:Object<string,number>, reports:Object<string,number>}}
 *   reports[cell] = number of active incidents that were filed IN that cell (own cell only)
 */
function scoreCellsDetailed(targetCells, incidents, now = new Date(), { factorByUser, cfg = defaultCfg } = {}) {
  const s = cfg.scoring;

  // 1) weight per incident, then cap what one user can add to one cell
  const rows = [];
  for (const inc of incidents) {
    const w = incidentWeight(inc, now, { factorByUser, cfg });
    if (w <= 0) continue;
    rows.push({ cell: inc.h3CellId, user: inc.userId === undefined || inc.userId === null ? `anon:${rows.length}` : String(inc.userId), w, confirmations: inc.confirmationCount || 0 });
  }
  const sumByUserCell = new Map();
  for (const r of rows) {
    const k = `${r.cell}|${r.user}`;
    sumByUserCell.set(k, (sumByUserCell.get(k) || 0) + r.w);
  }
  for (const r of rows) {
    const total = sumByUserCell.get(`${r.cell}|${r.user}`);
    if (total > s.perUserCellCap) r.w *= s.perUserCellCap / total;
  }

  // 2) own-cell weight plus spread from confirmed incidents
  const ownByCell = new Map();
  const reports = new Map();
  const spread = new Map(); // cell -> weight arriving from neighbours
  for (const r of rows) {
    ownByCell.set(r.cell, (ownByCell.get(r.cell) || 0) + r.w);
    reports.set(r.cell, (reports.get(r.cell) || 0) + 1);
    if (r.confirmations >= s.neighbours.minConfirmations) {
      for (const { ring, factor } of s.neighbours.rings) {
        for (const c of safeRing(r.cell, ring)) {
          spread.set(c, (spread.get(c) || 0) + r.w * factor);
        }
      }
    }
  }

  const scores = {};
  const counts = {};
  for (const cell of targetCells) {
    const raw = (ownByCell.get(cell) || 0) + (spread.get(cell) || 0);
    scores[cell] = round1(100 * (1 - Math.exp(-raw / s.saturation)));
    counts[cell] = reports.get(cell) || 0;
  }
  return { scores, reports: counts };
}

/** Cells at exactly `ring` steps from `cell` (gridDisk difference: works across pentagons). */
function safeRing(cell, ring) {
  const outer = h3.gridDisk(cell, ring);
  const inner = new Set(h3.gridDisk(cell, ring - 1));
  return outer.filter((c) => !inner.has(c));
}

function scoreCells(targetCells, incidents, now, opts) {
  return scoreCellsDetailed(targetCells, incidents, now, opts).scores;
}

/** All cells a confirmed incident can touch (used to know which scores to recompute). */
function influenceRadius(cfg = defaultCfg) {
  return Math.max(0, ...cfg.scoring.neighbours.rings.map((r) => r.ring));
}

/**
 * Reliability counts from an aggregate row.
 * @param {{confirmedReports:number, rejectedReports:number}} row
 */
function factorFromCounts(row, cfg = defaultCfg) {
  return reporterFactor({ confirmed: (row && row.confirmedReports) || 0, rejected: (row && row.rejectedReports) || 0 }, cfg);
}

// ── duplicate detection ───────────────────────────────────────────────────────

const toRad = (d) => (d * Math.PI) / 180;
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * Is a new report a duplicate of an existing active one?
 *   same user, same type, same text, within radius and window -> 'own_duplicate' (reject: an accidental resend)
 *   same user, same type, different text -> 'new' (a second incident; perUserCellCap still limits its effect on the score)
 *   other user, same type, within radius and window -> 'merge'           (counts as a confirmation of it)
 * @param {{userId:any, incidentType:string, latitude:number, longitude:number, description?:string}} report
 * @param {Array} candidates active incidents (lean) of the same area
 */
function classifyDuplicate(report, candidates, now = new Date(), cfg = defaultCfg) {
  const d = cfg.scoring.duplicate;
  const windowMs = d.windowMinutes * 60000;
  let best = null;
  for (const c of candidates) {
    if (c.incidentType !== report.incidentType) continue;
    if (now.getTime() - new Date(c.createdAt).getTime() > windowMs) continue;
    const dist = distanceMeters(report.latitude, report.longitude, c.latitude, c.longitude);
    if (dist > d.radiusMeters) continue;
    if (String(c.userId) === String(report.userId)) {
      if (sameText(c.description, report.description)) return { kind: 'own_duplicate', incident: c, distance: dist };
      continue;
    }
    if (!best || dist < best.distance) best = { kind: 'merge', incident: c, distance: dist };
  }
  return best || { kind: 'new' };
}

module.exports = {
  reliabilityOf,
  reporterFactor,
  factorFromCounts,
  incidentWeight,
  scoreCells,
  scoreCellsDetailed,
  influenceRadius,
  classifyDuplicate,
  distanceMeters,
};
