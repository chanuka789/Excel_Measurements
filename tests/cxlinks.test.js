// Unit tests: live Excel links (=CX.QTY / =CX.VALUE): formulas, parsing back, values from the measurements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupToSpec } from '../public/js/dims.js';

globalThis.window ||= { addEventListener() {} };             // the module shares core.js with the browser pages
const { formulaFor, parseFormula, linkValue, setTree, setBimTotals, shortRef } = await import('../public/js/cxlinks.js');

const G = { id: '1a2b3c4d-1111-2222-3333-444455556666', name: 'Floor tiles', mtype: 'Area', items: [{ element_id: 77, sign: 1, multiplier: 1 }],
  props: { measured: [{ id: '9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff', label: 'Area 0001', value: 12.5, sign: 1, multiplier: 1 },
    { id: '5555aaaa-aaaa-bbbb-cccc-ddddeeeeffff', label: 'Area 0002', value: 4, sign: -1, multiplier: 2 }] } };
setTree({ folders: [], groups: [G] }, 'p1');

test('formulas use short stable references', () => {
  assert.equal(shortRef(G.id), '1a2b3c4d');
  assert.equal(formulaFor({ gid: G.id }), '=CX.QTY("1a2b3c4d")');
  assert.equal(formulaFor({ gid: G.id, mid: G.props.measured[0].id }), '=CX.VALUE("1a2b3c4d","9f8e7d6c")');
  assert.equal(formulaFor({ gid: G.id, mid: G.props.measured[0].id, quantity: 'Base' }), '=CX.QTY("1a2b3c4d","Base","9f8e7d6c")');
  assert.equal(formulaFor({ gid: G.id, quantity: 'Count' }), '=CX.QTY("1a2b3c4d","Count")');
});

test('formulas are read back to the group and the dimension (also inside bigger formulas)', () => {
  assert.deepEqual(parseFormula('=CX.QTY("1a2b3c4d")*1.05'), [{ gid: G.id, mid: null, eid: null, quantity: '' }]);
  assert.deepEqual(parseFormula('=cx.value("1a2b3c4d","9f8e7d6c")+CX.QTY("1a2b3c4d","Count")').map(x => [x.mid, x.quantity]), [[G.props.measured[0].id, ''], [null, 'Count']]);
  assert.deepEqual(parseFormula('=CX.VALUE("1a2b3c4d","77")')[0].eid, 77);
  assert.deepEqual(parseFormula('=CX.QTY("ffffffff")'), []);             // not a group of the open project
  assert.deepEqual(parseFormula('=SUM(A1:A3)'), []);
});

test('values: measured dimensions with sign and multiplier, model objects from the window, counts', () => {
  assert.equal(linkValue(G, '', '9f8e7d6c'), 12.5);
  assert.equal(linkValue(G, '', '5555aaaa'), -8);
  assert.equal(linkValue(G, 'Base', '5555aaaa'), 4);
  assert.equal(linkValue(G), 4.5);                                        // model object not known yet
  setBimTotals({ [G.id]: { total: 10, n: 1, dims: { 77: 10 } } });
  assert.equal(linkValue(G), 14.5);
  assert.equal(linkValue(G, '', '77'), 10);
  assert.equal(linkValue(G, 'Count'), 3);
});

test('schedules from a dimension group keep live links in the measured rows', () => {
  const spec = groupToSpec(G, new Map(), {});
  assert.deepEqual(spec.manual.map(m => m.cx), [{ gid: G.id, mid: G.props.measured[0].id, key: 'Base' }, { gid: G.id, mid: G.props.measured[1].id, key: 'Base' }]);
});
