// Shared helpers for the backend's risk labels (SAFE / LOW / MODERATE / HIGH / EXTREME / UNKNOWN).

export const DANGER_LEVELS = ['HIGH', 'EXTREME'];

export const isDangerLevel = (level) => DANGER_LEVELS.includes(String(level || '').toUpperCase());

/** "62 / 100" or "—" when the backend has no score (UNKNOWN). Never turns null into 0. */
export const formatScore = (score, suffix = '') =>
  score === null || score === undefined || Number.isNaN(Number(score)) ? '—' : `${Math.round(Number(score))}${suffix}`;

export const confidenceText = (risk) => {
  if (!risk || risk.dataConfidence === undefined || risk.dataConfidence === null) return null;
  return `${Math.round(risk.dataConfidence * 100)}% (${String(risk.confidenceLabel || '').toLowerCase()})`;
};

const FACTOR_LABELS = { crime: 'Crime', weather: 'Weather', crowd: 'Crowd', community: 'Community', news: 'News' };
export const factorLabel = (key) => FACTOR_LABELS[key] || key;

/** One-line, honest explanation of data quality for a risk result. */
export const dataQualityNote = (risk) => {
  if (!risk) return null;
  const parts = [];
  if (risk.missing?.length) parts.push(`No data: ${risk.missing.map(factorLabel).join(', ')}`);
  if (risk.stale?.length) parts.push(`Outdated: ${risk.stale.map(factorLabel).join(', ')}`);
  if (risk.notes?.length) parts.push(risk.notes[0]);
  return parts.length ? parts.join(' · ') : null;
};
