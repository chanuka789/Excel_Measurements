// Unit tests: CostX extras — cutouts, rebar, Auto Count image search and the DWG/DXF to SVG conversion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pc from 'polygon-clipping';
import * as G from '../public/js/geom2d.js';
import { cutout } from '../public/js/cutout.js';
import { findMatches, variants } from '../public/js/autocount.js';
import { normalise, toSvg, extents, UNIT_M } from '../src/cad2svg.js';
import { cleanGeometry, cleanDrawingSettings } from '../src/dims.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);
const rect = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
const dim = (id, gid, pts, sign = 1) => ({ g: { id: gid }, m: { id, shape: 'area', pts, sign } });

test('area with cutout holes: area less the holes, perimeter includes the hole edges', () => {
  const q = G.measure2d('area', rect(0, 0, 10, 5), 1, { holes: [rect(4, 1, 6, 3)] });
  near(q.value, 46); near(q.len, 30 + 8);
  assert.equal(G.distToShape([5, 2], 'area', rect(0, 0, 10, 5), [rect(4, 1, 6, 3)]) > 0, true);   // inside the hole is not the dimension
  assert.equal(G.holeAt([5, 2], [rect(4, 1, 6, 3)]), 0);
});

test('Convert to Cutout: a hole, a split in two, and only the negative dimension\'s own group by default', () => {
  const room = dim('a', 'g1', rect(0, 0, 10, 5)), other = dim('b', 'g2', rect(0, 0, 10, 5));
  let r = cutout(pc, [room, other], [dim('n', 'g1', rect(4, 1, 6, 3), -1)]);
  assert.deepEqual([...r.used], ['n']); assert.equal(r.pieces.size, 1);
  const p = r.pieces.get('a')[0]; near(G.measure2d('area', p.pts, 1, { holes: p.holes }).value, 46); assert.equal(p.holes.length, 1);
  r = cutout(pc, [room], [dim('s', 'g1', rect(7, -1, 8, 6), -1)]);                   // a strip right across: two pieces
  const parts = r.pieces.get('a').map(x => G.polyArea(x.pts)).sort((x, y) => x - y);
  assert.deepEqual(parts.map(Math.round), [10, 35]);
  r = cutout(pc, [room, other], [dim('n', 'g1', rect(4, 1, 6, 3), -1)], [other]);  // the user chose the other group's area
  assert.ok(r.pieces.has('b')); assert.ok(!r.pieces.has('a'));
  assert.equal(cutout(pc, [room], [dim('far', 'g1', rect(20, 20, 21, 21), -1)]).used.size, 0);
});

test('rebar: bars over the spacing distance, plus the extra length per bar', () => {
  const pts = [0, 0, 0, 5, 0, 0, 10, 0];
  const q = G.rebarQty(pts, 1, { spacing: 0.2, extra: 0.5 });
  assert.equal(q.bars, 26); near(q.value, 26 * 10.5);
  assert.equal(G.measure2d('rebar', pts, 1, { rebar: { spacing: 0.25 } }).bars, 21);
  assert.equal(G.rebarQty([0, 0, 0, 4.9999999, 0, 0, 1, 0], 1, { spacing: 0.2 }).bars, 26);   // clicks a hair short of 5 m
});

test('Auto Count finds rotated and mirrored copies and ignores other lines', () => {
  const W = 500, H = 300, d = new Float32Array(W * H);
  const put = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) d[y * W + x] = 1; };
  const sym = (ox, oy, f) => { for (let i = 0; i < 20; i++) { for (const [x, y] of [[i, 0], [0, i], [i, i >> 1]]) { const [a, b] = f(x, y); put(ox + a, oy + b); } } };
  sym(20, 20, (x, y) => [x, y]); sym(200, 50, (x, y) => [19 - y, x]); sym(350, 180, (x, y) => [19 - x, y]);
  for (let x = 0; x < W; x++) d[150 * W + x] = 1;                                    // a wall
  const img = { w: W, h: H, d }, tpl = { w: 24, h: 24, d: new Float32Array(576) };
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) tpl.d[y * 24 + x] = d[(18 + y) * W + 18 + x];
  const m = findMatches(img, tpl, { min: 0.7 });
  assert.equal(m.length, 3);
  assert.ok(m.every(x => x.score > 0.9));
  assert.ok(variants({ w: 2, h: 2, d: new Float32Array([1, 1, 1, 1]) }).length === 1);   // a symmetric symbol is tried once
});

test('DWG / DXF: lines, polylines with arcs, circles, blocks and text become an SVG by layer, in the file units', () => {
  const db = {
    header: { $INSUNITS: 4 },
    tables: { layer: { layers: { Walls: { name: 'Walls', colorIndex: 1 }, Doors: { name: 'Doors', colorIndex: 2 } } } },
    blocks: { DOOR: { position: { x: 0, y: 0 }, entities: [{ type: 'LINE', layer: '0', vertices: [{ x: 0, y: 0 }, { x: 900, y: 0 }] }, { type: 'ARC', layer: '0', center: { x: 0, y: 0 }, radius: 900, startAngle: 0, endAngle: 90 }] } },
    entities: [
      { type: 'LWPOLYLINE', layer: 'Walls', shape: true, vertices: [{ x: 0, y: 0 }, { x: 10000, y: 0 }, { x: 10000, y: 5000 }, { x: 0, y: 5000 }] },
      { type: 'CIRCLE', layer: 'Walls', center: { x: 5000, y: 2500 }, radius: 300 },
      { type: 'INSERT', layer: 'Doors', name: 'DOOR', position: { x: 2000, y: 0 }, rotation: 90, xScale: 1, yScale: 1 },
      { type: 'TEXT', layer: 'Walls', startPoint: { x: 100, y: 5200 }, text: 'Room 1', textHeight: 250, rotation: 0 },
    ],
  };
  const n = normalise(db, 'dxf');
  assert.equal(n.unitM, UNIT_M[4]);
  assert.equal(n.paths.length, 4); assert.equal(n.texts.length, 1);
  const door = n.paths.filter(p => p.layer === 'Doors');
  assert.equal(door.length, 2);
  near(door[0].pts[1][0], 2000, 1e-6); near(door[0].pts[1][1], 900, 1e-6);          // rotated 90° about the insertion point
  const svg = toSvg(n);
  assert.match(svg, /data-unit-m="0.001"/); assert.match(svg, /data-layer="Walls"/); assert.match(svg, /data-layer="Doors"/); assert.match(svg, />Room 1</);
  const b = extents(n); assert.ok(b.x1 - b.x0 > 10000 && b.x1 - b.x0 < 11000);
});

test('server keeps cutout holes, rebar settings and working areas, bounded', () => {
  const g = cleanGeometry({ shape: 'area', pts: rect(0, 0, 1, 1), holes: [rect(0.2, 0.2, 0.4, 0.4), [1, 2], 'x'] });
  assert.equal(g.holes.length, 1);
  assert.equal(cleanGeometry({ shape: 'length', pts: [0, 0, 1, 1], holes: [rect(0, 0, 1, 1)] }).holes, undefined);   // holes only on areas
  assert.deepEqual(cleanGeometry({ shape: 'rebar', pts: [0, 0, 0, 5, 0, 0, 10, 0], rebar: { spacing: 0.2, extra: 0.5, bars: 26 } }).rebar, { spacing: 0.2, extra: 0.5, bars: 26 });
  const s = cleanDrawingSettings({ pages: { 1: { scale: 0, area: { x0: 1, y0: 2, x1: 30, y1: 40 } }, 2: { scale: 0, area: { x0: 5, y0: 5, x1: 1, y1: 1 } } } });
  assert.deepEqual(s.pages[1].area, { x0: 1, y0: 2, x1: 30, y1: 40 });
  assert.equal(s.pages[2], undefined);                                               // no scale and a wrong area
});

test('a negative area that covers a whole positive area removes it instead of failing', () => {
  const r = cutout(pc, [dim('a', 'g1', rect(1, 1, 2, 2))], [dim('n', 'g1', rect(0, 0, 5, 5), -1)]);
  assert.deepEqual(r.pieces.get('a'), []); assert.ok(r.used.has('n'));
});

test('quick additions to one group are saved one after another, so none is lost', async () => {
  globalThis.window ||= { addEventListener() {} };                // core.js listens for page errors
  const { TakeoffStore } = await import('../public/js/tkstore.js');
  const server = { measured: [] }; let inFlight = 0, most = 0;
  const api = async (method, url, body) => {
    inFlight++; most = Math.max(most, inFlight);
    await new Promise(r => setTimeout(r, 20));                      // a slow network
    inFlight--;
    if (method === 'PATCH') { server.measured = body.props.measured; return { group: { id: 'g1', mtype: 'Count', props: { measured: server.measured } } }; }
    return {};
  };
  const st = new TakeoffStore({ projectId: () => 'p', canEdit: () => true, api });
  st.own.groups = [{ id: 'g1', mtype: 'Count', props: { measured: [] }, items: [] }];
  await Promise.all([1, 2, 3, 4, 5].map(i => st.addMeasured('g1', [{ id: 'c' + i, value: 1 }])));   // five clicks before any save returns
  assert.deepEqual(server.measured.map(m => m.id).sort(), ['c1', 'c2', 'c3', 'c4', 'c5']);
  assert.equal(most, 1);
  await Promise.all([st.updateDims(m => (m.id === 'c1' ? null : undefined)), st.addMeasured('g1', [{ id: 'c6', value: 1 }])]);
  assert.deepEqual(server.measured.map(m => m.id).sort(), ['c2', 'c3', 'c4', 'c5', 'c6']);
});
