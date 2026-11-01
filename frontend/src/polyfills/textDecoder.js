/**
 * Makes `new TextDecoder('utf-16le')` work on phones.
 *
 * h3-js (the hexagon grid behind risk cells and geofencing) creates that decoder as soon as it loads. The TextDecoder
 * Expo installs only knows UTF-8 and throws for anything else, so the app crashed before its first screen.
 * This adds UTF-16LE and leaves every other encoding to the original.
 *
 * It must run before h3-js loads: index.js imports this file before anything that reaches h3-js.
 * Plain CommonJS so `node --test` can run it.
 */
const UTF16LE_LABELS = new Set(['utf-16le', 'utf-16', 'utf16le', 'utf16', 'ucs-2', 'ucs2', 'unicode', 'csunicode']);
const CHUNK_UNITS = 8192; // String.fromCharCode takes its arguments on the stack, so long input goes in pieces

class Utf16LeDecoder {
  get encoding() {
    return 'utf-16le';
  }

  get fatal() {
    return false;
  }

  get ignoreBOM() {
    return false;
  }

  decode(input) {
    if (input === undefined) return '';
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    const count = bytes.length >> 1; // a trailing odd byte is not a whole character
    let text = '';
    for (let start = 0; start < count; start += CHUNK_UNITS) {
      const end = Math.min(count, start + CHUNK_UNITS);
      const units = new Array(end - start);
      for (let i = start; i < end; i += 1) units[i - start] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
      text += String.fromCharCode.apply(null, units);
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }
}

function supportsUtf16(Decoder) {
  try {
    new Decoder('utf-16le'); // eslint-disable-line no-new
    return true;
  } catch (error) {
    return false;
  }
}

/** Does nothing where UTF-16 already works (the web) or where there is no TextDecoder at all (h3-js checks for that). */
function installTextDecoderFix(target = globalThis) {
  const Original = target.TextDecoder;
  if (typeof Original !== 'function' || supportsUtf16(Original)) return false;

  function TextDecoder(label = 'utf-8', options) {
    if (UTF16LE_LABELS.has(String(label).trim().toLowerCase())) return new Utf16LeDecoder();
    return new Original(label, options);
  }
  TextDecoder.prototype = Original.prototype;

  Object.defineProperty(target, 'TextDecoder', { value: TextDecoder, configurable: true, writable: true, enumerable: false });
  return true;
}

installTextDecoderFix();

module.exports = { installTextDecoderFix, Utf16LeDecoder };
