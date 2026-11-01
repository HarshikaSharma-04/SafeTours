'use strict';

/**
 * assistantRules: the rule-based ("offline assistant") answers and the Home safety tips.
 *
 * Pure CommonJS with no imports, so the SAME file runs on the server (fallback when Gemini is unavailable) and on
 * the phone (OFFLINE, or server unreachable). Two byte-identical copies exist:
 *     backend/src/shared/assistantRules.js        (this file, the source of truth)
 *     frontend/src/offline/assistantRules.js      (copy used on the device)
 * A backend test fails if they differ. After editing run:  npm run sync:device-core   (in backend/)
 *
 * It only ever repeats values found in the context object. It never invents places, phone numbers or scores.
 *
 * Context shape (every part may be null/missing):
 *   { source:'server'|'device', connectivity, fetchedAt,
 *     risk:{ level, score, topFactor, dataConfidence, demo, lowConfidence, reasons[], notes[], missing[], stale[] },
 *     weather:{ temperature, description, rainMmPerHour, stale } | null,
 *     nearby:{ status, stale, nearest:{ hospital:[{name,distance,phone}], police:[...], pharmacy:[], fire_station:[] } } | null,
 *     journey:{ active, etaMinutes } | null,
 *     community:{ count } | null }
 */

const EMERGENCY_NUMBER = '112';

const FACTOR_LABEL = {
  crime: 'past crime in the area',
  weather: 'the weather',
  crowd: 'crowd levels',
  community: 'recent community reports',
  news: 'recent news',
};

const TYPE_LABEL = { hospital: 'hospital', police: 'police station', pharmacy: 'pharmacy', fire_station: 'fire station' };

function formatDistance(m) {
  if (!Number.isFinite(m)) return null;
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 36 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** Which question is the user asking? Keyword based and deliberately small. */
function intentOf(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(hospital|clinic|doctor|medical|ambulance|injur|hurt|bleed)/.test(t)) return 'hospital';
  if (/\b(police|cop|thana|station house|crime report)/.test(t)) return 'police';
  if (/\b(what (should|do) i|what now|help me|emergency|in danger|scared|follow(ed|ing)|attack|unsafe)/.test(t)) return 'what_now';
  if (/\b(weather|rain|temperature|hot|cold|storm|flood)/.test(t)) return 'weather';
  if (/\b(report|incident|community|harass|theft|stolen|accident|nearby (issues|incidents))/.test(t)) return 'community';
  if (/\b(safe|safety|danger|risk|zone|area|okay to walk|should i go)/.test(t)) return 'safety';
  return 'summary';
}

const level = (ctx) => (ctx && ctx.risk && ctx.risk.level) || 'UNKNOWN';

/** One honest sentence about the risk, including how far to trust it. */
function riskSentence(ctx) {
  const r = ctx && ctx.risk;
  if (!r || r.level === 'UNKNOWN' || r.level === undefined || r.level === null) {
    return 'I do not have enough data for this area to rate its risk, so I cannot say it is safe. Please stay alert.';
  }
  const parts = [`This area is rated ${r.level}${Number.isFinite(r.score) ? ` (${Math.round(r.score)}/100)` : ''}`];
  if (r.topFactor && FACTOR_LABEL[r.topFactor]) parts[0] += `, mainly because of ${FACTOR_LABEL[r.topFactor]}`;
  parts[0] += '.';
  const caveats = [];
  if (r.demo) caveats.push('part of this data is sample data');
  if (r.lowConfidence || (Number.isFinite(r.dataConfidence) && r.dataConfidence < 0.6)) caveats.push('data confidence is low');
  if (r.missing && r.missing.length) caveats.push(`no data for ${r.missing.map((k) => FACTOR_LABEL[k] || k).join(', ')}`);
  if (r.stale && r.stale.length) caveats.push(`${r.stale.map((k) => FACTOR_LABEL[k] || k).join(', ')} may be out of date`);
  if (caveats.length) parts.push(`Note: ${caveats.join('; ')}.`);
  return parts.join(' ');
}

function sourceSentence(ctx) {
  if (ctx && ctx.source === 'device') {
    const age = ctx.fetchedAt ? ageText(Date.now() - new Date(ctx.fetchedAt).getTime()) : null;
    return `This comes from data saved on your phone${age ? ` (updated ${age})` : ''}, not a live check.`;
  }
  return null;
}

function nearestSentence(ctx, type) {
  const label = TYPE_LABEL[type] || type;
  const list = ctx && ctx.nearby && ctx.nearby.nearest && ctx.nearby.nearest[type];
  if (!list || list.length === 0) {
    const loaded = ctx && ctx.nearby && ctx.nearby.status !== 'unavailable';
    const why = loaded ? `I found no ${label} in the loaded data` : 'I could not load nearby places';
    return `${why}.`;
  }
  const p = list[0];
  const d = formatDistance(p.distance);
  const name = p.name || `Unnamed ${label}`;
  const stale = ctx.nearby.stale ? ' (saved data, may be outdated)' : '';
  return `Nearest ${label}: ${name}${d ? `, about ${d} away` : ''}${p.phone ? `, phone ${p.phone}` : ''}${stale}.`;
}

function emergencyLine() {
  return `In a real emergency call ${EMERGENCY_NUMBER} or press the SOS button in the app.`;
}

function weatherSentence(ctx) {
  const w = ctx && ctx.weather;
  if (!w || (w.temperature === null || w.temperature === undefined) && !w.description) {
    return 'I do not have weather data right now.';
  }
  const bits = [];
  if (Number.isFinite(w.temperature)) bits.push(`${Math.round(w.temperature)} °C`);
  if (w.description) bits.push(w.description);
  if (Number.isFinite(w.rainMmPerHour) && w.rainMmPerHour > 0.2) bits.push(`rain about ${w.rainMmPerHour.toFixed(1)} mm/h`);
  return `Weather: ${bits.join(', ')}${w.stale ? ' (last known, may be outdated)' : ''}.`;
}

/**
 * The rule-based answer.
 * @returns {{text:string, intent:string}}
 */
function answerFromContext(question, ctx) {
  const intent = intentOf(question);
  const lines = [];
  const lvl = level(ctx);

  switch (intent) {
    case 'hospital':
      lines.push(nearestSentence(ctx, 'hospital'));
      lines.push(emergencyLine());
      break;
    case 'police':
      lines.push(nearestSentence(ctx, 'police'));
      lines.push(emergencyLine());
      break;
    case 'weather':
      lines.push(weatherSentence(ctx));
      if (lvl !== 'UNKNOWN' && ctx.risk && ctx.risk.topFactor === 'weather') lines.push('Weather is currently the main risk factor here.');
      break;
    case 'community': {
      const n = ctx && ctx.community && Number.isFinite(ctx.community.count) ? ctx.community.count : null;
      lines.push(n === null ? 'I could not load community reports.' : n === 0 ? 'There are no active community reports nearby.' : `There ${n === 1 ? 'is 1 active community report' : `are ${n} active community reports`} nearby.`);
      lines.push(riskSentence(ctx));
      break;
    }
    case 'what_now':
      lines.push(emergencyLine());
      lines.push(riskSentence(ctx));
      if (lvl === 'HIGH' || lvl === 'EXTREME') lines.push('Move towards a busy, well-lit place and keep your phone reachable.');
      lines.push(nearestSentence(ctx, 'police'));
      lines.push(nearestSentence(ctx, 'hospital'));
      break;
    case 'safety':
      lines.push(riskSentence(ctx));
      if (lvl === 'HIGH' || lvl === 'EXTREME') lines.push('If you can, avoid this area, especially alone or after dark.');
      break;
    default:
      lines.push(riskSentence(ctx));
      lines.push(nearestSentence(ctx, 'hospital'));
      lines.push(emergencyLine());
  }

  const src = sourceSentence(ctx);
  if (src) lines.push(src);
  if (ctx && ctx.risk && ctx.risk.notes && ctx.risk.notes.length && intent === 'safety') lines.push(ctx.risk.notes[0] + '.');
  return { text: lines.filter(Boolean).join(' '), intent };
}

/**
 * Up to `max` short tips for the Home screen, built from the real context (no network, no AI call).
 * @returns {Array<{id:string, icon:string, title:string, text:string, prompt:string}>}
 */
function homeTips(ctx, max = 3) {
  const tips = [];
  const lvl = level(ctx);
  const r = ctx && ctx.risk;

  if (lvl === 'HIGH' || lvl === 'EXTREME') {
    tips.push({ id: 'risk', icon: 'warning', title: `${lvl} risk area`, text: 'Stay on busy, well-lit streets and share your location with a contact.', prompt: 'What should I do now?', priority: 100 });
  } else if (lvl === 'MODERATE') {
    tips.push({ id: 'risk', icon: 'alert-circle', title: 'Moderate risk', text: `Stay aware of your surroundings${r && r.topFactor && FACTOR_LABEL[r.topFactor] ? `: ${FACTOR_LABEL[r.topFactor]} is the main factor` : ''}.`, prompt: 'Is this area safe?', priority: 80 });
  } else if (lvl === 'UNKNOWN') {
    tips.push({ id: 'unknown', icon: 'help-circle', title: 'Not enough data here', text: 'There is not enough data to rate this area, so treat it with normal caution.', prompt: 'Is this area safe?', priority: 70 });
  } else {
    tips.push({ id: 'risk', icon: 'shield-checkmark', title: `${lvl === 'SAFE' ? 'Low' : 'Lower'} risk right now`, text: 'No elevated risk is reported here. Keep your usual precautions.', prompt: 'Is this area safe?', priority: 40 });
  }

  const w = ctx && ctx.weather;
  if (w) {
    const desc = String(w.description || '').toLowerCase();
    if (/(thunder|storm|heavy rain|rain|drizzle)/.test(desc) || (Number.isFinite(w.rainMmPerHour) && w.rainMmPerHour > 2)) {
      tips.push({ id: 'weather', icon: 'rainy', title: 'Rain expected', text: 'Wet roads and low visibility: allow extra travel time and avoid flooded streets.', prompt: 'How does the weather affect my trip?', priority: 75 });
    } else if (Number.isFinite(w.temperature) && w.temperature >= 35) {
      tips.push({ id: 'weather', icon: 'sunny', title: `Hot: ${Math.round(w.temperature)} °C`, text: 'Carry water and rest in the shade.', prompt: 'How does the weather affect my trip?', priority: 60 });
    }
  }

  const hospital = ctx && ctx.nearby && ctx.nearby.nearest && ctx.nearby.nearest.hospital && ctx.nearby.nearest.hospital[0];
  if (hospital && Number.isFinite(hospital.distance)) {
    tips.push({ id: 'hospital', icon: 'medkit', title: 'Nearest hospital', text: `${hospital.name || 'Hospital'}, about ${formatDistance(hospital.distance)} away.`, prompt: 'Nearest hospital', priority: 50 });
  }

  const reports = ctx && ctx.community && ctx.community.count;
  if (Number.isFinite(reports) && reports > 0) {
    tips.push({ id: 'community', icon: 'people', title: 'Community reports nearby', text: `${reports} active report${reports === 1 ? '' : 's'} in this area.`, prompt: 'Any incidents reported near me?', priority: 65 });
  }

  if (ctx && ctx.source === 'device') {
    tips.push({ id: 'offline', icon: 'cloud-offline', title: 'Using saved data', text: 'You are offline, so this uses data saved on your phone.', prompt: 'Is this area safe?', priority: 55 });
  } else if (r && (r.demo || r.lowConfidence)) {
    tips.push({ id: 'quality', icon: 'information-circle', title: r.demo ? 'Includes sample data' : 'Low data confidence', text: r.demo ? 'Part of the crime data is sample data, so treat this rating as indicative.' : 'Some data is missing or old, so the rating is less certain.', prompt: 'Is this area safe?', priority: 45 });
  }

  return tips
    .sort((a, b) => b.priority - a.priority)
    .slice(0, max)
    .map(({ priority, ...tip }) => tip);
}

// ── report proposals (rule based) ───────────────────────────────────────────────────────────────

const REPORT_WORDS = [
  /\breport\b/i, /\bthere('s| is| are| was)\b/i, /\bhappening\b/i, /\bjust (saw|happened)\b/i, /\bi (saw|see|witnessed)\b/i,
  /\bharass/i, /\bstalk/i, /\bfollow(ed|ing)\b/i, /\bthef(t|ts)\b/i, /\bstol(e|en)\b/i, /\brobb/i, /\bsnatch/i, /\bassault/i, /\battack/i,
  /\bfight/i, /\baccident/i, /\bcrash/i, /\bfire\b/i, /\bsmoke\b/i, /\bflood/i, /\bwaterlog/i, /\bblocked\b/i, /\broad ?block/i,
  /\bstreet ?light/i, /\blight(s)? (is|are)? ?(out|off|broken|not working)/i, /\bsuspicious/i, /\bmedical emergency\b/i, /\bunconscious\b/i,
];

/** Is the user's message about reporting an incident? Plain questions ("is it safe here?") are not reports. */
function looksLikeReportRequest(userMessage) {
  const t = String(userMessage || '');
  if (!t.trim()) return false;
  if (/^\s*(is|are|can|should|what|where|how|do|does)\b[^.!]*\?\s*$/i.test(t) && !/\breport\b/i.test(t)) return false;
  return REPORT_WORDS.some((re) => re.test(t));
}

// keyword -> category name (a category is only proposed when it exists in the `categories` list given)
const CATEGORY_KEYWORDS = [
  [/\bassault|attack(ed|ing)?\b|\bbeat(ing|en)\b/i, 'Assault'],
  [/\bharass|\bstalk|\bcat-?call|\beve[- ]?teas/i, 'Harassment'],
  [/\bthef(t|ts)\b|\bstol(e|en)\b|\brobb|\bsnatch|\bpickpocket/i, 'Theft'],
  [/\bfire\b|\bsmoke\b|\bburning\b/i, 'Fire'],
  [/\baccident|\bcrash(ed)?\b|\bcollision/i, 'Accident'],
  [/\bunconscious\b|\bmedical emergency\b|\bcollaps/i, 'Medical Emergency'],
  [/\bflood|\bwaterlog/i, 'Waterlogging'],
  [/\broad ?block|\bblocked\b|\bbarricade/i, 'Road Block'],
  [/\bstreet ?light|\blight(s)? (is|are)? ?(out|off|broken|not working)/i, 'Street Light Failure'],
  [/\bsuspicious|\bfollow(ed|ing)\b|\bloiter/i, 'Suspicious Activity'],
];

/**
 * A report PROPOSAL built from the user's own words (used when the AI is unavailable, and on the phone offline).
 * It is only a suggestion: the app asks the user to confirm before anything is filed.
 * @returns {{incidentType:string, description:string}|null}
 */
function proposeReportFromText(text, categories) {
  if (!looksLikeReportRequest(text)) return null;
  const clean = String(text).replace(/\s+/g, ' ').trim();
  for (const [re, name] of CATEGORY_KEYWORDS) {
    if (re.test(clean) && (!categories || categories.includes(name))) {
      const description = clean.length > 300 ? `${clean.slice(0, 297)}...` : clean;
      if (description.length >= 5) return { incidentType: name, description };
    }
  }
  return null;
}

module.exports = { EMERGENCY_NUMBER, intentOf, riskSentence, answerFromContext, homeTips, formatDistance, looksLikeReportRequest, proposeReportFromText };
