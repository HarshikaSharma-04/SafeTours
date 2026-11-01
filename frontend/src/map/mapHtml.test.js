const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { buildMapHtml, pageScript } = require('./mapHtml');

test('the page script is valid JavaScript with every placeholder filled in', () => {
  const script = pageScript();
  assert.doesNotMatch(script, /__[A-Z]+__/);
  assert.doesNotThrow(() => new vm.Script(script));
});

test('the page carries Leaflet inline and has no script or stylesheet to fetch', () => {
  const html = buildMapHtml();
  assert.match(html, /Leaflet 1\.9\.4/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+href=/);
});

test('no tile source needs an API key, and the watermarked CARTO source is gone', () => {
  const script = pageScript();
  assert.doesNotMatch(script, /api[_-]?key|access_token/i);
  assert.doesNotMatch(script, /cartocdn/);
  assert.match(script, /tile\.openstreetmap\.org/);
});

test('every tile source credits its data, as their terms require', () => {
  const script = pageScript();
  assert.match(script, /© OpenStreetMap contributors/);
  assert.match(script, /Imagery © Esri/);
});

test('text from reports only reaches the page through textContent, never innerHTML', () => {
  const script = pageScript();
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML/);
});

test('no screen uses StyleSheet.absoluteFillObject: React Native removed it, so the map would silently have no size', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(js|jsx)$/.test(e.name) && !e.name.endsWith('.test.js') ? [full] : [];
  });
  const offenders = walk(path.join(__dirname, '..')).filter((f) => /StyleSheet\.absoluteFillObject/.test(fs.readFileSync(f, 'utf8')));
  assert.deepStrictEqual(offenders, []);
});

test('a startup error is reported to the app: the error hook runs before Leaflet', () => {
  const html = buildMapHtml();
  const hook = html.indexOf('window.onerror');
  const lib = html.indexOf('Leaflet 1.9.4');
  assert.ok(hook > -1 && hook < lib);
});
