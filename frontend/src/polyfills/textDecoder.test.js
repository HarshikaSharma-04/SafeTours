const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installTextDecoderFix, Utf16LeDecoder } = require('./textDecoder');

// Behaves like the TextDecoder Expo installs on phones: UTF-8 only, anything else throws.
class Utf8OnlyDecoder {
  constructor(label = 'utf-8') {
    if (!['utf-8', 'utf8'].includes(String(label).toLowerCase())) {
      throw new RangeError(`Unknown encoding: ${label}`);
    }
  }

  decode(input) {
    return Buffer.from(input).toString('utf8');
  }
}

test('utf-16le works and utf-8 still goes to the original decoder', () => {
  const target = { TextDecoder: Utf8OnlyDecoder };
  assert.strictEqual(installTextDecoderFix(target), true);
  const bytes = new Uint8Array([0x68, 0, 0x69, 0, 0x15, 0x09]);
  assert.strictEqual(new target.TextDecoder('utf-16le').decode(bytes), 'hiक');
  assert.strictEqual(new target.TextDecoder().decode(Buffer.from('héllo')), 'héllo');
  assert.ok(new target.TextDecoder() instanceof Utf8OnlyDecoder);
});

test('an encoding nobody supports still throws', () => {
  const target = { TextDecoder: Utf8OnlyDecoder };
  installTextDecoderFix(target);
  assert.throws(() => new target.TextDecoder('shift-jis'), RangeError);
});

test('nothing changes where utf-16 already works, or where there is no TextDecoder', () => {
  const full = { TextDecoder };
  assert.strictEqual(installTextDecoderFix(full), false);
  assert.strictEqual(full.TextDecoder, TextDecoder);
  assert.strictEqual(installTextDecoderFix({}), false);
});

test('decode handles a byte order mark, an odd trailing byte, empty input and long text', () => {
  const decoder = new Utf16LeDecoder();
  assert.strictEqual(decoder.decode(new Uint8Array([0xff, 0xfe, 0x41, 0])), 'A');
  assert.strictEqual(decoder.decode(new Uint8Array([0x41, 0, 0x42])), 'A');
  assert.strictEqual(decoder.decode(), '');
  const long = 'x'.repeat(100000);
  assert.strictEqual(decoder.decode(Buffer.from(long, 'utf16le')), long);
});

test('index.js loads this fix before anything that reaches h3-js', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
  const fix = source.indexOf('./src/polyfills/textDecoder');
  assert.ok(fix > -1, 'index.js must import the fix');
  assert.ok(fix < source.indexOf('./src/utils/backgroundGeofence'));
  assert.ok(fix < source.indexOf('./App'));
});

test('h3-js loads and works when the only decoder is UTF-8, as on a phone', () => {
  const file = require.resolve('h3-js');
  const sandbox = { console, TextDecoder: Utf8OnlyDecoder, module: { exports: {} } };
  sandbox.exports = sandbox.module.exports;
  sandbox.globalThis = sandbox;
  installTextDecoderFix(sandbox);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox);
  const h3 = sandbox.module.exports;
  const cell = h3.latLngToCell(19.0596, 72.8295, 9);
  assert.strictEqual(cell, '89608b0b13bffff');
  assert.strictEqual(h3.cellToBoundary(cell).length, 6);
  assert.strictEqual(h3.gridDisk(cell, 1).length, 7);
});

test('without the fix, h3-js throws at load on a UTF-8 only decoder (the crash this prevents)', () => {
  const file = require.resolve('h3-js');
  const sandbox = { console, TextDecoder: Utf8OnlyDecoder, module: { exports: {} } };
  sandbox.exports = sandbox.module.exports;
  assert.throws(() => vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox), /Unknown encoding/);
});
