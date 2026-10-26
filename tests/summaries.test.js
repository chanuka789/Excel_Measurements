// Unit tests: summary sheet builders (register, pivot summary, custom sheets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRegister, buildSummary, buildCustom, registerColumns, itemCode, crit } from '../public/js/summaries.js';

const rule = (key, title, unit, extra = {}) => ({ set: 'NRM2', key, ref: 'NRM2 11.2', group: 'Concrete', title, nrm1: '2.2', ...extra });
const G = [{
  ref: 'G1', name: 'Slabs', dataStart: 7, levelCol: 5, zoneCol: -1, levels: new Set(['L2', 'L1']), zones: new Set(),
  meta: { method: {
    inputs: [{ key: 'V', label: 'Net volume', unit: 'm3', sum: true }, { key: 'T', label: 'Thickness', unit: 'm', sum: false }],
    formulas: [{ key: 'C1', label: 'Horizontal work, not exceeding 300 mm thick', unit: 'm3', expr: 'IF({T}<=0.3,{V},0)', rule: rule('conc.hz.thin', 'Horizontal', 'm3') },
      { key: 'FW', label: 'Soffits of horizontal work', unit: 'm2', expr: '{V}*5', rule: rule('fw.soffit', 'Soffits', 'm2', { group: 'Formwork', ref: 'NRM2 11.15' }) },
      { key: 'X', label: 'Helper', unit: 'm2', expr: '{FW}*2' }] } },
}, { ref: 'G2', name: 'Doors', dataStart: 7, levelCol: -1, zoneCol: -1, levels: new Set(), zones: new Set(),
  meta: { method: { inputs: [{ key: 'Count', label: 'Count', unit: 'nr', sum: true }], formulas: [] } } },
{ ref: 'G3', name: 'Unlinked', dataStart: 7, levelCol: -1, meta: null }];

test('register: one SUMIFS row per item, group and level; helper inputs left out', () => {
  assert.deepEqual(registerColumns(G[0]).map(x => [x.col.key, x.letter]), [['C1', 'J'], ['FW', 'K'], ['X', 'L']]);
  const { entries, skipped, layout } = buildRegister(G, { by: 'level' });
  assert.deepEqual(skipped, ['G3']);
  assert.equal(entries.length, 2 * 3 + 1);
  const e = entries.find(x => x.desc.startsWith('Horizontal') && x.level === 'L1');
  assert.equal(e.formula, `=SUMIFS('Take-off'!$J:$J,'Take-off'!$A:$A,"G1.*",'Take-off'!$F:$F,"=L1")`);
  assert.equal(entries.find(x => x.group.startsWith('G2')).formula, `=SUMIFS('Take-off'!$H:$H,'Take-off'!$A:$A,"G2.*")`);
  assert.equal(entries.find(x => x.group.startsWith('G2')).level, '(all levels)');
  assert.equal(layout.rows[3][10], 'Quantity');
  assert.equal(crit('A*1'), '"=A~*1"'); assert.equal(crit(''), '"="');
});

test('summary pivot: levels across, total column, items under work sections', () => {
  const { entries } = buildRegister(G, { by: 'level' });
  const L = buildSummary(entries, { by: 'level', order: ['L1', 'L2'] });
  assert.deepEqual(L.rows[3], ['Code', 'Description', 'Ref', 'Unit', 'L1', 'L2', '(all levels)', 'Total']);
  const r = L.rows.findIndex(x => x[0] === itemCode(G[0].meta.method.formulas[0])) + 1;
  assert.equal(L.rows[r - 1][4], `=SUMIFS('Quantities'!$K:$K,'Quantities'!$A:$A,$A${r},'Quantities'!$H:$H,E$4)`);
  assert.equal(L.rows[r - 1][7], `=SUMIFS('Quantities'!$K:$K,'Quantities'!$A:$A,$A${r})`);
  assert.ok(L.kinds.includes('section'));
});

test('no measurement-standard sheets: only the register and the summary are built', async () => {
  const mod = await import('../public/js/summaries.js');
  assert.equal(mod.buildRuleSummary, undefined); assert.equal(mod.buildNrm1, undefined);
  assert.throws(() => buildCustom({ name: 'Summary', columns: [{ head: 'A' }], rows: [] }), /manages/);
});

test('custom sheets: helper functions, blocked formulas, reserved names', () => {
  const L = buildCustom({ name: 'Concrete check', columns: [{ head: 'Item' }, { head: 'Qty', format: '#,##0.00' }],
    rows: [{ cells: ['Slabs', '=QTY("NRM2:conc.hz.thin:x")'] }, { style: 'total', cells: ['Total', '=SUM(B5:B5)+TOTAL("G1","FW")'] }] }, { names: new Set(['TO_G1_FW']) });
  assert.equal(L.rows[4][1], `=SUMIFS('Quantities'!$K:$K,'Quantities'!$A:$A,"NRM2:conc.hz.thin:x")`);
  assert.equal(L.rows[5][1], '=SUM(B5:B5)+TO_G1_FW');
  assert.throws(() => buildCustom({ name: 'X', columns: [{ head: 'a' }], rows: [{ cells: ['=WEBSERVICE("http://x")'] }] }), /not allowed/);
  assert.throws(() => buildCustom({ name: 'X', columns: [{ head: 'a' }], rows: [{ cells: ["='[book.xlsx]S'!A1"] }] }), /not allowed/);
  assert.throws(() => buildCustom({ name: 'Quantities', columns: [{ head: 'a' }] }), /manages/);
  assert.throws(() => buildCustom({ name: 'X', columns: [{ head: 'a' }], rows: [{ cells: ['=TOTAL("G9","Q")'] }] }, { names: new Set(['TO_G1_FW']) }), /no take-off total/);
});
