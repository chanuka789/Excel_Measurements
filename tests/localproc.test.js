// Unit tests: checks on models processed in a browser, and adding up the parts of qs.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPayload, checkGeometry, checkSvg } from '../src/localproc.js';
import { joinQsParts } from '../public/js/modelmerge.js';

const throws = (fn) => assert.throws(fn, (e) => e.status === 400 || /./.test(e.message));

test('checkPayload accepts the add-in model shape and refuses others', () => {
  checkPayload({ elements: [{ id: 1, cat: 'Walls', type: 'W', q: { Area: [2.5, 'm2'] } }], categories: {} });
  throws(() => checkPayload({}));
  throws(() => checkPayload({ elements: [{ id: 'x', cat: 'Walls', type: 'W', q: {} }] }));
  throws(() => checkPayload({ elements: [{ id: 1, cat: 'Walls', type: 'W', q: { Area: ['2', 'm2'] } }] }));
});

test('checkGeometry needs the DWG2 header and the exact length', () => {
  const head = Buffer.from(JSON.stringify({ nVerts: 1, nTris: 1, nEdges: 0 }));
  const make = (extra) => Buffer.concat([Buffer.from('DWG2'), Buffer.from(Uint32Array.of(head.length).buffer), head, Buffer.alloc(12 + 12 + extra)]);
  assert.equal(checkGeometry(make(0)).nTris, 1);
  throws(() => checkGeometry(make(4)));
  throws(() => checkGeometry(Buffer.from('MSH1xxxxxxxxxxxx')));
});

test('checkSvg refuses anything that can run code', () => {
  checkSvg('<?xml version="1.0"?><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>');
  for (const bad of ['<svg><script>alert(1)</script></svg>', '<svg onload="x()"></svg>', '<svg><a href="javascript:x()"/></svg>', '<svg><foreignObject/></svg>', '<html></html>'])
    throws(() => checkSvg(bad));
});

test('joinQsParts adds parts up like one run', () => {
  const q = (o) => ({ soffit: 0, ground: 0, slopeSoffit: 0, side: 0, topSlope: 0, top: 0, topExposed: 0, exposedPerim: 0, sides: [], soffitBands: {}, covered: {}, ...o });
  const p0 = { version: 1, up: 'z', part: [0, 2], overlaps: [[1, 2, 0.5]], elements: { 7: q({ soffit: 1.00004, sides: [[1, 0, 1, true, false, 0]], covered: { Floors: 0.2 }, height: 3, zlo: 0, zhi: 3 }) } };
  const p1 = { version: 1, up: 'z', part: [1, 2], overlaps: [], elements: { 7: q({ soffit: 2, side: 1, sides: [[2, 0, 1, false, false, 0]], covered: { Floors: 0.3, Walls: 1e-9 } }) } };
  const r = joinQsParts([p1, p0]);
  const e = r.elements[7];
  assert.equal(e.soffit, 3);
  assert.equal(e.side, 1);
  assert.deepEqual(e.sides.map(s => s[0]), [1, 2]);
  assert.deepEqual(e.covered, { Floors: 0.5 });
  assert.equal(e.height, 3);
  assert.deepEqual(r.overlaps, [[1, 2, 0.5]]);
});
