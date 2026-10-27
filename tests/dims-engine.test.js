// Unit tests: dimension group quantities, schedules and merging take-offs of the same elements into one table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../public/js/engine.js';
import { baseValue, dimQuantity, groupTotal, groupToSpec, sameElements, mergeSpecs, mergeList, conversion, displayUnit } from '../public/js/dims.js';

const E = (id, q, extra = {}) => ({ id, cat: 'Structural Framing', fam: 'Beam', type: 'B-200X600', level: 'L1', mark: '', q, props: { Material: 'C40' }, ...extra });
const byId = new Map([
  [1, E(1, { Length: [4, 'm'], Volume: [0.48, 'm3'], 'Geo side area': [4.8, 'm2'], 'Geo bottom area': [0.8, 'm2'] })],
  [2, E(2, { Length: [5, 'm'], 'Geo volume': [0.6, 'm3'], 'Geo side area': [6, 'm2'], 'Geo bottom area': [1, 'm2'] })],
  [3, E(3, {})],
]);
const items = (ids, extra = {}) => ids.map(element_id => ({ element_id, sign: 1, multiplier: 1, ...(extra[element_id] || {}) }));

test('base value uses the chosen BIM quantity, then the usual ones', () => {
  const g = { mtype: 'Volume', props: {} };
  assert.equal(baseValue(g, byId.get(1)), 0.48);
  assert.equal(baseValue(g, byId.get(2)), 0.6);               // falls back to Geo volume
  assert.equal(baseValue(g, byId.get(3)), null);
  assert.equal(baseValue({ mtype: 'Volume', props: { quantity: 'Geo volume' } }, byId.get(2)), 0.6);
  assert.equal(baseValue({ mtype: 'Count', props: {} }, byId.get(3)), 1);
});

test('multiplier, offset, sign and width/height conversion (default display)', () => {
  const g = { mtype: 'Length', props: { multiplier: 2, offset: 0.5, display: 'Area', height: 3 } };
  assert.deepEqual(conversion(g), { display: 'Area', terms: ['Height'] });
  assert.equal(dimQuantity(g, 4, { sign: 1, multiplier: 1 }), (4 + 0.5) * 2 * 3);
  assert.equal(dimQuantity(g, 4, { sign: -1, multiplier: 2 }), -(4 + 0.5) * 2 * 2 * 3);
  // no height: shown as length, never as a zero area
  assert.equal(conversion({ mtype: 'Length', props: { display: 'Area', height: 0 } }).display, 'Length');
  const t = groupTotal({ mtype: 'Length', props: { measured: [{ value: 10, sign: -1, multiplier: 1 }] }, items: items([1, 2, 99]) }, byId);
  assert.equal(t.total, 4 + 5 - 10); assert.equal(t.absent, 1); assert.equal(t.unit, 'm');
});

test('Wall Area and Weight displays (CostX Default Display)', () => {
  const wall = { mtype: 'Length', props: { display: 'Wall Area', height: 2.4 } };
  assert.deepEqual(conversion(wall), { display: 'Wall Area', terms: ['Height'] });
  assert.equal(displayUnit(wall), 'm2');
  assert.equal(dimQuantity(wall, 10, { sign: 1, multiplier: 1 }), 24);
  // a weight is the quantity x the multiplier (weight per unit), in the group's weight unit
  const w = { id: 'w', name: 'Rebar T12', mtype: 'Length', items: items([1, 2]), props: { display: 'Weight', multiplier: 0.888, weightUom: 'kg' } };
  assert.equal(displayUnit(w), 'kg');
  assert.ok(Math.abs(groupTotal(w, byId).total - 9 * 0.888) < 1e-9);
  const spec = groupToSpec(w, byId);
  const ev = evaluate(spec, byId);
  assert.equal(spec.formulas.find(f => f.key === 'Qty').unit, 'kg');
  assert.ok(Math.abs(ev.tot.Qty - 9 * 0.888) < 1e-9);
  assert.equal(displayUnit({ mtype: 'Count', props: { display: 'Weight', weightUom: 't' } }), 't');
  assert.equal(displayUnit({ mtype: 'Count', props: { display: 'Weight' } }), 'kg');
  // a display the type cannot use falls back to the type
  assert.equal(conversion({ mtype: 'Area', props: { display: 'Wall Area', height: 3 } }).display, 'Area');
});

test('a dimension group becomes a schedule whose Excel formulas give the same total', () => {
  const g = { id: 'g', name: 'Beam formwork', mtype: 'Length', items: items([1, 2], { 2: { sign: -1 } }),
    props: { multiplier: 2, custom: [{ label: 'Formwork', unit: 'm2', expr: '{Geo_side_area} + {Geo_bottom_area}' }, { label: 'With waste', unit: 'm2', expr: '{C1} * {Waste}' }],
      variables: [{ name: 'Waste', value: 1.1, unit: '' }], measured: [{ label: 'Kicker on site', value: 3, sign: 1, multiplier: 1 }] } };
  const spec = groupToSpec(g, byId, { details: ['type', 'level', 'p:Material'], count: true });
  assert.deepEqual(spec.details, ['type', 'level', 'p:Material']);
  assert.deepEqual(spec.inputs.map(i => i.key), ['Count', 'Base', 'Factor', 'Geo_side_area', 'Geo_bottom_area']);
  assert.equal(spec.formulas[0].expr, '{Base} * {Multiplier} * {Factor}');
  const ev = evaluate(spec, byId);
  assert.equal(ev.tot.Qty, 4 * 2 - 5 * 2);                     // second beam is negative
  assert.equal(ev.tot.C1, 4.8 + 0.8 + 6 + 1);
  assert.ok(Math.abs(ev.tot.C2 - (4.8 + 0.8 + 6 + 1) * 1.1) < 1e-9);
  assert.deepEqual(spec.manual, [{ label: 'Kicker on site', v: { Base: 3, Factor: 1 } }]);
  assert.throws(() => groupToSpec({ ...g, props: { custom: [{ label: 'x', expr: '{Nope}' }] } }, byId), /Nope/);
});

test('take-offs of the same elements merge into one table with all columns', () => {
  const concrete = { name: 'Concrete to beams', ids: [1, 2], by: 'type', note: 'Volume from Revit',
    inputs: [{ key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true }, { key: 'V', label: 'Volume', unit: 'm3', source: 'property', name: 'Volume', sum: true }],
    constants: [], formulas: [{ key: 'F1', label: 'Concrete', unit: 'm3', expr: '{V}' }] };
  const formwork = { name: 'Formwork to beams', ids: [2, 1], by: 'level', note: 'Sides and soffit',
    inputs: [{ key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true }, { key: 'V', label: 'Side area', unit: 'm2', source: 'property', name: 'Geo side area', sum: true }],
    constants: [{ key: 'k', label: 'Waste', value: 1.05, unit: '' }], formulas: [{ key: 'F1', label: 'Formwork', unit: 'm2', expr: '{V} * {k}' }, { key: 'F2', label: 'Formwork rounded', unit: 'm2', expr: 'ROUND({F1}, 1)' }] };
  const rebar = { name: 'Reinforcement to beams', ids: [1, 2], inputs: [], constants: [{ key: 'k', label: 'Rate', value: 120, unit: 'kg/m3' }], formulas: [{ key: 'F1', label: 'Rebar', unit: 'kg', expr: '{k} * 0.5' }] };
  assert.ok(sameElements(concrete, formwork)); assert.ok(!sameElements(concrete, { ids: [1] }));
  const m = mergeSpecs(concrete, formwork);
  assert.equal(m.name, 'Concrete to beams / Formwork to beams'); assert.equal(m.by, 'type');
  assert.deepEqual(m.inputs.map(i => i.key), ['Count', 'V', 'V_2']);        // Count shared, clashing V renamed
  assert.deepEqual(m.formulas.map(f => [f.key, f.expr]), [['F1', '{V}'], ['F1_2', '{V_2} * {k}'], ['F2', 'ROUND({F1_2}, 1)']]);
  const ev = evaluate(m, byId);
  assert.equal(ev.tot.F1, 0.48); assert.ok(Math.abs(ev.tot.F1_2 - (4.8 + 6) * 1.05) < 1e-9);
  const all = mergeList([concrete, formwork, rebar, { name: 'Columns', ids: [3], inputs: [], constants: [], formulas: [] }]);
  assert.equal(all.length, 2);
  assert.equal(all[0].parts.length, 3); assert.equal(all[0].constants.find(c => c.label === 'Rate').key, 'k_2');
  assert.equal(all[0].formulas.find(f => f.label === 'Rebar').expr, '{k_2} * 0.5');
  assert.equal(evaluate(all[0], byId).tot[all[0].formulas.find(f => f.label === 'Rebar').key], 120);
  // merging the same take-off twice adds nothing
  assert.equal(mergeSpecs(m, formwork).formulas.length, m.formulas.length);
});

test('merged columns never share a heading', () => {
  const a = { name: 'Formwork to beams (exact geometry)', ids: [1, 2], inputs: [], constants: [], formulas: [{ key: 'FW', label: 'Formwork', unit: 'm2', expr: '2' }] };
  const b = { name: 'Formwork to concrete beams', ids: [1, 2], inputs: [{ key: 'L', label: 'Length', unit: 'm', source: 'property', name: 'Length', sum: true }], constants: [],
    formulas: [{ key: 'FW', label: 'Formwork', unit: 'm2', expr: '{L} * 3' }] };
  const m = mergeSpecs(a, b);
  const heads = [...m.inputs, ...m.formulas].map(c => `${c.label} (${c.unit})`);
  assert.equal(new Set(heads).size, heads.length);
  assert.equal(m.formulas[1].label, 'Formwork - Formwork to concrete beams');
  assert.equal(m.formulas[1].expr, '{L} * 3');
});

test('headings that are already unique are kept as they are', () => {
  const a = { name: 'A', ids: [1], inputs: [{ key: 'V', label: 'Volume', unit: 'm3', source: 'property', name: 'Volume', sum: true }], constants: [], formulas: [] };
  const b = { name: 'B', ids: [1], inputs: [{ key: 'S', label: 'Geo side area', unit: 'm2', source: 'property', name: 'Geo side area', sum: true }], constants: [], formulas: [{ key: 'F', label: 'Formwork', unit: 'm2', expr: '{S}' }] };
  const m = mergeSpecs(a, b);
  assert.deepEqual([...m.inputs, ...m.formulas].map(c => c.label), ['Volume', 'Geo side area', 'Formwork']);
});
