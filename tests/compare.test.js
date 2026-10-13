import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareModels } from '../src/compare.js';
import { scoreCase } from '../src/aieval.js';

const el = (id, over = {}) => ({ id, cat: 'Structural Framing', fam: 'Beam', type: 'B-200X600', level: 'L1', q: { Volume: [1, 'm3'], 'Cut Length': [4, 'm'] }, bb: [0, 0, 0, 1, 1, 1], ...over });

test('revision compare finds added, removed, changed and quantity differences', () => {
  const a = { elements: [el(1), el(2), el(3)] };
  const b = { elements: [el(1), el(2, { q: { Volume: [1.5, 'm3'], 'Cut Length': [6, 'm'] } }), el(4, { cat: 'Walls' })] };
  const r = compareModels(a, b);
  assert.deepEqual(r.summary, { added: 1, removed: 1, changed: 1, unchanged: 1 });
  assert.equal(r.changed[0].id, 2);
  assert.ok(r.changed[0].changes.some(c => c.field === 'Volume' && Math.abs(c.delta - 0.5) < 1e-9));
  const vol = r.quantities.find(x => x.category === 'Structural Framing' && x.quantity === 'Volume');
  assert.equal(vol.delta, -0.5);            // 3 m3 before, 2.5 m3 after (one beam removed, one bigger)
});
test('small rounding differences and unchanged positions are not reported', () => {
  const a = { elements: [el(1)] }, b = { elements: [el(1, { q: { Volume: [1.0004, 'm3'], 'Cut Length': [4, 'm'] }, bb: [0, 0, 0.005, 1, 1, 1] })] };
  assert.equal(compareModels(a, b).summary.changed, 0);
});
test('type change and movement are reported', () => {
  const a = { elements: [el(1)] }, b = { elements: [el(1, { type: 'B-300X600', bb: [0.5, 0, 0, 1.5, 1, 1] })] };
  const ch = compareModels(a, b).changed[0].changes.map(c => c.field);
  assert.ok(ch.includes('type') && ch.includes('position'));
});

const data = { elements: [el(1), el(2), el(3, { cat: 'Floors', type: 'Slab 200' })] };
data.byId = new Map(data.elements.map(e => [e.id, e]));
test('AI test set scoring passes a correct plan', () => {
  const c = { expect: { categories: ['Structural Framing'], properties_any: [['Volume', 'Geo volume']] } };
  const plan = { groups: [{ name: 'Beams', filter: { category: ['Structural Framing'] }, inputs: [{ key: 'V', source: 'property', name: 'Volume', sum: true }] }] };
  assert.equal(scoreCase(c, plan, data).pass, true);
});
test('AI test set scoring fails wrong categories, hidden constants and guessing', () => {
  const c = { expect: { categories: ['Structural Framing'], constant_any: [150] } };
  const plan = { groups: [{ name: 'All', filter: {}, inputs: [{ key: 'V', source: 'property', name: 'Volume', sum: true }], formulas: [{ key: 'kg', expr: '{V} * 150' }] }] };
  const r = scoreCase(c, plan, data);
  assert.equal(r.pass, false);
  assert.ok(r.reasons.some(x => /other categories/.test(x)) && r.reasons.some(x => /editable constant/.test(x)));
  assert.equal(scoreCase({ expect: { ask: true } }, plan, data).pass, false);
  assert.equal(scoreCase({ expect: { ask: true } }, { groups: [], question: 'Which elements?' }, data).pass, true);
});
