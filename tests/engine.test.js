import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dimsOf, keyOf, compile, evaluate } from '../public/js/engine.js';

const byId = new Map([
  [1, { id: 1, type: 'B-200X750', name: 'Beam', q: { 'Cut Length': [4, 'm'] } }],
  [2, { id: 2, type: 'B-300x600', name: 'Beam', q: { 'Cut Length': [2.5, 'm'] } }],
  [3, { id: 3, type: 'No size', name: 'Beam', q: {} }],
]);
const beamFormwork = {
  name: 'Beam formwork', ids: [1, 2, 3], by: 'type', note: '',
  inputs: [
    { key: 'n', label: 'Count', unit: 'nr', source: 'count', sum: true },
    { key: 'L', label: 'Cut length', unit: 'm', source: 'property', name: 'Cut Length', sum: true },
    { key: 'b', label: 'Width', unit: 'm', source: 'type_dim', index: 0 },
    { key: 'h', label: 'Depth', unit: 'm', source: 'type_dim', index: 1 },
  ],
  constants: [{ key: 'slab', label: 'Slab', value: 0.2, unit: 'm' }],
  formulas: [
    { key: 'soffit', label: 'Soffit', unit: 'm2', expr: '{b} * {L}' },
    { key: 'sides', label: 'Sides', unit: 'm2', expr: '2 * MAX({h} - {slab}, 0) * {L}' },
    { key: 'FW', label: 'Total', unit: 'm2', expr: '{soffit} + {sides}' },
  ],
};

test('sizes from type names in metres', () => {
  assert.deepEqual(dimsOf('KEO-B-200X750'), [0.2, 0.75]);
  assert.deepEqual(dimsOf('PC_1300x900x800'), [1.3, 0.9, 0.8]);
  assert.deepEqual(dimsOf('Generic - 200'), []);
});
test('column keys are safe identifiers', () => {
  assert.equal(keyOf('Face area (L x H)'), 'Face_area_L_x_H');
  assert.equal(keyOf('2nd value'), 'q_2nd_value');
});
test('beam formwork evaluates exactly and totals only summable columns', () => {
  const { rows, tot, missing } = evaluate(beamFormwork, byId);
  const r1 = rows[0].v;
  assert.equal(+r1.soffit.toFixed(6), 0.8);            // 0.2 x 4
  assert.equal(+r1.sides.toFixed(6), 4.4);             // 2 x 0.55 x 4
  assert.equal(+tot.FW.toFixed(6), +(0.8 + 4.4 + 0.75 + 2).toFixed(6));
  assert.equal(tot.n, 3);
  assert.equal(tot.b, undefined);                      // widths are never totalled
  assert.equal(rows[2].v.FW, null);                    // missing size gives no value, not zero
  assert.equal(missing.b, 1);
});
test('formula safety: unknown keys and code are rejected', () => {
  assert.throws(() => compile('{x} * 2', ['a']), /Unknown column/);
  assert.throws(() => compile('alert(1)', []), /unsupported/);
  assert.throws(() => compile('{a}.constructor', ['a']), /unsupported/);
  assert.equal(compile('IF({a} > 1, 10, 20)', ['a'])({ a: 2 }, { IF: (c, x, y) => (c ? x : y) }), 10);
});
