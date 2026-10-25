// Dimension cutouts (CostX "Convert to Cutout"): negative area dimensions are cut out of the positive area dimensions
// they overlap. A cut can make a hole, notch an edge or split a dimension in two. Pure functions; the polygon
// library (polygon-clipping) is passed in, so the browser and the unit tests can each load their own copy.
import { pairs, bbox } from './geom2d.js';

const ring = (pts) => { const r = pairs(pts); if (r.length) r.push([...r[0]]); return r; };
const flatRing = (r) => r.slice(0, r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? -1 : undefined).flatMap(p => [p[0], p[1]]);
/** An area dimension (outer pts + holes) as a polygon-clipping polygon. */
export const toPoly = (m) => [ring(m.pts), ...(m.holes || []).map(ring)];
const overlaps = (a, b) => !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0);

/**
 * pc: polygon-clipping. positives / negatives: [{ g, m }] area dimensions on one page.
 * When `targets` (positive dimensions chosen by the user) is empty, each negative cuts every positive area dimension
 * of its own group that it overlaps.
 * Returns { pieces: Map(positive id → [{ pts, holes }]), used: Set(negative ids) }.
 */
export function cutout(pc, positives, negatives, targets = []) {
  const pieces = new Map(), used = new Set(), cut = new Set();
  const pos = targets.length ? targets : positives;
  const cur = new Map(pos.map(x => [x.m.id, toPoly(x.m)]));
  for (const n of negatives) {
    const nb = bbox(n.m.pts), np = toPoly(n.m);
    for (const p of pos) {
      if (!targets.length && p.g.id !== n.g.id) continue;
      if (!overlaps(nb, bbox(p.m.pts))) continue;
      const before = cur.get(p.m.id);
      const inter = pc.intersection(before, np);
      if (!inter.length) continue;
      cur.set(p.m.id, pc.difference(before, np));
      used.add(n.m.id); cut.add(p.m.id);
    }
  }
  for (const [id, mp] of cur) {
    if (!cut.has(id)) continue;
    pieces.set(id, (Array.isArray(mp[0]?.[0]?.[0]) ? mp : [mp]).map(poly => ({ pts: flatRing(poly[0]), holes: poly.slice(1).map(flatRing) })));
  }
  return { pieces, used };
}
