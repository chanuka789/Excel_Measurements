// Unit tests: on-screen take-off geometry (areas, lengths, scale, snapping, transforms, 3D point mode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../public/js/geom2d.js';
import { dimQuantity, groupToSpec, itemFactor } from '../public/js/dims.js';

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≈ ${b}`);

test('areas, perimeters and lengths at a scale', () => {
  const sq = [0, 0, 100, 0, 100, 50, 0, 50];
  near(G.polyArea(sq), 5000); near(G.polyLength(sq, true), 300); near(G.polyLength(sq), 250);
  const q = G.measure2d('area', sq, 0.01);                                  // 1 unit = 10 mm
  near(q.value, 0.5); near(q.len, 3);
  near(G.measure2d('length', [0, 0, 300, 400], 0.01).value, 5);
  assert.equal(G.measure2d('area', [0, 0, 1, 1], 1), null);                  // too few points
  assert.equal(G.measure2d('area', sq, 0), null);                            // no scale
  assert.equal(G.measure2d('count', [3, 4], 1).value, 1);
  assert.deepEqual(G.centroid(sq), [50, 25]);
});

test('scale from 1:N paper scales and from calibration', () => {
  const s = G.scaleFromRatio(100, G.PAPER_MM.pdf);                           // 1 pt on paper = 0.3528 mm, x100
  near(s, 25.4 / 72 / 1000 * 100);
  near(G.ratioFromScale(s, G.PAPER_MM.pdf), 100);
  near(G.scaleFromCalibration([0, 0], [200, 0], 5), 0.025);
  assert.equal(G.scaleFromCalibration([0, 0], [0, 0], 5), 0);
});

test('angle snap, nearest point, hit testing and transforms', () => {
  const p = G.angleSnap([0, 0], [10, 0.4]); near(p[1], 0); near(p[0], Math.hypot(10, 0.4));
  const q = G.angleSnap([0, 0], [10, 9]); near(Math.atan2(q[1], q[0]) * 180 / Math.PI, 45);
  near(G.nearestOnSegment([5, 3], [0, 0], [10, 0]).d, 3);
  const sq = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.equal(G.inside([5, 5], sq), true); assert.equal(G.inside([15, 5], sq), false);
  assert.equal(G.distToShape([5, 5], 'area', sq), 0); near(G.distToShape([5, 12], 'length', [0, 10, 10, 10]), 2);
  assert.deepEqual(G.movePts([1, 2, 3, 4], 10, 20), [11, 22, 13, 24]);
  const r = G.rotatePts([1, 0], 90, [0, 0]); near(r[0], 0); near(r[1], 1);
  assert.deepEqual(G.mirrorPts([1, 2, 3, 4], 'x', [2, 0]), [3, 2, 1, 4]);
  assert.deepEqual(G.rectPts([0, 0], [4, 3]), [0, 0, 4, 0, 4, 3, 0, 3]);
});

test('the sticky cursor snaps to line ends first, then onto lines', () => {
  const idx = new G.SnapIndex([0, 0, 100, 0, 100, 0, 100, 100]);
  assert.deepEqual(idx.find([99, 1.5], 3), { p: [100, 0], kind: 'end' });
  const l = idx.find([50, 1], 3); assert.equal(l.kind, 'line'); near(l.p[1], 0);
  assert.equal(idx.find([50, 50], 3), null);
  assert.equal(idx.find([50, 50], 3, [[51, 51]]).kind, 'end');               // other dimensions' corners
});

test('SVG path segments (DWFx sheets)', () => {
  assert.deepEqual(G.pathSegments('M0,0 L10,0 L10,5 Z'), [0, 0, 10, 0, 10, 0, 10, 5, 10, 5, 0, 0]);
  assert.deepEqual(G.pathSegments('m1 1 h4 v2'), [1, 1, 5, 1, 5, 1, 5, 3]);
});

test('3D point mode: polygon area in any plane, lengths and face triangles', () => {
  near(G.polyArea3([0, 0, 0, 2, 0, 0, 2, 0, 3, 0, 0, 3]), 6);               // a 2 x 3 wall
  near(G.measure3d('area', [0, 0, 0, 2, 0, 0, 2, 0, 3, 0, 0, 3]).len, 10);
  near(G.measure3d('length', [0, 0, 0, 3, 4, 0]).value, 5);
  near(G.trianglesArea([0, 0, 0, 1, 0, 0, 0, 1, 0]), 0.5);
  assert.equal(G.shapeFor('Volume'), null); assert.equal(G.shapeFor('Count'), 'count');
});

test('drawing multiplier multiplies measured dimensions, in totals and in the Excel factor', () => {
  const g = { mtype: 'Area', props: { multiplier: 1, measured: [{ label: 'A', value: 10, sign: 1, multiplier: 1, dmult: 10, src: { name: 'Typical floor' } }] } };
  assert.equal(itemFactor(g.props.measured[0]), 10);
  assert.equal(dimQuantity(g, 10, g.props.measured[0]), 100);
  const spec = groupToSpec(g, new Map());
  assert.ok(spec.inputs.some(i => i.key === 'Factor'));
  assert.equal(spec.manual[0].v.Factor, 10);
  assert.equal(spec.manual[0].label, 'A · Typical floor');
});
