// Office API contract fixture: exercise the real writer's staging/rollback, not native Excel rendering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.window = { addEventListener() {} };
const { writeLayout } = await import('../public/js/excel.js');

function workbook({ failStage = false, failCopy = false } = {}) {
  const sheets = new Map(), deleted = []; let fail = failCopy;
  const coord = cell => { const m = /^([A-Z]+)(\d+)?$/.exec(cell); let col = 0; for (const c of m[1]) col = col * 26 + c.charCodeAt(0) - 64; return [+(m[2] || 1) - 1, col - 1]; };
  const range = (sheet, row, col, height, width) => ({
    rowIndex: row, columnIndex: col, rowCount: height, columnCount: width, isNullObject: sheet.cells.length === 0,
    load() {}, select() {}, numberFormat: null,
    format: { font: { set() { if (failStage && sheet.name.startsWith('__qs_')) throw new Error('format failure'); } }, fill: { clear() {} }, borders: { getItem() { return {}; } } },
    get values() { return Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => sheet.cells[row + r]?.[col + c] ?? '')); },
    set formulas(rows) { rows.forEach((r, i) => { sheet.cells[row + i] ||= []; r.forEach((v, j) => { sheet.cells[row + i][col + j] = v; }); }); },
    clear() { sheet.cells = []; },
    copyFrom(source) {
      if (fail && sheet.name === 'Result') { fail = false; throw new Error('copy failure'); }
      this.formulas = source.values;
    },
  });
  const add = name => {
    let current = name;
    const sheet = { cells: [], isNullObject: false, position: sheets.size, freezePanes: { freezeRows() {} }, load() {}, activate() {},
      get name() { return current; }, set name(value) { sheets.delete(current); current = value; sheets.set(value, sheet); },
      getRange(address) { const [a, b = a] = address.split(':'); const [r, c] = coord(a), [rr, cc] = coord(b); return range(sheet, r, c, rr - r + 1, cc - c + 1); },
      getRangeByIndexes(r, c, h, w) { return range(sheet, r, c, h, w); },
      getUsedRangeOrNullObject() { return range(sheet, 0, 0, Math.max(sheet.cells.length, 1), Math.max(...sheet.cells.map(r => r.length), 1)); },
      getUsedRange() { return this.getUsedRangeOrNullObject(); },
      delete() { deleted.push(current); sheets.delete(current); },
    };
    sheets.set(name, sheet); return sheet;
  };
  const collection = { add, getItemOrNullObject: name => sheets.get(name) || { isNullObject: true } };
  globalThis.Excel = { RangeCopyType: { all: 'All' }, BorderIndex: {}, run: callback => callback({ workbook: { worksheets: collection }, sync: async () => {} }) };
  return { sheets, deleted, add };
}
const layout = { name: 'Result', rows: [['Title'], ['Heading'], [12]], kinds: ['title', 'head', 'item'], headRow: 2 };

test('writer stages before replacing existing values without deleting destination sheet identity', async () => {
  const book = workbook(), original = book.add('Result'); original.cells = [['old'], ['old2'], ['old3'], ['old4']];
  await writeLayout(layout);
  assert.equal(book.sheets.get('Result'), original); assert.deepEqual(original.cells, [['Title'], ['Heading'], [12]]);
  assert.ok(!book.deleted.includes('Result')); assert.equal(book.sheets.size, 1);
});
test('staging failure preserves original sheet; copy failure restores its backup', async () => {
  for (const options of [{ failStage: true }, { failCopy: true }]) {
    const book = workbook(options), old = book.add('Result'); old.cells = [['rate', 450]];
    await assert.rejects(writeLayout(layout), /failure/);
    assert.deepEqual(old.cells, [['rate', 450]]); assert.equal(book.sheets.size, 1);
  }
});
test('writer checks Excel cell limits before any destination mutation', async () => {
  const book = workbook(), old = book.add('Result'); old.cells = [[450]];
  await assert.rejects(writeLayout({ ...layout, rows: [['x'.repeat(32768)]] }), /Excel/);
  assert.deepEqual(old.cells, [[450]]);
});
