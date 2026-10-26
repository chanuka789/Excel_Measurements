// Unit tests: Share copy (live links become plain numbers, formulas kept) and Restore links, on a small fake Excel.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ||= { addEventListener() {} };
const col = (s) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const colName = (n) => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };
function fakeExcel() {
  const sheets = new Map();
  const sheet = (name) => {
    const cells = new Map();                                  // 'r,c' -> { f, v }
    const cell = (r, c) => cells.get(`${r},${c}`) || { f: '', v: '' };
    const range = (r0, c0, r1, c1) => {
      const grid = (k) => Array.from({ length: r1 - r0 + 1 }, (_, i) => Array.from({ length: c1 - c0 + 1 }, (_, j) => cell(r0 + i, c0 + j)[k]));
      const set = (rows, asFormula) => rows.forEach((row, i) => row.forEach((x, j) => cells.set(`${r0 + i},${c0 + j}`, asFormula && String(x).startsWith('=') ? { f: x, v: cell(r0 + i, c0 + j).v } : { f: x, v: x })));
      return { load() {}, isNullObject: false, rowIndex: r0, columnIndex: c0, cellCount: (r1 - r0 + 1) * (c1 - c0 + 1),
        get values() { return grid('v'); }, set values(x) { set(x, false); }, get formulas() { return grid('f'); }, set formulas(x) { set(x, true); },
        clear() { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.delete(`${r},${c}`); } };
    };
    const parse = (a) => {
      const m = /^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(a);
      const r0 = m[2] ? +m[2] - 1 : 0, c0 = col(m[1]), c1 = m[3] ? col(m[3]) : c0, r1 = m[4] ? +m[4] - 1 : m[3] && !m[2] ? 999 : r0;
      return range(r0, c0, r1, c1);
    };
    return { name, cells, visibility: 'Visible', load() {}, isNullObject: false, getRange: parse,
      getUsedRangeOrNullObject() {
        const keys = [...cells.keys()].map(k => k.split(',').map(Number));
        if (!keys.length) return { isNullObject: true, load() {} };
        const rs = keys.map(k => k[0]), cs = keys.map(k => k[1]);
        return range(Math.min(...rs), Math.min(...cs), Math.max(...rs), Math.max(...cs));
      },
      put(addr, f, v) { const m = /^([A-Z]+)(\d+)$/.exec(addr); cells.set(`${+m[2] - 1},${col(m[1])}`, { f, v }); },
      get(addr) { const m = /^([A-Z]+)(\d+)$/.exec(addr); return cell(+m[2] - 1, col(m[1])); } };
  };
  const wb = { worksheets: { get items() { return [...sheets.values()]; }, load() {},
    getItemOrNullObject: (n) => sheets.get(n) || { isNullObject: true }, getItem: (n) => sheets.get(n),
    add: (n) => { const s = sheet(n); sheets.set(n, s); return s; } } };
  globalThis.Excel = { run: async (fn) => fn({ workbook: wb, sync: async () => {} }), SheetVisibility: { veryHidden: 'VeryHidden' } };
  return { add: (n) => wb.worksheets.add(n), sheets };
}

test('share copy turns CX links into numbers and keeps the formulas; restore puts them back', async () => {
  const X = fakeExcel();
  const { App } = await import('../public/js/core.js');
  App.inExcel = () => true;
  const CX = await import('../public/js/cxlinks.js');
  const s = X.add('BOQ');
  s.put('C5', '=CX.QTY("1a2b3c4d")', 255);
  s.put('C6', '=CX.QTY("1a2b3c4d")*1.05', 267.75);
  s.put('C7', '=CX.VALUE("1a2b3c4d","9f8e7d6c")', '#NAME?');          // not calculated: stays a formula
  s.put('D5', '=C5*12', 3060);
  const r = await CX.freezeLinks();
  assert.deepEqual(r, { cells: 2, sheets: 1, notReady: 1 });
  assert.deepEqual(s.get('C5'), { f: 255, v: 255 });
  assert.deepEqual(s.get('C6'), { f: 267.75, v: 267.75 });
  assert.equal(s.get('C7').f, '=CX.VALUE("1a2b3c4d","9f8e7d6c")');
  assert.equal(s.get('D5').f, '=C5*12');                                 // ordinary formulas are not touched
  const kept = X.sheets.get(CX.SHARED);
  assert.equal(kept.visibility, 'VeryHidden');
  assert.ok(kept.get('C2').f.startsWith('CXF:='));                       // stored as text, never a live formula
  assert.equal(await CX.sharedCount(), 2);
  s.put('C6', 300, 300);                                                 // someone typed over this one
  const back = await CX.restoreLinks();
  assert.deepEqual(back, { restored: 1, changed: 1 });
  assert.equal(s.get('C5').f, '=CX.QTY("1a2b3c4d")');
  assert.equal(s.get('C6').f, 300);
  assert.equal(await CX.sharedCount(), 1);                               // the hand-changed cell stays listed
});
