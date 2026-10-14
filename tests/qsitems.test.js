// Unit tests: element classification, QS measure items by rule set, and the formulas behind each column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../public/js/engine.js';
import { kindOf, materialOf, steelMass, qsSetup, guessGroundLevel } from '../public/js/rules.js';
import { structuralSpecs, ITEMS, itemIds, itemSpecs } from '../public/js/qsitems.js';

const conc = { 'Structural Material': 'KEO_ST-CIP Concrete 40 MPa' };
const el = (id, cat, type, q, extra = {}) => ({ id, cat, fam: cat, type, level: 'L1', mark: '', props: conc, q: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, [v, k.includes('level') || k.includes('Thickness') || k.includes('length') || k.includes('perimeter') || k === 'Outer face bottom' || k === 'Outer face top' ? 'm' : k.includes('volume') ? 'm3' : 'm2']])), ...extra });
// a suspended slab 6 x 8 x 0.2 (soffit 46.2 m2 at 3.0 m propping, 28 m of 200 mm edges), a 300 thick slab, a beam, a wall, a footing, a roof slab
const E = [
  el(1, 'Floors', 'Slab 200', { 'Net volume': 9.6, 'Thickness (geometry)': 0.2, 'FW soffit': 46.2, 'FW soffit 0-3 m': 46.2, 'FW narrow length': 28, 'FW sides': 5.6, 'Geo bottom area': 48, 'Geo top area': 48, 'Top exposed': 0 }),
  el(2, 'Floors', 'Slab 350', { 'Net volume': 16.8, 'Thickness (geometry)': 0.35, 'FW soffit': 48, 'FW soffit 3-4.5 m': 48, 'FW narrow length': 28, 'Geo bottom area': 48, 'Geo top area': 48 }),
  el(3, 'Structural Framing', 'B-300X600', { 'Net volume': 0.9, 'Thickness (geometry)': 0.3, 'FW soffit': 1.8, 'FW sides': 6.3, 'Geo bottom area': 1.8 }),
  el(4, 'Walls', 'RC Wall 300', { 'Net volume': 9, 'Thickness (geometry)': 0.3, 'FW wide sides': 60, 'FW narrow length': 6, 'Outer face area': 30, 'Outer face bottom': -3, 'Outer face top': 0 }),
  el(5, 'Structural Foundations', 'F1 1500x1500x500', { 'Net volume': 1.125, 'Thickness (geometry)': 0.5, 'FW narrow length': 6, 'FW sides': 3, 'Area on ground': 2.25, 'Geo box height': 0.5, 'Geo box length': 1.5, 'Geo box width': 1.5, 'Bottom level': -3.5 }),
  el(6, 'Floors', 'Roof slab 250', { 'Net volume': 12, 'Thickness (geometry)': 0.25, 'FW soffit': 48, 'FW soffit 3-4.5 m': 48, 'Top exposed': 48, 'Geo top area': 48, 'Geo bottom area': 48, 'Exposed perimeter': 28 }),
  el(7, 'Floors', 'Ground slab 150', { 'Net volume': 15, 'Thickness (geometry)': 0.15, 'Area on ground': 100, 'Geo bottom area': 100, 'Top level': 0, 'FW narrow length': 40 }),
  { id: 8, cat: 'Structural Framing', fam: 'UK Beams', type: 'UKB127x76x13', level: 'L1', mark: '', props: { 'Structural Material': 'Metal - Steel 43-275' }, q: { 'Cut Length': [4, 'm'] } },
];
const byId = new Map(E.map(e => [e.id, e]));
const tot = (spec) => { const ev = evaluate(spec, byId); return Object.fromEntries([...spec.inputs, ...spec.formulas].map(c => [c.label, ev.tot[c.key]])); };

test('classification as a QS sees it', () => {
  assert.deepEqual(E.map(kindOf), ['slab', 'slab', 'beam', 'wall', 'footing', 'roofslab', 'groundslab', 'beam']);
  assert.equal(materialOf(E[0]), 'insitu'); assert.equal(materialOf(E[7]), 'steel');
  assert.equal(steelMass('UKB127x76x13'), 13); assert.equal(steelMass('UC 203x203x46'), 46);
  assert.equal(guessGroundLevel(E), 0);
});

test('NRM2: slabs split by thickness, soffits by propping height, edges in metres', () => {
  const [{ spec }] = structuralSpecs([1, 2], byId, { set: 'NRM2', setup: {} });
  const t = tot(spec);
  assert.equal(t['Horizontal work, not exceeding 300 mm thick'], 9.6);
  assert.equal(t['Horizontal work, exceeding 300 mm thick'], 16.8);
  assert.equal(t['Soffits of horizontal work, propping height 0 to 3 m'], 46.2);
  assert.equal(t['Soffits of horizontal work, propping height 3 to 4.5 m'], 48);
  assert.equal(t['Edges of horizontal work, not exceeding 500 mm high'], 56);
  assert.ok(Math.abs(t['Bar reinforcement (allowance from kg/m3 rate until the bar schedule is available)'] - (9.6 + 16.8) * 100 / 1000) < 1e-9);
  const cols = [...spec.formulas];
  assert.ok(cols.every(c => c.rule?.set === 'NRM2' && c.rule.ref.startsWith('NRM2')));
  assert.equal(cols.find(c => c.label.startsWith('Soffits')).rule.nrm1, '2.2');
});

test('POMI: element classes, soffits not split, edges in metres', () => {
  const [{ spec }] = structuralSpecs([1, 2], byId, { set: 'POMI' });
  const t = tot(spec);
  assert.equal(t['Concrete in suspended slabs, thickness stated'], 26.4);
  assert.equal(t['Formwork to soffits of slabs'], 94.2);
  assert.equal(t['Formwork to edges of slabs, height stated'], 56);
  assert.ok(!spec.formulas.some(f => /propping/.test(f.label)));
});

test('beams, walls with waterproofing below ground, footings earth-faced or formed', () => {
  const beam = structuralSpecs([3], byId, { set: 'NRM2' })[0].spec;
  assert.equal(tot(beam)['Sides of beams'], 6.3); assert.equal(tot(beam)['Soffits of beams'], 1.8);
  const wall = structuralSpecs([4], byId, { set: 'NRM2', setup: { groundLevel: 0, wpUpturn: 0.15 } })[0].spec;
  const tw = tot(wall);
  assert.equal(tw['Walls, vertical'], 60); assert.equal(tw['Wall ends, not exceeding 500 mm wide'], 6);
  // outer face 3 m high from -3 to 0, waterproofing to ground level + 150 mm upturn: all 30 m2 (capped at the face top)
  assert.equal(tw['Waterproofing, vertical, outer face of walls below ground'], 30);
  const wall2 = structuralSpecs([4], byId, { set: 'NRM2', setup: { groundLevel: -1, wpUpturn: 0.15 } })[0].spec;
  assert.ok(Math.abs(tot(wall2)['Waterproofing, vertical, outer face of walls below ground'] - 30 * (2.15 / 3)) < 1e-9);
  const formed = structuralSpecs([5], byId, { set: 'NRM2', setup: { earthFaced: false } })[0].spec;
  assert.equal(tot(formed)['Sides of foundations and bases, not exceeding 500 mm high'], 6);
  assert.equal(tot(formed)['Waterproofing, horizontal (flat), under foundations and slabs'], 2.25);
  const earth = structuralSpecs([5], byId, { set: 'NRM2', setup: { earthFaced: true } })[0].spec;
  assert.equal(tot(earth)['Sides of foundations and bases, not exceeding 500 mm high'], 0);
  assert.equal(earth.constants.find(c => c.key === 'Earth').value, 1);       // a yellow cell the QS can change
});

test('roof slabs: waterproofing and upstands; steel by section mass; NRM1 element quantities', () => {
  const roof = tot(structuralSpecs([6], byId, { set: 'NRM2', setup: { roofUpturn: 0.3 } })[0].spec);
  assert.equal(roof['Waterproofing, horizontal (flat), roof'], 48);
  assert.equal(roof['Upstands and skirtings, girth not exceeding 500 mm, girth 300 mm'], 28);
  const steel = structuralSpecs([8], byId, { set: 'NRM2' })[0];
  assert.equal(steel.kind, 'steel'); assert.ok(Math.abs(tot(steel.spec)['Structural steel members'] - 4 * 13 / 1000) < 1e-12);
  const n1 = structuralSpecs([1, 7], byId, { set: 'NRM1' });
  const slab = n1.find(x => x.kind === 'slab').spec, ground = n1.find(x => x.kind === 'groundslab').spec;
  assert.equal(tot(ground)['Element unit quantity: Lowest floor area'], 100);
  assert.equal(slab.formulas.find(f => f.key === 'Conc').rule.nrm1, '2.2');
  assert.ok(Math.abs(tot(slab).Formwork - (46.2 + 5.6)) < 1e-9);            // soffit + edges
});

test('the library has 60 items and simple items keep only columns the elements have', () => {
  assert.equal(ITEMS.length, 60);
  const applyFilter = (f) => E.filter(e => !f.category || f.category.includes(e.cat)).map(e => e.id);
  const item = ITEMS.find(i => i.id === 'sb-excavation');
  const ids = itemIds(item, E, applyFilter);
  assert.deepEqual(ids, [5, 7]);
  const [spec] = itemSpecs(item, ids, byId, { setup: { groundLevel: 0 } });
  const ev = evaluate(spec, byId);
  // footing 2.25 m2 x 3.5 m deep + ground slab (bottom level missing -> no excavation)
  assert.equal(ev.tot.F1, 2.25 * 3.5);
  assert.equal(qsSetup({}).ruleSet, 'NRM2');
});
