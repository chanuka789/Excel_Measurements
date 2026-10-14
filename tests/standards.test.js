import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { stableKey } from '../public/js/stableKey.js';
import { CATALOGUES, STANDARD_IDS, DEFAULT_PROFILE, validateProfile, ancestors, headingPath, naturalCompare, classify, elementKey } from '../public/js/standards.js';
import { RULES, nrm1Name } from '../public/js/rules.js';
import { bandOf, proppingBand, quantityBand } from '../public/js/sizeBander.js';
import { calculateFormwork, measuredArea } from '../public/js/formworkCalculator.js';
import { parameterColumns, buildSchedule, csvText } from '../public/js/scheduleExporter.js';
import { readQuantity, buildLedger, groupLedger, boqLayout, basisLayout, elementalLayout, takeoffLayout } from '../public/js/standardsBOQ.js';

const slab = (id, thickness = 0.2, volume = 9.6) => ({ id, guid: 'guid-' + id, cat: 'Floors', fam: 'Concrete slab', type: `RC slab ${thickness * 1000}`, level: 'L1', mark: '',
  props: { 'Structural Material': 'Concrete C40' }, q: { Volume: [volume, 'm3'], 'Thickness': [thickness * 1000, 'mm'], 'FW soffit': [48, 'm2'], 'FW narrow length': [28, 'm'], 'Propping height': [3, 'm'] } });

test('source heading catalogues are complete, unique and parent-valid; browser and JSON agree', () => {
  assert.equal(CATALOGUES.POMI.sections.length, 17); assert.equal(CATALOGUES.POMI.topics.length, 117);
  assert.equal(CATALOGUES.NRM1.sections.length, 279); assert.equal(CATALOGUES.NRM2.sections.length, 41);
  const files = { POMI: 'pomi-1979-reprint', NRM1: 'nrm1-2021', NRM2: 'nrm2-2021' };
  for (const std of STANDARD_IDS) {
    assert.deepEqual(CATALOGUES[std], JSON.parse(fs.readFileSync(new URL(`../rules/catalogues/${files[std]}.json`, import.meta.url))));
    const nodes = [...CATALOGUES[std].sections, ...(CATALOGUES[std].topics || [])];
    assert.equal(new Set(nodes.map(n => n.code)).size, nodes.length);
    for (const n of nodes) if (n.parent) assert.ok(nodes.some(p => p.code === n.parent), `${std}:${n.code}`);
  }
  assert.equal(nrm1Name('5.10.10'), 'Other lift and conveyor installations');
  assert.deepEqual(ancestors('POMI', 'C4').map(n => n.code), ['C', 'C4']);
  assert.deepEqual(ancestors('NRM1', '2.2.1').map(n => n.code), ['2', '2.2', '2.2.1']);
  assert.ok(naturalCompare('5.9', '5.10') < 0);
  assert.throws(() => ancestors('NRM2', '42'), /Unknown/);
});

test('existing structural rule dictionary uses checked source table numbers', () => {
  assert.equal(RULES.NRM2['fw.soffit'].ref, 'NRM2 WS11 / item 16');
  assert.equal(RULES.NRM2['fw.soffit.slope'].ref, 'NRM2 WS11 / item 18');
  assert.equal(RULES.NRM2['fw.fdn.narrow'].ref, 'NRM2 WS11 / item 14');
  assert.equal(RULES.NRM2['fw.edge.narrow'].ref, 'NRM2 WS11 / item 15');
  assert.match(RULES.NRM2['fw.wall'].ref, /23.*wall-face/);
});

test('all nine heading pairs and six triple orders change presentation only', () => {
  const ledger = buildLedger([slab(1), slab(2, 0.25, 10)], DEFAULT_PROFILE).records;
  const totals = [];
  for (const primary of STANDARD_IDS) for (const secondary of STANDARD_IDS) {
    const profile = { ...DEFAULT_PROFILE, primary, secondary }, groups = groupLedger(ledger, profile);
    totals.push(groups.reduce((n, g) => n + g.quantity, 0));
    assert.equal(new Set(groups[0].path.map(n => n.standard)).size, primary === secondary ? 1 : 2);
    for (const basis of STANDARD_IDS) {
      const choice = { ...profile, basis, purpose: basis === 'NRM1' ? 'costplan' : 'boq' };
      assert.doesNotThrow(() => validateProfile(choice));
    }
  }
  assert.ok(totals.every(t => t === 19.6));
  const keys = groupLedger(ledger, DEFAULT_PROFILE).map(g => g.key);
  let count = 0;
  for (const primary of STANDARD_IDS) for (const secondary of STANDARD_IDS.filter(s => s !== primary)) {
    const tertiary = STANDARD_IDS.find(s => s !== primary && s !== secondary);
    const profile = { ...DEFAULT_PROFILE, primary, secondary, tertiary };
    assert.deepEqual(groupLedger(ledger, profile).map(g => g.key).sort(), [...keys].sort()); count++;
  }
  assert.equal(count, 6);
  assert.throws(() => validateProfile({ ...DEFAULT_PROFILE, basis: 'NRM1' }), /cost-plan/);
  assert.throws(() => validateProfile({ ...DEFAULT_PROFILE, rebar: true, ratio: NaN }), /ratio/);
});

test('official band equalities and next stages are deterministic', () => {
  assert.equal(bandOf(0.3, [0.3]).index, 0); assert.equal(bandOf(0.301, [0.3]).index, 1);
  assert.equal(bandOf(0.45, [0.3, 0.45]).index, 1);
  assert.equal(proppingBand(3).upper, 3); assert.equal(proppingBand(4.5).upper, 4.5); assert.equal(proppingBand(4.6).upper, 6);
  assert.equal(proppingBand(15.1).upper, 16.5); assert.equal(bandOf(null, [0.3]), null);
  assert.equal(quantityBand('concrete', 'POMI', { thickness: 0.2 }), '');
});

test('formwork geometry formulas remain provisional and reject invalid deductions', () => {
  assert.equal(calculateFormwork({ kind: 'footing', width: 1.5, depth: 1.5, height: 0.5 }).area, 3);
  assert.ok(Math.abs(calculateFormwork({ kind: 'attached-beam', width: 0.3, depth: 0.6, slabThickness: 0.2, length: 4 }).area - 4.4) < 1e-9);
  assert.equal(calculateFormwork({ kind: 'wall', length: 5, height: 3, depth: 0.2, formedSides: 1 }).area, 16.2);
  assert.ok(Math.abs(calculateFormwork({ kind: 'circular-column', diameter: 0.5, height: 3 }).area - Math.PI * 1.5) < 1e-9);
  assert.equal(calculateFormwork({ kind: 'footing', earthCast: true }).area, 0);
  assert.equal(calculateFormwork({ kind: 'attached-beam', width: 0.3, depth: 0.6, length: 4 }).area, null);
  assert.throws(() => calculateFormwork({ kind: 'column', width: 0.3, depth: 0.3, height: 3, intersectionArea: 10 }), /exceeds/);
  assert.throws(() => calculateFormwork({ kind: 'column', clearHeight: -1 }), /height/);
});

test('POMI and NRM2 area retention differ at exact thresholds; edge voids are distinct', () => {
  assert.equal(measuredArea(20, [{ area: 0.9 }, { area: 1 }, { area: 0.5, atEdge: true }], 'POMI', 'formwork').quantity, 20.9);
  assert.equal(measuredArea(20, [{ area: 5 }, { area: 5.1 }], 'NRM2', 'formwork').quantity, 25);
  assert.match(measuredArea(20, undefined, 'NRM2', 'formwork').issues[0], /topology/);
  assert.throws(() => measuredArea(20, [{ area: -1 }], 'POMI', 'formwork'), /area/);
});

test('schedule scans union of parameters; dimension columns describe, totals never hide missing members', () => {
  const a = slab(1), b = { ...slab(2), type: a.type, q: { ...a.q, Volume: [4, 'm3'] }, props: { ...a.props, Note: 'Additional parameter' } };
  const columns = parameterColumns([a, b]); assert.ok(columns.some(c => c.name === 'Note'));
  const use = columns.filter(c => c.key === 'type' || c.key === 'count' || c.name === 'Thickness' || c.name === 'Volume');
  const rows = buildSchedule([a, b], use, { mode: 'grouped' }); assert.equal(rows.length, 1);
  assert.equal(rows[0].values[use.findIndex(c => c.name === 'Thickness')], 200);
  assert.equal(rows[0].values[use.findIndex(c => c.name === 'Volume')], 13.6);
  const missing = { ...b, q: { ...b.q } }; delete missing.q.Volume;
  assert.equal(buildSchedule([a, missing], use, { mode: 'grouped' })[0].values[use.findIndex(c => c.name === 'Volume')], null);
  assert.equal(buildSchedule([a, { ...b, q: { ...b.q, Thickness: [250, 'mm'] } }], use, { mode: 'grouped' }).length, 2);
  assert.equal(buildSchedule([a, { ...b, props: { ...b.props, 'Fire Rating': 'FD60' } }], use, { mode: 'grouped' }).length, 2);
  assert.equal(buildSchedule([a, { ...b, id: a.id, modelId: 'another-model' }], use).length, 2);
});

test('units and identity remain explicit; missing geometry is not zero; reinforcement estimates remain marked', () => {
  const e = slab(1); assert.equal(readQuantity(e, ['Thickness'], 'm').value, 0.2);
  assert.equal(readQuantity({ q: { Mass: [1000, 'kg'] } }, ['Mass'], 't').value, 1);
  assert.equal(readQuantity(e, ['Volume'], 'm2').value, null);
  assert.notEqual(elementKey(e, { modelId: 'A' }), elementKey(e, { modelId: 'B' }));
  const { records } = buildLedger([e], { ...DEFAULT_PROFILE, rebar: true, ratio: 125 });
  const allowance = records.find(r => r.stream === 'rebar-estimate'); assert.equal(allowance.quantity, 1.2); assert.equal(allowance.provisional, true);
  const missing = buildLedger([{ ...e, q: {} }], DEFAULT_PROFILE); assert.equal(missing.records[0].quantity, null);
  assert.equal(groupLedger(missing.records, DEFAULT_PROFILE)[0].quantity, null);
});

test('allocation is conditional; lighting is not NRM2 section 23; door location requires review', () => {
  assert.equal(classify({ cat: 'Lighting Fixtures' }).NRM2, '39');
  assert.equal(classify({ cat: 'Doors', props: {} }).NRM1, '');
  const e = slab(1), key = elementKey(e);
  assert.equal(buildLedger([e], DEFAULT_PROFILE, { allocations: { [key]: { NRM1: '1.1.3' } } }).records[0].classification.NRM1, '1.1.3');
});

test('BOQ preserves rates by semantic key, keeps units separate and escapes external text', () => {
  const e = { ...slab(1), type: '=HYPERLINK("bad")' };
  const records = buildLedger([e], DEFAULT_PROFILE).records, groups = groupLedger(records, DEFAULT_PROFILE);
  const layout = boqLayout(groups, DEFAULT_PROFILE, { keep: new Map([[groups[0].key, 450]]), quantities: new Map([[groups[0].key, 'TO_G1_Qty']]) });
  const row = layout.rows.find(r => r[0] === groups[0].key); assert.equal(row[5], 450); assert.equal(row[4], '=TO_G1_Qty'); assert.ok(row[2].startsWith("'="));
  assert.match(layout.rows.at(-1)[6], /^=SUM\(G5:G\d+\)$/);
  assert.ok(basisLayout({ ...DEFAULT_PROFILE, amendments: '=BAD()' }, {}, []).rows.some(r => r[1] === "'=BAD()"));
  const cost = elementalLayout(); assert.ok(cost.rows.some(r => r[0] === '14.2')); assert.ok(cost.rows.some(r => r[0] === 'UNASSIGNED'));
  assert.match(csvText([['=BAD()', 'a,b', 'one\ntwo']]), /'=BAD\(\)/);
});

test('stable keys match SHA-256 for Unicode and long specifications and fit Excel criteria', () => {
  for (const text of ['', 'abc', 'දොර / porte / Tür', 'X'.repeat(10000)]) assert.equal(stableKey(text), 'QS-' + createHash('sha256').update(text).digest('hex'));
  assert.equal(stableKey('large specification').length, 67);
});

test('BOQ splits identical type marks with different dimensions; ledger batches formula links and zero ratios', () => {
  const a = { ...slab(1), cat: 'Doors', type: 'D1', props: { Function: 'Internal' }, q: { Width: [900, 'mm'], Height: [2100, 'mm'] } };
  const b = { ...a, id: 2, guid: 'guid-2', q: { Width: [1000, 'mm'], Height: [2100, 'mm'] } };
  const records = buildLedger([a, b], DEFAULT_PROFILE).records;
  assert.equal(groupLedger(records, DEFAULT_PROFILE).length, 2);
  const profile = { ...DEFAULT_PROFILE, rebar: true, ratio: 0 }, ledger = buildLedger([slab(3)], profile).records, groups = groupLedger(ledger, profile);
  const layout = takeoffLayout(ledger, groups), row = layout.rows.find(r => r[3] === 'rebar-estimate');
  assert.equal(row[6], 9.6); assert.equal(row[7], 0); assert.match(row[8], /G\d+\*H\d+\/1000/);
  assert.ok(layout.rows.slice(4).every(r => r[0].length === 67));
});

test('opt-in formwork fallback uses explicit dimensions and NRM2 linear foundation side units', () => {
  const e = { id: 1, cat: 'Structural Foundations', type: 'Concrete pad F1', props: { 'Structural Material': 'Concrete C40' },
    q: { Width: [1500, 'mm'], Length: [1500, 'mm'], Depth: [500, 'mm'], Volume: [1.125, 'm3'] } };
  const profile = { ...DEFAULT_PROFILE, formwork: true, formworkFallback: true };
  const r = buildLedger([e], profile).records.find(r => r.stream === 'formwork-sides');
  assert.equal(r.unit, 'm'); assert.equal(r.quantity, 6); assert.equal(r.provisional, true);
  const absent = buildLedger([{ ...e, q: { Volume: [1.125, 'm3'] } }], profile).records.find(r => r.stream === 'formwork-sides');
  assert.equal(absent.quantity, null);
});
