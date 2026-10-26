// The element classification a QS would make (kind, material, thickness), the quantities worked out from the
// geometry (formwork faces, area on ground, ...) and the project assumptions (reinforcement rates, ground level).
// Pure module: shared by the Schedules window, the AI and the tests. No measurement-standard formats (NRM/POMI).
import { dimsOf } from './engine.js';

// ================================================================== classification (thinking as a QS)
const STEEL_TYPE = /^(UKB|UKC|UB|UC|PFC|HEA|HEB|IPE|UPN|CHS|SHS|RHS|W\d|HSS|L\d)/i;
export function materialOf(e) {
  const m = String(e.props?.['Structural Material'] || e.props?.Material || e.props?.['Material'] || '').toLowerCase();
  const t = `${e.type} ${e.fam}`;
  if (/precast|pre-cast|\bpc\b/.test(m)) return 'precast';
  if (/steel|metal|s275|s355|43-275|50-355/.test(m) || STEEL_TYPE.test(e.type || '')) return 'steel';
  if (/concrete|cip|in-situ|insitu|\brc\b/.test(m) || /\b(rc|cip)\b|concrete/i.test(t)) return 'insitu';
  if (/timber|wood|glulam/.test(m)) return 'timber';
  if (/masonry|block|brick/.test(m)) return 'masonry';
  return /structural|floor|wall|stair|run|landing|roof|slab|foundation|framing|column/i.test(e.cat || '') ? 'insitu' : 'other';
}
const q = (e, n) => e.q?.[n]?.[0] ?? 0;
/** The kind of element a QS sees: pile, pilecap, footing, raft, groundbeam, beam, column, slab, groundslab, roofslab, wall, stair, other. */
export function kindOf(e) {
  const cat = String(e.cat || ''), t = `${e.fam} ${e.type}`.toLowerCase();
  const lv = String(e.level || '').toLowerCase();
  const bb = e.bb ? [e.bb[3] - e.bb[0], e.bb[4] - e.bb[1], e.bb[5] - e.bb[2]] : null;
  const plan = q(e, 'Geo plan area') || q(e, 'Area');
  if (/foundation/i.test(cat)) {
    if (/pile/.test(t) && !/cap/.test(t)) return 'pile';
    if (/cap/.test(t)) return 'pilecap';
    if (/raft|mat\b/.test(t) || plan > 50) return 'raft';
    if (/slab|bed|ground/.test(t)) return 'groundslab';
    if (/beam|tie/.test(t)) return 'groundbeam';
    if (bb) { const h = q(e, 'Geo box height'), wmax = Math.max(q(e, 'Geo box length'), q(e, 'Geo box width')); if (h > 3 * Math.max(wmax, 0.1)) return 'pile'; }
    return 'footing';
  }
  if (/framing/i.test(cat)) return /ground beam|tie beam|grade beam|\bgb\b/.test(t) || q(e, 'Area on ground') > 0.5 * Math.max(q(e, 'Geo bottom area'), 1e-9) ? 'groundbeam' : 'beam';
  if (/column/i.test(cat)) return 'column';
  if (/roof/i.test(cat)) return 'roofslab';
  if (/^floors?$|slab/i.test(cat)) {
    const bottom = q(e, 'Geo bottom area') || plan;
    if (q(e, 'Area on ground') > 0.5 * bottom || /ground|grade|\bsog\b|bed\b/i.test(t) || /ground|gf|level\s*0\b/i.test(lv)) return 'groundslab';
    if (q(e, 'Top exposed') > 0.5 * (q(e, 'Geo top area') || plan) || /roof/i.test(t) || /roof/i.test(lv)) return 'roofslab';
    return 'slab';
  }
  if (/roof/i.test(t) && !/beam|column|wall|truss/i.test(t)) return 'roofslab';
  if (/^walls?$/i.test(cat) || /\bwall\b/i.test(t)) return 'wall';
  if (/stair|runs|landing|ramp/i.test(cat)) return 'stair';
  return 'other';
}

/** Element thickness in metres (null if unknown). */
export function elementThickness(e) {
  if (!e) return null;
  const tg = e.q?.['Thickness (geometry)']?.[0];
  if (tg != null && tg > 0) return tg;

  const rawThick = e.q?.['Thickness']?.[0] ?? e.props?.['Thickness'] ?? e.props?.['Default Thickness'] ?? e.props?.['Wall Thickness'] ?? e.props?.['Core Thickness'];
  if (typeof rawThick === 'number' && rawThick > 0) {
    return rawThick > 10 ? rawThick / 1000 : rawThick;
  }
  if (typeof rawThick === 'string') {
    const num = parseFloat(rawThick.replace(/,/g, ''));
    if (!isNaN(num) && num > 0) return /mm/i.test(rawThick) || num > 10 ? num / 1000 : num;
  }

  const kind = kindOf(e);
  if (kind === 'wall') {
    const w = e.q?.['Width']?.[0] ?? e.props?.['Width'];
    if (typeof w === 'number' && w > 0) return w > 10 ? w / 1000 : w;
    if (typeof w === 'string') {
      const num = parseFloat(w.replace(/,/g, ''));
      if (!isNaN(num) && num > 0) return /mm/i.test(w) || num > 10 ? num / 1000 : num;
    }
  }

  const str = `${e.type || ''} ${e.fam || ''}`;
  const m1 = /(?:^|[^\d])(\d{2,4})\s*(?:mm\b|\bthk\b|\bthick\b)/i.exec(str);
  if (m1) return parseInt(m1[1], 10) / 1000;

  const m2 = /\b(?:slab|wall|floor|roof|bed|plate|rcw|retaining)\D*(\d{2,4})\b/i.exec(str);
  if (m2) {
    const val = parseInt(m2[1], 10);
    if (val >= 50 && val <= 2000) return val / 1000;
  }

  const m3 = /\b(\d{2,4})\D*(?:slab|wall|floor|roof)\b/i.exec(str);
  if (m3) {
    const val = parseInt(m3[1], 10);
    if (val >= 50 && val <= 2000) return val / 1000;
  }

  if (e.bb && e.bb.length >= 6) {
    const dx = Math.abs(e.bb[3] - e.bb[0]);
    const dy = Math.abs(e.bb[4] - e.bb[1]);
    const dz = Math.abs(e.bb[5] - e.bb[2]);
    if (['slab', 'groundslab', 'roofslab', 'raft'].includes(kind)) {
      if (dz >= 0.05 && dz <= 1.5) return Math.round(dz * 1000) / 1000;
    } else if (kind === 'wall') {
      const minH = Math.min(dx, dy);
      if (minH >= 0.05 && minH <= 1.5) return Math.round(minH * 1000) / 1000;
    }
  }

  const vol = e.q?.['Net volume']?.[0] ?? e.q?.['Geo volume']?.[0] ?? e.q?.Volume?.[0];
  const area = e.q?.['Geo plan area']?.[0] ?? e.q?.['Geo bottom area']?.[0] ?? e.q?.['Geo top area']?.[0] ?? e.q?.Area?.[0];
  if (vol && area && area > 0) {
    const t = vol / area;
    if (t >= 0.05 && t <= 1.5) return Math.round(t * 1000) / 1000;
  }

  return null;
}

/** Populate missing QS quantities (thickness, formwork faces, area on ground) from element geometry. */
export function enrichElementQs(e) {
  if (!e) return;
  if (!e.q) e.q = {};
  const kind = kindOf(e);
  const mat = materialOf(e);
  if (!['insitu', 'precast'].includes(mat) && mat !== 'steel') return;
  const existing = new Set(Object.keys(e.q));

  const t = elementThickness(e);
  if (t != null && !e.q['Thickness (geometry)']) {
    e.q['Thickness (geometry)'] = [t, 'm'];
  }

  const vol = e.q['Net volume']?.[0] ?? e.q['Geo volume']?.[0] ?? e.q.Volume?.[0] ?? 0;
  const thk = t || e.q['Thickness (geometry)']?.[0] || null;

  if (['slab', 'roofslab'].includes(kind)) {
    const bottom = e.q['Geo bottom area']?.[0] || e.q.Area?.[0] || e.q['Geo plan area']?.[0] || (vol && thk ? vol / thk : 0);
    const hasSoffit = Object.keys(e.q).some(k => k.startsWith('FW soffit'));
    if (!hasSoffit && bottom > 0) {
      e.q['FW soffit'] = [bottom, 'm2'];
    }
    const hasSide = Object.keys(e.q).some(k => k.startsWith('FW narrow') || k.startsWith('FW wide') || k === 'FW sides');
    const perim = e.q['Exposed perimeter']?.[0] || e.q.Perimeter?.[0] || (e.bb ? 2 * (Math.abs(e.bb[3] - e.bb[0]) + Math.abs(e.bb[4] - e.bb[1])) : 0);
    if (!hasSide && perim > 0 && thk != null) {
      if (thk <= 0.5) e.q['FW narrow length'] = [perim, 'm'];
      else e.q['FW wide sides'] = [perim * thk, 'm2'];
    }
    if (kind === 'roofslab') {
      const top = e.q['Geo top area']?.[0] || e.q.Area?.[0] || e.q['Geo plan area']?.[0] || bottom;
      if (!e.q['Top exposed'] && top > 0) e.q['Top exposed'] = [top, 'm2'];
      if (!e.q['Exposed perimeter'] && perim > 0) e.q['Exposed perimeter'] = [perim, 'm'];
    }
  } else if (kind === 'groundslab') {
    const bottom = e.q['Geo bottom area']?.[0] || e.q.Area?.[0] || e.q['Geo plan area']?.[0] || (vol && thk ? vol / thk : 0);
    if (!e.q['Area on ground'] && bottom > 0) e.q['Area on ground'] = [bottom, 'm2'];
    const hasSide = Object.keys(e.q).some(k => k.startsWith('FW narrow') || k.startsWith('FW wide') || k === 'FW sides');
    const perim = e.q.Perimeter?.[0] || (e.bb ? 2 * (Math.abs(e.bb[3] - e.bb[0]) + Math.abs(e.bb[4] - e.bb[1])) : 0);
    if (!hasSide && perim > 0 && thk != null) {
      if (thk <= 0.5) e.q['FW narrow length'] = [perim, 'm'];
      else e.q['FW wide sides'] = [perim * thk, 'm2'];
    }
  } else if (['beam', 'groundbeam'].includes(kind)) {
    const dims = dimsOf(e.type);
    const len = e.q['Cut Length']?.[0] || e.q.Length?.[0] || e.q['Geo box length']?.[0] || (vol && dims.length >= 2 ? vol / (dims[0] * dims[1]) : 0);
    const b = dims[0] || e.q.Width?.[0] || e.q['Geo box width']?.[0] || 0;
    const d = dims[1] || e.q.Height?.[0] || e.q['Geo box height']?.[0] || 0;
    const hasSoffit = Object.keys(e.q).some(k => k.startsWith('FW soffit'));
    if (!hasSoffit) {
      const soffit = e.q['Geo bottom area']?.[0] || (len > 0 ? b * len : 0);
      if (soffit > 0) e.q['FW soffit'] = [soffit, 'm2'];
    }
    const hasSides = Object.keys(e.q).some(k => k === 'FW sides' || k.startsWith('FW wide'));
    if (!hasSides) {
      const sides = e.q['Geo side area']?.[0] || (len > 0 ? 2 * d * len : 0);
      if (sides > 0) e.q['FW sides'] = [sides, 'm2'];
    }
  } else if (kind === 'column') {
    const hasSides = Object.keys(e.q).some(k => k === 'FW sides' || k.startsWith('FW wide'));
    if (!hasSides) {
      const h = e.q['Geo box height']?.[0] || e.q.Height?.[0] || (e.bb ? Math.abs(e.bb[5] - e.bb[2]) : 0);
      const dims = dimsOf(e.type);
      const perim = e.q.Perimeter?.[0] || (dims.length >= 2 ? 2 * (dims[0] + dims[1]) : (e.bb ? 2 * (Math.abs(e.bb[3] - e.bb[0]) + Math.abs(e.bb[4] - e.bb[1])) : 0));
      if (perim > 0 && h > 0) e.q['FW sides'] = [perim * h, 'm2'];
    }
  } else if (kind === 'wall') {
    const h = e.q.Height?.[0] || e.q['Geo box height']?.[0] || (e.bb ? Math.abs(e.bb[5] - e.bb[2]) : 0);
    const hasSides = Object.keys(e.q).some(k => k === 'FW wide sides' || k === 'FW sides');
    if (!hasSides) {
      const area = e.q.Area?.[0] || (e.bb ? Math.max(Math.abs(e.bb[3] - e.bb[0]), Math.abs(e.bb[4] - e.bb[1])) * h : 0);
      if (area > 0) {
        e.q['FW wide sides'] = [2 * area, 'm2'];
        e.q['FW sides'] = [2 * area, 'm2'];
      }
    }
    const hasEnds = Object.keys(e.q).some(k => k === 'FW narrow length' || k === 'FW narrow sides');
    if (!hasEnds && h > 0) {
      e.q['FW narrow length'] = [2 * h, 'm'];
      if (thk != null) e.q['FW narrow sides'] = [2 * h * thk, 'm2'];
    }
  } else if (['footing', 'pilecap', 'raft'].includes(kind)) {
    const h = e.q['Geo box height']?.[0] || e.q.Height?.[0] || (e.bb ? Math.abs(e.bb[5] - e.bb[2]) : 0);
    const perim = e.q.Perimeter?.[0] || (e.bb ? 2 * (Math.abs(e.bb[3] - e.bb[0]) + Math.abs(e.bb[4] - e.bb[1])) : 0);
    const hasSides = Object.keys(e.q).some(k => k === 'FW sides' || k.startsWith('FW wide') || k.startsWith('FW narrow'));
    if (!hasSides && perim > 0 && h > 0) {
      e.q['FW sides'] = [perim * h, 'm2'];
      if (h <= 0.5) e.q['FW narrow length'] = [perim, 'm'];
      else e.q['FW wide sides'] = [perim * h, 'm2'];
    }
    const aog = e.q['Area on ground']?.[0] || e.q['Geo bottom area']?.[0] || e.q.Area?.[0] || (e.bb ? Math.abs(e.bb[3] - e.bb[0]) * Math.abs(e.bb[4] - e.bb[1]) : 0);
    if (!e.q['Area on ground'] && aog > 0) e.q['Area on ground'] = [aog, 'm2'];
  }
  e.qsEstimatedQuantities = [...new Set([...(e.qsEstimatedQuantities || []), ...Object.keys(e.q).filter(k => !existing.has(k))])];
}
export const KIND_LABEL = { pile: 'Piles', pilecap: 'Pile caps', footing: 'Footings', raft: 'Raft', groundbeam: 'Ground beams', beam: 'Beams', column: 'Columns',
  slab: 'Suspended slabs', groundslab: 'Ground slabs', roofslab: 'Roof slabs', wall: 'Walls', stair: 'Stairs and landings', other: 'Other' };

// ================================================================== project QS setup (assumptions; yellow cells in Excel)
export const DEFAULT_RATES = { pile: 80, pilecap: 100, footing: 90, raft: 110, groundbeam: 130, groundslab: 60, slab: 100, roofslab: 100, beam: 160, column: 180, wall: 100, stair: 100 };
export const DEFAULT_QS = {
  groundLevel: null,            // model elevation (m) of finished ground; null = top of the ground slab
  wpUpturn: 0.15,               // waterproofing upturn above ground level on outer walls (m)
  roofUpturn: 0.3,              // roof waterproofing upturn at parapets and walls (m)
  wpUnderGround: true,          // waterproofing under foundations and ground slabs
  wpFoundationSides: false,     // waterproofing to the sides of foundations
  wpRoof: true,                 // waterproofing to exposed roof slabs
  earthFaced: false,            // foundation sides cast against earth (no formwork)
  rates: { ...DEFAULT_RATES },  // reinforcement allowances, kg per m3 of concrete
};
export function qsSetup(settings) {
  const s = { ...DEFAULT_QS, ...(settings?.qs || {}) };
  s.rates = { ...DEFAULT_RATES, ...(settings?.qs?.rates || {}) };
  return s;
}
/** Default ground level: the most common top level of ground-bearing slabs (model elevation). */
export function guessGroundLevel(elements) {
  const tops = elements.filter(e => kindOf(e) === 'groundslab' && e.q?.['Top level']).map(e => e.q['Top level'][0]).sort((a, b) => a - b);
  return tops.length ? tops[Math.floor(tops.length / 2)] : null;
}
/** Section unit mass (kg/m) from a steel section name: UK/EU names end with the mass, e.g. UKB127x76x13 = 13 kg/m. */
export function steelMass(type) {
  const t = String(type || '');
  const m = /(?:UKB|UKC|UB|UC|PFC)\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*[x×]\s*(\d+(?:\.\d+)?)/i.exec(t)
    || /\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:UKB|UKC|UB|UC|PFC)\b/i.exec(t);      // e.g. 100x50x10PFC
  return m ? Number(m[1]) : null;
}

/** What the AI must know about how the app measures structure (the data each calculation uses). */
export const QS_KNOWLEDGE = `How the app measures structural concrete work (all quantities come from the exact 3D geometry, worked out per element):
- Element kinds (kindOf): pile, pilecap, footing, raft, groundbeam, beam, column, slab (suspended), groundslab (on ground), roofslab (exposed top), wall, stair. Material: insitu, precast, steel, timber, masonry (from "Structural Material" or the type name).
- Concrete: "Net volume" = geometry volume less overlaps with higher-priority elements (column > wall > beam > slab), so nothing is counted twice.
- Formwork = faces of the concrete that are not in contact with other concrete or with the ground:
  "FW soffit" (undersides with nothing touching; split by propping height "FW soffit 0-3 m", "FW soffit 3-4.5 m", then 1.5 m stages, measured from the surface below),
  "FW sides" (all free vertical faces), "FW narrow length" (length of edges/sides not over 500 mm high, in metres), "FW wide sides" (over 500 mm, m2),
  "FW sloping soffit", "FW sloping top" (top surfaces sloping over 15 degrees). Faces on the ground ("Area on ground") get no formwork.
  Foundation sides: formwork unless the project says "cast against earth" (yellow cell Earth = 1).
- Reinforcement: allowance = concrete volume x rate (kg/m3 by element kind, project QS setup) / 1000 tonnes, until a bar bending schedule is available.
  From a bar schedule: mass = number x length x d^2/162 kg/m (d in mm). Keep the rate as a yellow constant.
- Waterproofing: under foundations and ground slabs = "Area on ground" (flat); walls below ground = outer face area ("Outer face area") from its bottom to ground level + upturn:
  A x MAX(0, MIN(1, (GL + Upturn - bottom) / (top - bottom))); foundation sides when the project asks; roofs = "Top exposed" area (flat) + "Exposed perimeter" x roof upturn (upstands, m).
  Ground level (GL) comes from the project QS setup (or the most common top of ground slabs); if it is unknown and waterproofing below ground is asked, ASK for the ground level.
- Substructure: excavation = area on ground x (GL - bottom level); blinding = area on ground (x thickness); hardcore and DPM under ground slabs = area on ground.
- Schedules put the concrete volume, formwork and reinforcement of the same elements in ONE table, as columns of that table.`;

// ================================================================== derived quantities (openings)
const OPENING_CATS = /^(doors|windows)$/i;
const WALL_CATS = /walls?$/i;
/**
 * Doors and windows are matched to the wall they sit in (largest box overlap) and their area is added to
 * the wall as "Openings area", "Openings count" and "Openings to deduct" (only openings over the threshold,
 * default 0.5 m2, the usual rule for finishes).
 */
export function deriveOpenings(E = [], up0 = 'y', threshold = 0.5) {
  const thr = Number(threshold ?? 0.5);
  const openings = E.filter(e => OPENING_CATS.test(e.cat) && e.bb);
  const walls = E.filter(e => WALL_CATS.test(e.cat) && e.bb);
  walls.forEach(w => { delete w.q['Openings area']; delete w.q['Openings count']; delete w.q['Openings to deduct']; });
  if (!openings.length || !walls.length) return;
  const up = { x: 0, y: 1, z: 2 }[up0 || 'y'];
  const hz = [0, 1, 2].filter(i => i !== up);
  // grid on the horizontal plane keeps this fast on big models
  const cell = 5, grid = new Map();
  const keyOfCell = (a, b) => a + ',' + b;
  walls.forEach(w => {
    for (let a = Math.floor(w.bb[hz[0]] / cell); a <= Math.floor(w.bb[hz[0] + 3] / cell); a++)
      for (let b = Math.floor(w.bb[hz[1]] / cell); b <= Math.floor(w.bb[hz[1] + 3] / cell); b++) {
        const k = keyOfCell(a, b); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(w);
      }
  });
  for (const o of openings) {
    const cands = new Set();
    for (let a = Math.floor(o.bb[hz[0]] / cell); a <= Math.floor(o.bb[hz[0] + 3] / cell); a++)
      for (let b = Math.floor(o.bb[hz[1]] / cell); b <= Math.floor(o.bb[hz[1] + 3] / cell); b++) (grid.get(keyOfCell(a, b)) || []).forEach(w => cands.add(w));
    let best = null, bestV = 0;
    for (const w of cands) {
      let v = 1;
      for (let i = 0; i < 3; i++) { const d = Math.min(o.bb[i + 3], w.bb[i + 3] + 0.05) - Math.max(o.bb[i], w.bb[i] - 0.05); if (d <= 0) { v = 0; break; } v *= d; }
      if (v > bestV) { bestV = v; best = w; }
    }
    if (!best) continue;
    const ext = [0, 1, 2].map(i => o.bb[i + 3] - o.bb[i]);
    const width = o.q.Width?.[0] || Math.max(ext[hz[0]], ext[hz[1]]);
    const height = o.q.Height?.[0] || ext[up];
    const area = width * height;
    const add = (n, v, u) => { best.q[n] = [Math.round(((best.q[n]?.[0] || 0) + v) * 1000) / 1000, u]; };
    add('Openings area', area, 'm2'); add('Openings count', 1, 'nr');
    add('Openings to deduct', area > thr ? area : 0, 'm2');
  }
}
