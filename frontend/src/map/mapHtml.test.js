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
