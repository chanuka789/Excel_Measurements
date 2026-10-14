// Merging the outputs of the processing steps into the element data. Pure functions, shared by the server
// (src/processing.js) and the browser processing worker (public/js/procworker.js), so both give the same model.

/** Header of a packed geometry.bin (Uint8Array or Buffer). */
export function binHeader(bin) {
  const u8 = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
  const hl = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(4, true);
  return JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
}

export const QS_VERSION = 1;
const QS_PRIORITY = ['foundation', 'column', 'wall', 'framing', 'beam', 'floor', 'slab', 'roof', 'stair'];
const prioOf = (cat) => { const c = String(cat || '').toLowerCase(); const i = QS_PRIORITY.findIndex(w => c.includes(w)); return i < 0 ? QS_PRIORITY.length : i; };
/**
 * Add the QS face analysis (py/qs.py) to the elements: formwork faces, propping bands, ground and roof faces,
 * outer faces and the net concrete volume (overlaps counted once, in the element with the higher priority:
 * foundations, columns, walls, beams, slabs). Raw data stays in e.qs for the rules (waterproofing by level).
 */
export function mergeQs(elements, qs) {
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const byId = new Map(elements.elements.map(e => [String(e.id), e]));
  const lose = new Map();
  for (const [a, b, v] of qs.overlaps || []) {
    const ea = byId.get(String(a)), eb = byId.get(String(b)); if (!ea || !eb) continue;
    const pa = prioOf(ea.cat), pb = prioOf(eb.cat);
    const loser = pa < pb ? eb : pb < pa ? ea : (a < b ? eb : ea);
    lose.set(loser.id, (lose.get(loser.id) || 0) + v);
  }
  for (const [id, q] of Object.entries(qs.elements || {})) {
    const e = byId.get(id); if (!e) continue;
    const set = (n, v, u) => { if (v != null && Number.isFinite(v)) e.q[n] = [r3(v), u]; };
    const sides = q.sides || [];
    const narrow = sides.filter(s => s[4]), outer = sides.filter(s => s[3]);
    set('FW soffit', q.soffit, 'm2');
    for (const [b, v] of Object.entries(q.soffitBands || {})) set(`FW soffit ${b} m`, v, 'm2');
    set('FW sloping soffit', q.slopeSoffit, 'm2');
    set('FW sides', q.side, 'm2');
    set('FW narrow sides', narrow.reduce((t, s) => t + s[0], 0), 'm2');
    set('FW narrow length', narrow.reduce((t, s) => t + s[5], 0), 'm');
    set('FW wide sides', q.side - narrow.reduce((t, s) => t + s[0], 0), 'm2');
    set('FW sloping top', q.topSlope, 'm2');
    set('Area on ground', q.ground, 'm2');
    set('Top exposed', q.topExposed, 'm2');
    set('Exposed perimeter', q.exposedPerim, 'm');
    set('Outer face area', outer.reduce((t, s) => t + s[0], 0), 'm2');
    if (outer.length) { set('Outer face bottom', Math.min(...outer.map(s => s[1])), 'm'); set('Outer face top', Math.max(...outer.map(s => s[2])), 'm'); }
    set('Bottom level', q.zlo, 'm'); set('Top level', q.zhi, 'm');
    set('Thickness (geometry)', q.thick, 'm');
    const base = e.q['Geo volume']?.[0] ?? e.q.Volume?.[0];
    if (base != null) set('Net volume', Math.max(0, base - (lose.get(e.id) || 0)), 'm3');
    e.qs = { sides, bands: q.soffitBands || {}, covered: q.covered || {}, box: q.box };
  }
  elements.qsVersion = QS_VERSION;
}

/** Add exact quantities measured from the 3D geometry to each element (kept separate from Revit's values). */
export function mergeMetrics(elements, metrics, geometryBin) {
  let up = 'y';
  if (geometryBin && geometryBin.length > 8) {
    try { up = binHeader(geometryBin).up || 'y'; } catch { /* keep default */ }
  }
  const ax = { x: 0, y: 1, z: 2 }[up] ?? 1, hz = [0, 1, 2].filter(i => i !== ax);
  elements.up = up;
  for (const e of elements.elements) {
    const m = metrics[String(e.id)]; if (!m) continue;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const ext = [0, 1, 2].map(i => m.bb[i + 3] - m.bb[i]);
    const [L, W] = hz.map(i => ext[i]).sort((a, b) => b - a);
    e.bb = m.bb;
    if (m.solid) e.q['Geo volume'] = [r3(m.vol), 'm3'];
    e.q['Geo surface area'] = [r3(m.area), 'm2'];
    e.q['Geo top area'] = [r3(m.top), 'm2'];
    e.q['Geo bottom area'] = [r3(m.bottom), 'm2'];
    e.q['Geo side area'] = [r3(m.side), 'm2'];
    e.q['Geo plan area'] = [r3(m.plan), 'm2'];
    e.q['Geo box length'] = [r3(L), 'm'];
    e.q['Geo box width'] = [r3(W), 'm'];
    e.q['Geo box height'] = [r3(ext[ax]), 'm'];
  }
}

/** Python's round(x, 4) for the values qs.py writes (round half to even on the exact decimal is not needed at this size). */
const r4 = (x) => { const v = Math.round(Number(x) * 1e4) / 1e4; return Object.is(v, -0) ? 0 : v; };
const SUMS = ['soffit', 'ground', 'slopeSoffit', 'side', 'topSlope', 'top', 'topExposed', 'exposedPerim'];
/**
 * Add up the parts of py/qs.py run as "i/n" (the browser runs them in parallel workers): the same rules as the
 * process pool in qs.py (sums, sides in part order, per-key sums), then the same rounding as a single run.
 */
export function joinQsParts(parts) {
  parts = [...parts].sort((a, b) => a.part[0] - b.part[0]);
  const first = parts[0], elements = {};
  for (const [id, q0] of Object.entries(first.elements)) {
    const q = { ...q0, sides: [...q0.sides], soffitBands: { ...q0.soffitBands }, covered: { ...q0.covered } };
    for (const p of parts.slice(1)) {
      const o = p.elements[id]; if (!o) continue;
      for (const k of SUMS) q[k] += o[k];
      q.sides.push(...o.sides);
      for (const dk of ['soffitBands', 'covered']) for (const [k, v] of Object.entries(o[dk])) q[dk][k] = (q[dk][k] || 0) + v;
    }
    for (const k of SUMS) q[k] = r4(q[k]);
    for (const dk of ['soffitBands', 'covered']) q[dk] = Object.fromEntries(Object.entries(q[dk]).filter(([, v]) => v > 1e-6).map(([k, v]) => [k, r4(v)]));
    elements[id] = q;
  }
  return { version: first.version, up: first.up, elements, overlaps: first.overlaps };
}
