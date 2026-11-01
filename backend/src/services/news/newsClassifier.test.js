const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyArticle } = require('./newsClassifier');

const hazard = (title, description = '') => classifyArticle({ title, description })?.hazard ?? null;

test('real hazard headlines are classified', () => {
  assert.equal(hazard('Massive fire breaks out at Andheri factory'), 'fire');
  assert.equal(hazard('Cylinder blast in Kurla chawl, 3 injured'), 'explosion');
  assert.equal(hazard('Building collapse in Dongri: rescue underway'), 'collapse');
  assert.equal(hazard('Waterlogging in Sion after heavy rain'), 'flood');
  assert.equal(hazard('Flash floods hit low-lying areas of Mumbai'), 'flood');
  assert.equal(hazard('Truck collision on Eastern Express Highway near Ghatkopar'), 'accident');
  assert.equal(hazard('Man stabbed in Bandra'), 'violence');
  assert.equal(hazard('Chain snatching incidents rise in Borivali'), 'robbery');
  assert.equal(hazard('Protest march blocks road near CSMT'), 'protest');
  assert.equal(hazard('Fire at Andheri warehouse, two dead'), 'fire');
  assert.equal(hazard('Fire in Dadar building: 12 rescued'), 'fire');
});

test('the highest-severity hazard wins', () => {
  assert.equal(hazard('Protest turns violent as fire breaks out and a building collapses'), 'collapse');
});

test('"flood of tourists" and similar figurative uses are NOT hazards', () => {
  assert.equal(hazard('Mumbai sees a flood of tourists this Diwali'), null);
  assert.equal(hazard('Helpline flooded with calls after outage'), null);
  assert.equal(hazard('Floods of orders hit Mumbai restaurants'), null);
});

test('other common false positives are excluded', () => {
  assert.equal(hazard('BJP wins by a landslide victory in Mumbai ward'), null);
  assert.equal(hazard('Sensex crash wipes out gains'), null);
  assert.equal(hazard('Minister comes under fire over pothole remarks'), null);
  assert.equal(hazard('Fire drill held at Mumbai school'), null);
  assert.equal(hazard('Film trailer shows fire scene in Andheri set'), null);
});

test('negated mentions are ignored', () => {
  assert.equal(hazard('BMC says no flooding reported despite heavy rain'), null);
  assert.equal(hazard('Fire department denies fire at Bandra mall, calls it a rumour'), null);
});

test('non-hazard news is not classified', () => {
  assert.equal(hazard('Mumbai Indians win by five wickets'), null);
  assert.equal(hazard('New metro line opens in Andheri'), null);
});

test('court and compensation stories about a past event are not a live hazard', () => {
  assert.strictEqual(classifyArticle({ title: 'Dadar boys orphaned in Eway crash get 3cr, not 6.5cr, as dad 70% liable' }), null);
  assert.strictEqual(classifyArticle({ title: 'Man convicted over 2019 Bandra building fire' }), null);
  assert.ok(classifyArticle({ title: 'Fire breaks out at Kurla building' }));
});
