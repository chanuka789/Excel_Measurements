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
      // like Excel: a value starting with = becomes a formula; a leading apostrophe keeps it text (and is not shown)
      const set = (rows, asFormula) => rows.forEach((row, i) => row.forEach((x, j) => {
        const k = `${r0 + i},${c0 + j}`;
        if (typeof x === 'string' && x.startsWith("'")) cells.set(k, { f: x.slice(1), v: x.slice(1) });
        else if (typeof x === 'string' && x.startsWith('=')) cells.set(k, { f: x, v: asFormula ? cell(r0 + i, c0 + j).v : '#FORMULA' });
        else cells.set(k, { f: x, v: x });
      }));
      return { load() {}, isNullObject: false, rowIndex: r0, columnIndex: c0, cellCount: (r1 - r0 + 1) * (c1 - c0 + 1),
        get values() { return grid('v'); }, set values(x) { set(x, false); }, get formulas() { return grid('f'); }, set formulas(x) { set(x, true); },
        clear() { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.delete(`${r},${c}`); } };
    };
    const parse = (a) => {
      const m = /^([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(a);
      const r0 = m[2] ? +m[2] - 1 : 0, c0 = col(m[1]), c1 = m[3] ? col(m[3]) : c0, r1 = m[4] ? +m[4] - 1 : m[3] && !m[2] ? 999 : r0;
      return range(r0, c0, r1, c1);
    };
    return { name, id: '{' + name + '-id}', cells, visibility: 'Visible', load() {}, isNullObject: false, getRange: parse,
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
  s.put('D6', '=IF(B1="CX.QTY(",1,2)', 2);                               // the letters only appear in a text
  const r = await CX.freezeLinks();
  assert.deepEqual(r, { cells: 2, sheets: 1, notReady: 1 });
  assert.deepEqual(s.get('C5'), { f: 255, v: 255 });
  assert.deepEqual(s.get('C6'), { f: 267.75, v: 267.75 });
  assert.equal(s.get('C7').f, '=CX.VALUE("1a2b3c4d","9f8e7d6c")');
  assert.equal(s.get('D5').f, '=C5*12');                                 // ordinary formulas are not touched
  assert.equal(s.get('D6').f, '=IF(B1="CX.QTY(",1,2)');
  const kept = X.sheets.get(CX.SHARED);
  assert.equal(kept.visibility, 'VeryHidden');
  assert.ok(kept.get('C2').f.startsWith('CXF:='));                       // stored as text, never a live formula
  assert.equal(await CX.sharedCount(), 2);
  s.put('C6', 300, 300);                                                 // someone typed over this one
  const back = await CX.restoreLinks();
  assert.deepEqual(back, { restored: 1, changed: 1, missing: 0, moved: 0 });
  assert.equal(s.get('C5').f, '=CX.QTY("1a2b3c4d")');
  assert.equal(s.get('C6').f, 300);
  assert.equal(await CX.sharedCount(), 1);                               // the hand-changed cell stays listed
});

test('restore finds a renamed sheet by its id, and keeps records whose sheet is missing', async () => {
  const X = fakeExcel();
  const CX = await import('../public/js/cxlinks.js');
  const a = X.add('Take-off'), b = X.add('Old');
  a.put('B2', '=CX.QTY("1a2b3c4d")', 10); b.put('C3', '=CX.QTY("1a2b3c4d","Count")', 2);
  assert.equal((await CX.freezeLinks()).cells, 2);
  a.name = 'Take-off (renamed)';                              // renamed: same id
  X.sheets.delete('Old');                                     // gone from this workbook
  const r = await CX.restoreLinks();
  assert.deepEqual(r, { restored: 1, changed: 0, missing: 1, moved: 0 });
  assert.equal(a.get('B2').f, '=CX.QTY("1a2b3c4d")');
  assert.equal(await CX.sharedCount(), 1);
});

test('the formulas are saved before any cell is replaced', async () => {
  const X = fakeExcel();
  const CX = await import('../public/js/cxlinks.js');
  const a = X.add('A'), b = X.add('B');
  a.put('A1', '=CX.QTY("1a2b3c4d")', 5); b.put('A1', '=CX.QTY("1a2b3c4d")', 6);
  const real = b.getRange;
  b.getRange = (addr) => { const r = real(addr); if (addr === 'A1') Object.defineProperty(r, 'values', { set() { throw new Error('protected'); } }); return r; };
  await assert.rejects(CX.freezeLinks(), /protected/);
  b.getRange = real;
  assert.equal(await CX.sharedCount(), 2);                    // both formulas are kept even though the run failed
  const r = await CX.restoreLinks();
  assert.equal(r.restored, 1);                                // A1 on sheet A had been replaced; it comes back
  assert.equal(a.get('A1').f, '=CX.QTY("1a2b3c4d")');
});

test('a new sheet with the old name is not used to restore, and restored cells go back into the link list', async () => {
  const X = fakeExcel();
  const CX = await import('../public/js/cxlinks.js');
  const a = X.add('Take-off');
  a.put('B2', '=CX.QTY("1a2b3c4d")', 10);
  await CX.freezeLinks();
  X.sheets.delete('Take-off');
  const b = X.add('Take-off'); b.id = '{other-id}'; b.put('B2', 10, 10);     // same name, same cell value, different sheet
  const r = await CX.restoreLinks();
  assert.deepEqual(r, { restored: 0, changed: 0, missing: 1, moved: 0 });
  assert.equal(b.get('B2').f, 10);
  // restore on the right sheet rescans the workbook, so the link list is rebuilt
  CX.setTree({ folders: [], groups: [{ id: '1a2b3c4d-1111-2222-3333-444455556666', name: 'G', mtype: 'Area', items: [], props: { measured: [] } }] }, 'p1');
  const c = X.add('Sheet2'); c.put('C3', '=CX.QTY("1a2b3c4d")', 7);
  await CX.freezeLinks();
  assert.equal((await CX.restoreLinks()).restored, 1);
  assert.ok(X.sheets.get(CX.LINKS).get('B2').f === 'C3');                    // _cxlinks row 2: Sheet2!C3
});

test('restore follows the live reference when rows were inserted above the frozen cells', async () => {
  const X = fakeExcel();
  const CX = await import('../public/js/cxlinks.js');
  const a = X.add('Sheet A');
  a.put('A1', '=CX.QTY("aaaaaaaa")', 10); a.put('A2', '=CX.QTY("bbbbbbbb")', 10);
  await CX.freezeLinks();
  const kept = X.sheets.get(CX.SHARED);
  assert.equal(kept.get('F2').f, "='Sheet A'!$A$1");
  // insert a row above row 1: Excel moves the cells and updates the references
  const moved = new Map([...a.cells].map(([k, v]) => { const [r, c] = k.split(',').map(Number); return [`${r + 1},${c}`, v]; }));
  a.cells.clear(); moved.forEach((v, k) => a.cells.set(k, v));
  kept.put('F2', "='Sheet A'!$A$2", ''); kept.put('F3', "='Sheet A'!$A$3", '');
  assert.deepEqual(await CX.restoreLinks(), { restored: 2, changed: 0, missing: 0, moved: 0 });
  assert.equal(a.get('A2').f, '=CX.QTY("aaaaaaaa")');
  assert.equal(a.get('A3').f, '=CX.QTY("bbbbbbbb")');
  assert.equal(a.get('A1').f, '');
});

test('a second Share Copy keeps the moved position of cells frozen before', async () => {
  const X = fakeExcel();
  const CX = await import('../public/js/cxlinks.js');
  const a = X.add('BOQ');
  a.put('A1', '=CX.QTY("aaaaaaaa")', 10);
  await CX.freezeLinks();
  const kept = X.sheets.get(CX.SHARED);
  a.cells.set('1,0', a.cells.get('0,0')); a.cells.delete('0,0');          // a row inserted above: A1 -> A2
  kept.put('F2', "='BOQ'!$A$2", '');
  a.put('B5', '=CX.QTY("bbbbbbbb")', 4);                                  // a new link, then Share Copy again
  await CX.freezeLinks();
  const refs = [kept.get('F2').f, kept.get('F3').f].sort();
  assert.deepEqual(refs, ["='BOQ'!$A$2", "='BOQ'!$B$5"]);
  assert.deepEqual(await CX.restoreLinks(), { restored: 2, changed: 0, missing: 0, moved: 0 });
  assert.equal(a.get('A2').f, '=CX.QTY("aaaaaaaa")');
});

test('a text result that looks like a formula stays text when frozen, and restores', async () => {
  const X = fakeExcel();
  const CX = await import('../public/js/cxlinks.js');
  const a = X.add('S');
  a.put('A1', '=IF(CX.QTY("aaaaaaaa")>0,"=pending","")', '=pending');
  await CX.freezeLinks();
  assert.deepEqual(a.get('A1'), { f: '=pending', v: '=pending' });          // text, not a formula
  assert.deepEqual(await CX.restoreLinks(), { restored: 1, changed: 0, missing: 0, moved: 0 });
  assert.equal(a.get('A1').f, '=IF(CX.QTY("aaaaaaaa")>0,"=pending","")');
});

test('a formula typed over a frozen cell is kept, even when it gives the same value', async () => {
  const X = fakeExcel();
  const CX = await import('../public/js/cxlinks.js');
  const a = X.add('S');
  a.put('A1', '=CX.QTY("aaaaaaaa")', 10);
  await CX.freezeLinks();
  a.put('A1', '=5+5', 10);
  assert.deepEqual(await CX.restoreLinks(), { restored: 0, changed: 1, missing: 0, moved: 0 });
  assert.equal(a.get('A1').f, '=5+5');
});

test('a moved cell whose formula also uses other cells is not put back automatically', async () => {
  const X = fakeExcel();
  const CX = await import('../public/js/cxlinks.js');
  const a = X.add('S');
  a.put('A1', '=CX.QTY("aaaaaaaa")*B1', 20); a.put('A3', '=CX.QTY("bbbbbbbb")', 5);
  await CX.freezeLinks();
  const kept = X.sheets.get(CX.SHARED);
  const moved = new Map([...a.cells].map(([k, v]) => { const [r, c] = k.split(',').map(Number); return [`${r + 1},${c}`, v]; }));
  a.cells.clear(); moved.forEach((v, k) => a.cells.set(k, v));                // a row inserted above
  [2, 3].forEach(r => kept.put('F' + r, `='S'!$A$${kept.get('B' + r).f === 'A1' ? 2 : 4}`, ''));
  assert.deepEqual(await CX.restoreLinks(), { restored: 1, changed: 0, missing: 0, moved: 1 });
  assert.equal(a.get('A4').f, '=CX.QTY("bbbbbbbb")');                    // only a CX call: safe to put back
  assert.equal(a.get('A2').f, 20);                                        // also uses B1: left as the number
  assert.equal(await CX.sharedCount(), 1);
});

test('text that only looks like a CX formula is not frozen', async () => {
  const X = fakeExcel();
  const CX = await import('../public/js/cxlinks.js');
  const a = X.add('S');
  a.put('A1', '=CX.QTY("aaaaaaaa")', '=CX.QTY("aaaaaaaa")');               // typed as text with an apostrophe
  assert.equal((await CX.freezeLinks()).cells, 0);
  assert.equal(await CX.sharedCount(), 0);
});
