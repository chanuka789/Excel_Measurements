// Geometry for on-screen take-off (2D drawings and 3D point mode). Pure functions, no DOM: shared by the
// drawing measure tool, the 3D viewer and the unit tests. Points are flat arrays: [x0, y0, x1, y1, ...] in 2D and
// [x0, y0, z0, ...] in 3D. 2D points are in drawing units; "scale" is metres per drawing unit.

export const pairs = (pts) => { const out = []; for (let i = 0; i + 1 < pts.length; i += 2) out.push([pts[i], pts[i + 1]]); return out; };
export const flat = (list) => list.flatMap(p => [p[0], p[1]]);

/** Polygon area (shoelace), always positive, in drawing units². */
export function polyArea(pts) {
  let a = 0; const n = pts.length / 2;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1]; }
  return Math.abs(a) / 2;
}
/** Length of an open polyline; closed adds the last segment back to the start (perimeter). */
export function polyLength(pts, closed = false) {
  let s = 0; const n = pts.length / 2;
  for (let i = 1; i < n; i++) s += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  if (closed && n > 2) s += Math.hypot(pts[0] - pts[2 * n - 2], pts[1] - pts[2 * n - 1]);
  return s;
}
export function centroid(pts) {
  const n = pts.length / 2; if (!n) return [0, 0];
  const a = polyArea(pts);
  if (n < 3 || a < 1e-12) { let x = 0, y = 0; for (let i = 0; i < n; i++) { x += pts[2 * i]; y += pts[2 * i + 1]; } return [x / n, y / n]; }
  let cx = 0, cy = 0, s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, f = pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
    cx += (pts[2 * i] + pts[2 * j]) * f; cy += (pts[2 * i + 1] + pts[2 * j + 1]) * f; s += f;
  }
  return [cx / (3 * s), cy / (3 * s)];
}
export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
  return { x0, y0, x1, y1 };
}
/** Rectangle from two opposite corners (Quickpoint). */
export const rectPts = (a, b) => [a[0], a[1], b[0], a[1], b[0], b[1], a[0], b[1]];

/**
 * Quantity of a 2D shape in metres: area → { value m², len perimeter m } (less its cutout holes, whose edges count in
 * the perimeter), length → { value m }, count → { value 1 }, distance → { value m },
 * rebar → { value total bar length, bars } (see rebarQty). Returns null when there are too few points or no scale.
 * m: the dimension, for its holes and rebar settings.
 */
export function measure2d(shape, pts, scale, m = {}) {
  if (!(scale > 0)) return null;
  if (m.ky > 0 && m.ky !== 1) {          // calibrated separately in Y: stretch the y values, then measure as usual
    const sy = (p) => p.map((v, i) => (i % 2 ? v * m.ky : v));
    pts = sy(pts); m = { ...m, ky: 1, ...(m.holes ? { holes: m.holes.map(sy) } : {}) };
  }
  const n = pts.length / 2;
  if (shape === 'area') {
    if (n < 3) return null;
    const holes = (m.holes || []).filter(h => h.length >= 6);
    return { value: Math.max(0, polyArea(pts) - holes.reduce((s, h) => s + polyArea(h), 0)) * scale * scale,
      len: (polyLength(pts, true) + holes.reduce((s, h) => s + polyLength(h, true), 0)) * scale };
  }
  if (shape === 'rebar') return n >= 4 ? rebarQty(pts, scale, m.rebar || {}) : null;
  if (shape === 'length' || shape === 'distance') return n >= 2 ? { value: polyLength(pts) * scale } : null;
  if (shape === 'count') return n >= 1 ? { value: 1 } : null;
  return null;
}

/** Paper size of one drawing unit in mm: PDF points (1/72 in), XPS/DWFx sheets (1/96 in); images have none. */
export const PAPER_MM = { pdf: 25.4 / 72, sheet: 25.4 / 96, svg: 25.4 / 96 };
/** Metres per drawing unit for a 1:ratio drawing. */
export const scaleFromRatio = (ratio, paperMm) => (ratio > 0 && paperMm > 0 ? paperMm / 1000 * ratio : 0);
export const ratioFromScale = (scale, paperMm) => (scale > 0 && paperMm > 0 ? scale * 1000 / paperMm : 0);
/** Calibration: two points a known distance apart (metres). */
export const scaleFromCalibration = (a, b, metres) => { const d = Math.hypot(b[0] - a[0], b[1] - a[1]); return d > 0 && metres > 0 ? metres / d : 0; };
export const RATIOS = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000, 1250, 2000, 2500, 5000];

/** Angle snap: the point b moved so the line a→b is at a multiple of `step` degrees (15° by default). */
export function angleSnap(a, b, step = 15) {
  const dx = b[0] - a[0], dy = b[1] - a[1], r = Math.hypot(dx, dy);
  if (!r) return b;
  const s = step * Math.PI / 180, t = Math.round(Math.atan2(dy, dx) / s) * s;
  return [a[0] + r * Math.cos(t), a[1] + r * Math.sin(t)];
}
/** Nearest point on the segment a-b to p, and its distance. */
export function nearestOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  const q = [a[0] + t * dx, a[1] + t * dy];
  return { q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}
/**
 * Rebar mode (CostX): pts = spacing line (2 points) then one bar (2 points). Bars = distance covered / spacing + 1,
 * total length = bars x (bar length + extra length per bar). spacing and extra in metres.
 */
export function rebarQty(pts, scale, { spacing = 0, extra = 0 } = {}) {
  const dist = Math.hypot(pts[2] - pts[0], pts[3] - pts[1]) * scale, bar = Math.hypot(pts[6] - pts[4], pts[7] - pts[5]) * scale;
  const bars = spacing > 0 ? Math.floor(dist / spacing + 1e-6) + 1 : 1;          // 5 m at 0.2 m = 26 bars, even when clicks give 4.9999999 m
  return { value: bars * (bar + (Number(extra) || 0)), bars, dist, bar };
}
/** Point inside polygon (even-odd). */
export function inside(p, pts) {
  let c = false; const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i], yi = pts[2 * i + 1], xj = pts[2 * j], yj = pts[2 * j + 1];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
/** Distance from p to a dimension's outline (lines and areas) or its point (counts). */
export function distToShape(p, shape, pts, holes = null) {
  const P = pairs(pts);
  if (!P.length) return Infinity;
  if (shape === 'count') return Math.min(...P.map(q => Math.hypot(p[0] - q[0], p[1] - q[1])));
  if (shape === 'area' && P.length >= 3 && inside(p, pts) && !(holes || []).some(h => inside(p, h))) return 0;
  let best = Infinity;
  const rings = shape === 'area' ? [P, ...(holes || []).map(pairs)] : [P];
  for (const R of rings) {
    const segs = shape === 'area' ? R.length : shape === 'rebar' ? 0 : R.length - 1;
    for (let i = 0; i < segs; i++) best = Math.min(best, nearestOnSegment(p, R[i], R[(i + 1) % R.length]).d);
  }
  if (shape === 'rebar' && P.length >= 4) best = Math.min(nearestOnSegment(p, P[0], P[1]).d, nearestOnSegment(p, P[2], P[3]).d);
  return best;
}
/** Index of the cutout hole of an area dimension at p (on its edge or inside it), or -1. */
export function holeAt(p, holes = [], tol = 0) {
  return holes.findIndex(h => inside(p, h) || pairs(h).some((q, i, R) => nearestOnSegment(p, q, R[(i + 1) % R.length]).d <= tol));
}
/** Move, rotate (degrees about c) and mirror (axis 'x' flips left-right, 'y' flips up-down about c) flat 2D points. */
export const movePts = (pts, dx, dy) => pts.map((v, i) => v + (i % 2 ? dy : dx));
export function rotatePts(pts, deg, c) {
  const r = deg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r), out = [];
  for (let i = 0; i + 1 < pts.length; i += 2) { const x = pts[i] - c[0], y = pts[i + 1] - c[1]; out.push(c[0] + x * cs - y * sn, c[1] + x * sn + y * cs); }
  return out;
}
export function mirrorPts(pts, axis, c) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i += 2) out.push(axis === 'x' ? 2 * c[0] - pts[i] : pts[i], axis === 'y' ? 2 * c[1] - pts[i + 1] : pts[i + 1]);
  return out;
}

/**
 * Spatial index of drawing line segments for the "sticky cursor": snap to line ends first, then to the nearest point on a line.
 * segs: flat [x0, y0, x1, y1, ...].
 */
export class SnapIndex {
  constructor(segs = [], cell = 0) {
    this.segs = segs; const n = segs.length / 4;
    let b = { x0: 0, y0: 0, x1: 1, y1: 1 };
    if (n) b = bbox(segs);
    this.cell = cell || Math.max((b.x1 - b.x0 + b.y1 - b.y0) / 400, 1e-6);
    this.grid = new Map();
    for (let i = 0; i < n; i++) {
      const x0 = segs[4 * i], y0 = segs[4 * i + 1], x1 = segs[4 * i + 2], y1 = segs[4 * i + 3];
      const cx0 = Math.floor(Math.min(x0, x1) / this.cell), cx1 = Math.floor(Math.max(x0, x1) / this.cell);
      const cy0 = Math.floor(Math.min(y0, y1) / this.cell), cy1 = Math.floor(Math.max(y0, y1) / this.cell);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 400) continue;          // very long lines (borders) are skipped
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const k = cx + ',' + cy; let l = this.grid.get(k); if (!l) this.grid.set(k, l = []); l.push(i);
      }
    }
  }
  get size() { return this.segs.length / 4; }
  /** Best snap within tol (drawing units): { p, kind: 'end'|'line' } or null. extra: more vertices to snap to (other dimensions). */
  find(p, tol, extra = []) {
    let end = null, endD = tol, line = null, lineD = tol * 0.75;
    for (const q of extra) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < endD) { endD = d; end = q; } }
    const r = Math.ceil(tol / this.cell), cx = Math.floor(p[0] / this.cell), cy = Math.floor(p[1] / this.cell), seen = new Set();
    for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) {
      for (const i of this.grid.get(x + ',' + y) || []) {
        if (seen.has(i)) continue; seen.add(i);
        const s = this.segs, a = [s[4 * i], s[4 * i + 1]], b = [s[4 * i + 2], s[4 * i + 3]];
        for (const q of [a, b]) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < endD) { endD = d; end = q; } }
        const n = nearestOnSegment(p, a, b); if (n.d < lineD) { lineD = n.d; line = n.q; }
      }
    }
    if (end) return { p: end, kind: 'end' };
    if (line) return { p: line, kind: 'line' };
    return null;
  }
}

/** Segments of an SVG path "d" (straight parts; curves become their end points), in the path's own units. */
export function pathSegments(d) {
  const out = []; const tok = String(d || '').match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  const num = () => Number(tok[i++]);
  const isNum = () => i < tok.length && !/[a-zA-Z]/.test(tok[i]);
  const line = (nx, ny) => { out.push(x, y, nx, ny); x = nx; y = ny; };
  while (i < tok.length) {
    if (/[a-zA-Z]/.test(tok[i])) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    if (C === 'Z') { if (x !== sx || y !== sy) line(sx, sy); continue; }
    if (!isNum()) { i++; continue; }
    if (C === 'M') { const nx = num() + (rel ? x : 0), ny = num() + (rel ? y : 0); x = sx = nx; y = sy = ny; cmd = rel ? 'l' : 'L'; }
    else if (C === 'L') line(num() + (rel ? x : 0), num() + (rel ? y : 0));
    else if (C === 'H') line(num() + (rel ? x : 0), y);
    else if (C === 'V') line(x, num() + (rel ? y : 0));
    else if (C === 'C') { num(); num(); num(); num(); line(num() + (rel ? x : 0), num() + (rel ? y : 0)); }
    else if (C === 'S' || C === 'Q') { num(); num(); line(num() + (rel ? x : 0), num() + (rel ? y : 0)); }
    else if (C === 'T') line(num() + (rel ? x : 0), num() + (rel ? y : 0));
    else if (C === 'A') { num(); num(); num(); num(); num(); line(num() + (rel ? x : 0), num() + (rel ? y : 0)); }
    else i++;
  }
  return out;
}

// ------------------------------------------------------------------ 3D point mode
/** Area of a flat (or nearly flat) 3D polygon, Newell's method, m². */
export function polyArea3(pts) {
  const n = pts.length / 3; let x = 0, y = 0, z = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, a = 3 * i, b = 3 * j;
    x += (pts[a + 1] - pts[b + 1]) * (pts[a + 2] + pts[b + 2]);
    y += (pts[a + 2] - pts[b + 2]) * (pts[a] + pts[b]);
    z += (pts[a] - pts[b]) * (pts[a + 1] + pts[b + 1]);
  }
  return Math.hypot(x, y, z) / 2;
}
export function polyLength3(pts, closed = false) {
  let s = 0; const n = pts.length / 3;
  const seg = (a, b) => Math.hypot(pts[3 * b] - pts[3 * a], pts[3 * b + 1] - pts[3 * a + 1], pts[3 * b + 2] - pts[3 * a + 2]);
  for (let i = 1; i < n; i++) s += seg(i - 1, i);
  if (closed && n > 2) s += seg(n - 1, 0);
  return s;
}
/** Area of a triangle soup [ax, ay, az, bx, ...] (face area measured with one click), m². */
export function trianglesArea(t) {
  let s = 0;
  for (let i = 0; i + 8 < t.length; i += 9) {
    const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2], vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
    s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return s;
}
export function measure3d(shape, pts) {
  const n = pts.length / 3;
  if (shape === 'area') return n >= 3 ? { value: polyArea3(pts), len: polyLength3(pts, true) } : null;
  if (shape === 'length' || shape === 'distance') return n >= 2 ? { value: polyLength3(pts) } : null;
  if (shape === 'count') return n >= 1 ? { value: 1 } : null;
  if (shape === 'face') return n >= 9 ? { value: trianglesArea(pts) } : null;
  return null;
}
/** Which on-screen shape a dimension group measures (CostX: the group's measurement type decides). */
export const shapeFor = (mtype) => ({ Area: 'area', Length: 'length', Count: 'count' })[mtype] || null;
