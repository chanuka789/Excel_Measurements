// Element filter used everywhere (task pane, 3D window, AI plans, server): category, family, type, words in the
// type name, level, material and QS element kind (from rules.js), zone, or the current selection.
import { kindOf, materialOf } from './rules.js';

const lc = (a) => (Array.isArray(a) ? a : a != null && a !== '' ? [a] : []).map(s => String(s).toLowerCase());
/** Returns the matching elements. ticked: selected ids (for use_ticked). zoneOf: Map id -> zone name. */
export function matchFilter(elements, f = {}, ticked = [], zoneOf = null) {
  f = f || {};
  if (f.use_ticked) { const t = new Set(ticked); return elements.filter(e => t.has(e.id)); }
  const [cat, fam, typ, inc, exc, lev, mat, kind, zone, ids] = [lc(f.category), lc(f.family), lc(f.type), lc(f.type_contains), lc(f.type_excludes), lc(f.level),
    lc(f.material), lc(f.qsKind || f.qs_kind || f.kind), lc(f.zone), (Array.isArray(f.ids) ? f.ids : []).map(Number)];
  const idSet = ids.length ? new Set(ids) : null;
  return elements.filter(e => {
    const t = `${e.type} ${e.fam}`.toLowerCase(), ty = String(e.type).toLowerCase();
    return (!idSet || idSet.has(e.id)) && (!cat.length || cat.includes(String(e.cat).toLowerCase())) && (!fam.length || fam.includes(String(e.fam).toLowerCase())) &&
      (!typ.length || typ.includes(ty)) && (!inc.length || inc.some(s => t.includes(s))) &&
      (!exc.length || !exc.some(s => t.includes(s))) && (!lev.length || lev.includes(String(e.level || '').toLowerCase())) &&
      (!mat.length || mat.includes(materialOf(e))) && (!kind.length || kind.includes(kindOf(e))) &&
      (!zone.length || zone.includes(String((zoneOf ? zoneOf.get(e.id) : e.zone) || '').toLowerCase()));
  });
}
export const filterIds = (elements, f, ticked, zoneOf) => matchFilter(elements, f, ticked, zoneOf).map(e => e.id);
