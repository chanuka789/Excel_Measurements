// CAD drawings (DWG through LibreDWG, DXF through dxf-parser) to an SVG that the drawing take-off can measure:
// one <g data-layer> per layer, blocks expanded, arcs and curves as short straight segments, y pointing down.
// One SVG unit is one drawing unit; data-unit-m says how many metres that is (from $INSUNITS), so the scale is
// known without calibration (CostX: CAD drawings are 1:1). Pure functions: used by the worker and the unit tests.

/** $INSUNITS → metres per drawing unit (0 = unitless: the user calibrates). */
export const UNIT_M = { 1: 0.0254, 2: 0.3048, 3: 1609.344, 4: 0.001, 5: 0.01, 6: 1, 7: 1000, 8: 2.54e-8, 9: 2.54e-5, 10: 0.9144, 14: 0.1, 15: 10, 16: 100 };
const ACI = ['#000000', '#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#000000', '#808080', '#c0c0c0'];
const MAX_SEGS = 600000, MAX_DEPTH = 8;

const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const P = (p) => (p ? [Number(p.x) || 0, Number(p.y) || 0] : null);
/** A colour that shows on a white sheet: white / very light CAD colours become black. */
function colour(e, layerColour) {
  const i = e.colorIndex ?? e.color;
  let c = null;
  if (typeof e.color === 'number' && e.color > 255 && e.colorIndex == null) c = '#' + e.color.toString(16).padStart(6, '0');
  else if (Number.isInteger(i) && i >= 1 && i <= 9) c = ACI[i];
  else if (i === 256 || i == null || i === 0) c = layerColour;
  if (!c) c = '#000000';
  const n = parseInt(c.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255, lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum > 235) return '#000000';                                        // white lines on a white sheet
  if (lum <= 140) return c;
  const k = 140 / lum, h = (v) => Math.round(v * k).toString(16).padStart(2, '0');   // darker yellow, cyan... so they read on white
  return `#${h(r)}${h(g)}${h(b)}`;
}
// 2D affine transforms [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const app = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const insertMatrix = (pos, sx, sy, rot, base) => {
  const c = Math.cos(rot), s = Math.sin(rot);
  return mul([1, 0, 0, 1, pos[0], pos[1]], mul([c * sx, s * sx, -s * sy, c * sy, 0, 0], [1, 0, 0, 1, -base[0], -base[1]]));
};
/** Points of an arc (angles in radians, counter-clockwise from a to b). */
function arcPts(c, r, a, b, steps = 0) {
  while (b <= a) b += 2 * Math.PI;
  const n = steps || Math.max(4, Math.min(96, Math.ceil((b - a) / (Math.PI / 24))));
  const out = []; for (let i = 0; i <= n; i++) { const t = a + (b - a) * i / n; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
  return out;
}
/** Polyline vertices with bulges (arcs between vertices) as points. */
function bulgePts(vs, closed) {
  const out = [];
  const n = vs.length;
  for (let i = 0; i < n; i++) {
    const a = P(vs[i]); out.push(a);
    const bulge = Number(vs[i].bulge) || 0;
    if (!bulge || (i === n - 1 && !closed)) continue;
    const b = P(vs[(i + 1) % n]);
    const th = 4 * Math.atan(bulge), d = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!d) continue;
    const r = d / (2 * Math.sin(Math.abs(th) / 2));
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, h = Math.sqrt(Math.max(r * r - d * d / 4, 0));
    const ux = -(b[1] - a[1]) / d, uy = (b[0] - a[0]) / d, sgn = (bulge > 0 ? 1 : -1) * (Math.abs(th) > Math.PI ? -1 : 1);
    const c = [mx + ux * h * sgn, my + uy * h * sgn];
    let s = Math.atan2(a[1] - c[1], a[0] - c[0]), e = Math.atan2(b[1] - c[1], b[0] - c[0]);
    if (bulge < 0) [s, e] = [e, s];
    const arc = arcPts(c, Math.abs(r), s, e);
    if (bulge < 0) arc.reverse();
    out.push(...arc.slice(1, -1));
  }
  return out;
}

/**
 * Normalise the parsed drawing. src: 'dwg' (LibreDWG DwgDatabase) or 'dxf' (dxf-parser result).
 * Returns { unitM, layers: Map(name → {colour, on}), paths: [{ layer, colour, pts, closed }], texts: [{ layer, colour, x, y, h, rot, text }] }.
 */
export function normalise(db, src) {
  const out = { unitM: 0, layers: new Map(), paths: [], texts: [], segs: 0 };
  const layerList = src === 'dwg' ? (db.tables?.LAYER?.entries || []) : Object.values(db.tables?.layer?.layers || {});
  for (const l of layerList) {
    const ci = src === 'dwg' ? l.colorIndex : l.colorIndex ?? l.color;
    const on = src === 'dwg' ? !(l.off || (l.flag & 1) || l.frozen) : l.visible !== false && !l.frozen;
    out.layers.set(String(l.name), { colour: Number.isInteger(ci) && ci >= 1 && ci <= 9 ? ACI[Math.abs(ci)] : (typeof l.color === 'number' && l.color > 255 ? '#' + l.color.toString(16).padStart(6, '0') : '#000000'), on });
  }
  const units = src === 'dwg' ? db.header?.INSUNITS : db.header?.$INSUNITS;
  out.unitM = UNIT_M[units] || 0;
  const blocks = new Map();
  if (src === 'dwg') for (const b of db.tables?.BLOCK_RECORD?.entries || []) blocks.set(b.name, { ents: b.entities || [], base: P(b.basePoint) || [0, 0] });
  else for (const [name, b] of Object.entries(db.blocks || {})) blocks.set(name, { ents: b.entities || [], base: P(b.position) || [0, 0] });
  const layerOf = (e, parent) => (e.layer && e.layer !== '0' ? String(e.layer) : parent || String(e.layer || '0'));
  const deg = src === 'dxf';                        // dxf-parser gives INSERT / TEXT rotations in degrees, LibreDWG in radians
  const path = (layer, col, m, pts, closed = false) => {
    if (!pts || pts.length < 2 || out.segs > MAX_SEGS) return;
    const q = pts.map(p => app(m, p)).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (q.length < 2) return;
    out.segs += q.length; out.paths.push({ layer, colour: col, pts: q, closed });
  };
  const walk = (ents, m, depth, parentLayer) => {
    for (const e of ents) {
      if (e.isVisible === false || e.visible === false) continue;
      const layer = layerOf(e, parentLayer);
      if (!out.layers.has(layer)) out.layers.set(layer, { colour: '#000000', on: true });
      const col = colour(e, out.layers.get(layer).colour);
      const t = e.type;
      if (t === 'LINE') path(layer, col, m, src === 'dwg' ? [P(e.startPoint), P(e.endPoint)] : (e.vertices || []).map(P));
      else if (t === 'LWPOLYLINE' || t === 'POLYLINE' || t === 'POLYLINE2D' || t === 'POLYLINE3D') {
        const closed = Boolean(e.shape || e.closed || (e.flag & 1) || (e.flags & 1));
        const vs = (e.vertices || []).filter(v => v && !(v.flag & 16));
        path(layer, col, m, bulgePts(vs, closed), closed);
      } else if (t === 'CIRCLE') path(layer, col, m, arcPts(P(e.center), e.radius, 0, 2 * Math.PI, 72), true);
      else if (t === 'ARC') {
        const a = deg && Math.abs(e.startAngle) > 2 * Math.PI + 0.01 ? e.startAngle * Math.PI / 180 : e.startAngle;
        const b = deg && Math.abs(e.endAngle) > 2 * Math.PI + 0.01 ? e.endAngle * Math.PI / 180 : e.endAngle;
        path(layer, col, m, arcPts(P(e.center), e.radius, a, b));
      } else if (t === 'ELLIPSE') {
        const c = P(e.center), maj = P(e.majorAxisEndPoint || e.majorAxis), ratio = e.axisRatio ?? e.minorToMajorRatio ?? 1;
        let a = e.startAngle ?? e.startParameter ?? 0, b = e.endAngle ?? e.endParameter ?? 2 * Math.PI; while (b <= a) b += 2 * Math.PI;
        const pts = []; const n = 72;
        for (let i = 0; i <= n; i++) { const s = a + (b - a) * i / n, x = Math.cos(s), y = Math.sin(s) * ratio; pts.push([c[0] + maj[0] * x - maj[1] * y, c[1] + maj[1] * x + maj[0] * y]); }
        path(layer, col, m, pts);
      } else if (t === 'SPLINE') {
        const pts = (e.fitPoints?.length ? e.fitPoints : e.controlPoints || []).map(P).filter(Boolean);
        path(layer, col, m, pts);
      } else if (t === 'SOLID' || t === '3DFACE' || t === 'TRACE') {
        const cs = [e.corner1, e.corner2, e.corner4 || e.corner3, e.corner3].map(P).filter(Boolean);
        const pts = (e.points || []).map(P).filter(Boolean);
        path(layer, col, m, pts.length ? pts : cs, true);
      } else if (t === 'HATCH') {
        for (const b of e.boundaryPaths || []) {
          if (b.vertices?.length) path(layer, col, m, bulgePts(b.vertices, true), true);
          for (const ed of b.edges || []) {
            if (ed.start && ed.end) path(layer, col, m, [P(ed.start), P(ed.end)]);
            else if (ed.center && ed.radius) path(layer, col, m, arcPts(P(ed.center), ed.radius, ed.startAngle || 0, ed.endAngle || 2 * Math.PI));
          }
        }
      } else if (t === 'POINT') { const p = P(e.position); if (p) path(layer, col, m, [[p[0] - 0.5, p[1]], [p[0] + 0.5, p[1]]]); }
      else if (t === 'TEXT' || t === 'MTEXT' || t === 'ATTRIB' || t === 'ATTDEF') {
        if (t === 'ATTDEF') continue;
        const tx = typeof e.text === 'string' ? e.text : e.text?.text;
        const pos = P(e.startPoint || e.insertionPoint || e.position || e.text?.startPoint);
        if (!tx || !pos) continue;
        const clean = String(tx).replace(/\\[A-Za-z][^;\\]*;/g, '').replace(/\\P/g, ' ').replace(/[{}]/g, '').replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').slice(0, 300);
        const h = Number(e.textHeight || e.height || e.text?.textHeight) || 2.5;
        let rot = Number(e.rotation ?? e.text?.rotation) || 0; if (deg || Math.abs(rot) > 2 * Math.PI + 0.01) rot = rot * Math.PI / 180;
        const p = app(m, pos), sc = Math.hypot(m[0], m[1]) || 1;
        out.texts.push({ layer, colour: col, x: p[0], y: p[1], h: h * sc, rot: rot + Math.atan2(m[1], m[0]), text: clean });
      } else if (t === 'INSERT' || t === 'DIMENSION') {
        if (depth >= MAX_DEPTH) continue;
        const b = blocks.get(t === 'DIMENSION' ? e.name || e.block : e.name); if (!b) continue;
        let rot = Number(e.rotation) || 0; if (deg) rot = rot * Math.PI / 180;
        const pos = t === 'DIMENSION' ? [0, 0] : P(e.insertionPoint || e.position) || [0, 0];
        const sx = t === 'DIMENSION' ? 1 : Number(e.xScale ?? 1) || 1, sy = t === 'DIMENSION' ? 1 : Number(e.yScale ?? 1) || 1;
        const cols = Math.max(1, Number(e.columnCount) || 1), rows = Math.max(1, Number(e.rowCount) || 1);
        for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
          const off = [pos[0] + i * (Number(e.columnSpacing) || 0), pos[1] + j * (Number(e.rowSpacing) || 0)];
          walk(b.ents, mul(m, insertMatrix(off, sx, sy, rot, t === 'DIMENSION' ? [0, 0] : b.base)), depth + 1, layer);
        }
      }
    }
  };
  const top = db.entities || [];
  // LibreDWG lists model space and paper space entities together: keep the model space ones (owner = *Model_Space) when it is known
  const ms = src === 'dwg' ? (db.tables?.BLOCK_RECORD?.entries || []).find(b => /^\*model_space$/i.test(b.name)) : null;
  walk(ms ? top.filter(e => !e.ownerBlockRecordSoftId || e.ownerBlockRecordSoftId === ms.handle) : top, [1, 0, 0, 1, 0, 0], 0, null);
  return out;
}

/** Extents of the normalised drawing, ignoring stray far-away points (5% / 95% of every coordinate, padded). */
export function extents(n) {
  const xs = [], ys = [];
  for (const p of n.paths) for (const q of p.pts) { xs.push(q[0]); ys.push(q[1]); }
  for (const t of n.texts) { xs.push(t.x); ys.push(t.y); }
  if (!xs.length) return { x0: 0, y0: 0, x1: 1000, y1: 700 };
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const pick = (a, f) => a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * f)))];
  const lo = (a) => (a.length > 50 ? pick(a, 0.005) : a[0]), hi = (a) => (a.length > 50 ? pick(a, 0.995) : a[a.length - 1]);
  let x0 = lo(xs), x1 = hi(xs), y0 = lo(ys), y1 = hi(ys);
  const pad = Math.max(x1 - x0, y1 - y0, 1) * 0.03;
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** The SVG: y flipped (CAD y up → SVG y down), one group per layer. */
export function toSvg(n) {
  const b = extents(n), W = b.x1 - b.x0, H = b.y1 - b.y0;
  const f = (v) => (Math.round(v * 1000) / 1000).toString();
  const X = (x) => f(x - b.x0), Y = (y) => f(b.y1 - y);
  const sw = Math.max(W, H) / 2500;
  const byLayer = new Map();
  for (const [name] of n.layers) byLayer.set(name, []);
  for (const p of n.paths) {
    const d = 'M' + p.pts.map(q => X(q[0]) + ',' + Y(q[1])).join('L') + (p.closed ? 'Z' : '');
    byLayer.get(p.layer).push(`<path d="${d}" stroke="${p.colour}"/>`);
  }
  for (const t of n.texts) {
    const rot = -t.rot * 180 / Math.PI;
    byLayer.get(t.layer).push(`<text x="${X(t.x)}" y="${Y(t.y)}" font-size="${f(t.h)}" fill="${t.colour}"${rot ? ` transform="rotate(${f(rot)} ${X(t.x)} ${Y(t.y)})"` : ''}>${esc(t.text)}</text>`);
  }
  const groups = [...byLayer].filter(([, list]) => list.length).map(([name, list]) =>
    `<g data-layer="${esc(name)}"${n.layers.get(name)?.on === false ? ' display="none"' : ''}>${list.join('')}</g>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(W)} ${f(H)}" width="${f(W)}" height="${f(H)}" data-unit-m="${n.unitM}" data-origin="${f(b.x0)},${f(b.y1)}">` +
    `<rect width="100%" height="100%" fill="#fff"/><g fill="none" stroke-width="${f(sw)}" stroke-linecap="round" stroke-linejoin="round" font-family="Arial, sans-serif">\n${groups}\n</g></svg>`;
}
