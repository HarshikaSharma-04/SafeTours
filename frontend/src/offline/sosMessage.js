'use strict';

/**
 * The SOS text message (pure).
 *
 * SMS capacity: GSM-7 text fits 160 characters in one segment and 153 per segment when split; text with
 * any character outside GSM-7 (Hindi names, emoji, curly quotes) switches the WHOLE message to UCS-2:
 * 70 characters in one segment, 67 per segment when split. The message is therefore kept plain ASCII and
 * fitted into `maxSegments`, cutting in this order and reporting each cut:
 *   1. the custom text is shortened, then removed
 *   2. the accuracy is removed
 *   3. the name is shortened to 20 characters
 */
const GSM7_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€\f';
const IST_OFFSET_MS = 330 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** "06 Oct 21:35 IST" (fixed UTC+5:30: no Intl, which Hermes may not ship timezone data for). */
function formatIst(ts) {
  const d = new Date(new Date(ts).getTime() + IST_OFFSET_MS);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} IST`;
}

/** { encoding:'GSM-7'|'UCS-2', units, segments } */
function measure(text) {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7_BASIC.includes(ch)) septets += 1;
    else if (GSM7_EXT.includes(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: 'GSM-7', units: septets, segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  const units = text.length; // UTF-16 code units
  return { encoding: 'UCS-2', units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const mapsLink = (lat, lng) => `https://maps.google.com/?q=${lat.toFixed(5)},${lng.toFixed(5)}`;
const hasFix = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng);

/**
 * `fixAt` is when the GPS position was taken: a position older than `staleFixMs` is labelled with its own time,
 * so a contact never reads an old position as the current one. That label is never cut.
 *
 * @param {{name?:string, lat?:number, lng?:number, accuracy?:number, fixAt?:number|string, staleFixMs?:number, triggeredAt:number|Date, customText?:string, maxSegments?:number}} p
 * @returns {{text:string, encoding:string, segments:number, units:number, cut:string[]}}
 */
function buildSosSms({ name, lat, lng, accuracy, fixAt, staleFixMs = 5 * 60 * 1000, triggeredAt, customText, maxSegments = 2 }) {
  const cut = [];
  let who = oneLine(name) || 'A SafeTours user';
  let custom = oneLine(customText);
  let acc = Number.isFinite(accuracy) ? Math.round(accuracy) : null;
  const fixMs = fixAt ? new Date(fixAt).getTime() : NaN;
  const stale = Number.isFinite(fixMs) && new Date(triggeredAt).getTime() - fixMs > staleFixMs ? `, last seen ${formatIst(fixMs)}.` : '';

  const compose = () => {
    const loc = hasFix(lat, lng) ? ` Loc: ${mapsLink(lat, lng)}${acc !== null ? ` (+/-${acc}m)` : ''}${stale}` : ' Location unavailable.';
    return `SafeTours SOS: ${who} needs help.${loc} ${formatIst(triggeredAt)}.${custom ? ` ${custom}` : ''}`;
  };
  const fits = (t) => measure(t).segments <= maxSegments;

  let text = compose();
  if (!fits(text) && custom) {
    // shorten the custom text to what still fits, keeping at least 20 characters of it
    const original = custom;
    while (custom.length > 20 && !fits(compose())) custom = custom.slice(0, -5);
    if (custom !== original) {
      custom = custom.replace(/\s+\S*$/, '').trimEnd() + '...';
      cut.push(`custom text shortened to ${custom.length} characters`);
    }
    if (!fits(compose())) {
      custom = '';
      cut.push('custom text removed');
    }
    text = compose();
  }
  if (!fits(text) && acc !== null) {
    acc = null;
    cut.push('accuracy removed');
    text = compose();
  }
  if (!fits(text) && who.length > 20) {
    who = who.slice(0, 20).trimEnd();
    cut.push('name shortened to 20 characters');
    text = compose();
  }
  const m = measure(text);
  return { text, encoding: m.encoding, segments: m.segments, units: m.units, cut };
}

/** The "I'm safe" follow-up sent to the same contacts after a cancelled SOS. */
function buildSafeSms({ name, triggeredAt }) {
  const text = `SafeTours: ${oneLine(name) || 'A SafeTours user'} is safe. Please ignore the SOS alert sent at ${formatIst(triggeredAt)}.`;
  const m = measure(text);
  return { text, encoding: m.encoding, segments: m.segments, units: m.units, cut: [] };
}

module.exports = { formatIst, measure, buildSosSms, buildSafeSms };
