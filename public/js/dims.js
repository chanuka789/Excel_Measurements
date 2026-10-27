// Dimension groups and take-off merging. Pure functions, no DOM: shared by the 3D window,
// the task pane and the unit tests.
//
// A dimension group: { id, name, mtype: Count|Length|Area|Volume, props, items: [{ element_id, sign, multiplier }] }
// props: { display, quantity, multiplier, width, height, offset, custom:[{label,unit,expr}], variables:[{name,value,unit}],
//          measured:[{id,label,value,unit,sign,multiplier,dmult,shape,src,pts,len}], posColor, negColor, zone, ... }
// A measured dimension taken on screen also keeps where it was taken: src {t:'d'|'s'|'3d', key, page, name}, the shape
// (area, length, count, distance, face), its points (2D drawing units or 3D metres) and, for areas, the perimeter (len).
// dmult is the drawing multiplier (typical floors): the effective multiplier is multiplier x dmult.
import { keyOf } from './engine.js';
import { enrichElementQs } from './rules.js';

export const MTYPES = ['Count', 'Length', 'Area', 'Volume'];
export const UNIT = { Count: 'nr', Length: 'm', Area: 'm2', 'Wall Area': 'm2', Volume: 'm3' };
/** "Default Display" choices (CostX order) and the ones each measurement type can use. Weight = quantity x multiplier (weight per unit). */
export const DISPLAYS = ['Count', 'Length', 'Area', 'Wall Area', 'Volume', 'Weight'];
export const DISPLAYS_FOR = { Count: ['Count', 'Weight'], Length: ['Length', 'Area', 'Wall Area', 'Volume', 'Weight'], Area: ['Area', 'Volume', 'Weight'], Volume: ['Volume', 'Weight'] };
export const WEIGHT_UOMS = ['kg', 't'];
/** BIM quantities tried in order when a group does not name one (the first one the element has is used). */
export const PREFERRED = {
  Length: ['Length', 'Cut Length', 'Geo box length', 'Perimeter'],
  Area: ['Area', 'Geo top area', 'Face area (L x H)', 'Geo surface area'],
  Volume: ['Volume', 'Geo volume'],
};
export const DETAILS = [['cat', 'Category'], ['fam', 'Family'], ['type', 'Type'], ['level', 'Level'], ['mark', 'Mark'], ['zone', 'Zone']];
export const DEFAULT_DETAILS = ['cat', 'fam', 'type', 'level', 'mark'];
export const detailLabel = (d) => (d.startsWith('p:') ? d.slice(2) : (DETAILS.find(x => x[0] === d) || [d, d])[1]);
export const detailValue = (e, d) => (d.startsWith('p:') ? e.props?.[d.slice(2)] ?? '' : e[d] ?? '');

const P = (g) => g.props || {};
const factor = (v, d = 1) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

/** The BIM quantity names a group reads, most specific first. */
export function quantityNames(g) {
  if (g.mtype === 'Count') return [];
  const pref = PREFERRED[g.mtype] || [];
  return P(g).quantity ? [P(g).quantity, ...pref.filter(n => n !== P(g).quantity)] : pref;
}
/** Measured (base) value of one element for the group: 1 for Count, else the first BIM quantity it has. */
export function baseValue(g, e) {
  if (!e) return null;
  if (g.mtype === 'Count') return 1;
  for (const n of quantityNames(g)) if (e.q?.[n]) return e.q[n][0];
  return null;
}
/** How the base value turns into the displayed quantity ("Default Display" with width and height). */
export function conversion(g) {
  const d = P(g).display || g.mtype, w = factor(P(g).width, 0), h = factor(P(g).height, 0);
  if (d === 'Weight' && (DISPLAYS_FOR[g.mtype] || []).includes('Weight')) return { display: 'Weight', terms: [] };
  if (g.mtype === 'Length' && (d === 'Area' || d === 'Wall Area') && h > 0) return { display: d, terms: ['Height'] };
  if (g.mtype === 'Length' && d === 'Volume' && w > 0 && h > 0) return { display: 'Volume', terms: ['Width', 'Height'] };
  if (g.mtype === 'Area' && d === 'Volume' && h > 0) return { display: 'Volume', terms: ['Height'] };
  return { display: g.mtype, terms: [] };
}
export const displayUnit = (g) => { const d = conversion(g).display; return d === 'Weight' ? (WEIGHT_UOMS.includes(P(g).weightUom) ? P(g).weightUom : 'kg') : UNIT[d]; };

/** Sign x dimension multiplier x drawing multiplier of one dimension (1 for a plain positive dimension). */
export const itemFactor = (item = {}) => (item.sign < 0 ? -1 : 1) * factor(item.multiplier) * factor(item.dmult);
/** Quantity of one dimension: (base + offset) x group multiplier x dimension multiplier x drawing multiplier x sign, then the display conversion. */
export function dimQuantity(g, base, item = {}) {
  if (base == null) return null;
  const p = P(g), conv = conversion(g);
  let v = (base + (g.mtype === 'Length' ? factor(p.offset, 0) : 0)) * factor(p.multiplier) * itemFactor(item);
  for (const t of conv.terms) v *= t === 'Width' ? factor(p.width, 0) : factor(p.height, 0);
  return v;
}
/** Every dimension of a group with its quantity on the open model. */
export function dimensions(g, byId) {
  const out = [];
  for (const it of g.items || []) {
    const e = byId.get(it.element_id);
    const base = e ? baseValue(g, e) : null;
    out.push({ kind: 'bim', item: it, e, base, qty: e ? dimQuantity(g, base, it) : null, missing: !e ? 'not in this model' : base == null ? 'no ' + g.mtype.toLowerCase() : '' });
  }
  for (const m of P(g).measured || []) out.push({ kind: 'measured', item: m, e: null, base: m.value, qty: dimQuantity(g, m.value, m), missing: '' });
  return out;
}
export function groupTotal(g, byId) {
  let total = 0, n = 0, missing = 0, absent = 0;
  for (const d of dimensions(g, byId)) {
    if (d.qty == null) { if (d.missing === 'not in this model') absent++; else missing++; continue; }
    total += d.qty; n++;
  }
  return { total, n, missing, absent, unit: displayUnit(g) };
}

/**
 * A dimension group as a take-off spec (an Excel schedule with live formulas).
 * opts: { details:[...], extra:[BIM quantity names], count:bool, by:'type'|..., measured:bool }
 */
export function groupToSpec(g, byId, opts = {}) {
  const p = P(g), conv = conversion(g);
  const present = (g.items || []).filter(i => byId.has(i.element_id));
  const ids = present.map(i => i.element_id);
  const inputs = [], constants = [], formulas = [];
  if (opts.count) inputs.push({ key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true });
  const baseKey = g.mtype === 'Count' ? 'Count' : 'Base';
  if (g.mtype !== 'Count') {
    const names = quantityNames(g);
    const used = new Set(present.map(i => names.find(n => byId.get(i.element_id).q?.[n])).filter(Boolean));
    const label = used.size === 1 ? [...used][0] : `BIM ${g.mtype.toLowerCase()}`;
    inputs.push(used.size === 1 ? { key: 'Base', label, unit: UNIT[g.mtype], source: 'property', name: [...used][0], sum: true }
      : { key: 'Base', label, unit: UNIT[g.mtype], source: 'first', names, sum: true });
  } else if (!opts.count) inputs.push({ key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true });
  // per-dimension sign x multiplier, only when some dimension differs from +1
  const odd = present.filter(i => i.sign < 0 || factor(i.multiplier) !== 1);
  const measured = opts.measured === false ? [] : (p.measured || []);
  const hasFactor = odd.length > 0 || measured.some(m => itemFactor(m) !== 1);
  if (hasFactor) inputs.push({ key: 'Factor', label: 'Sign × multiplier', unit: '×', source: 'map', default: 1,
    map: Object.fromEntries(odd.map(i => [i.element_id, (i.sign < 0 ? -1 : 1) * factor(i.multiplier)])), sum: false });
  for (const n of opts.extra || []) {
    const key = keyOf(n);
    if (!inputs.some(i => i.key === key)) inputs.push({ key, label: n, unit: guessUnit(n, byId, ids), source: 'property', name: n, sum: true });
  }
  const terms = [];
  if (g.mtype === 'Length' && factor(p.offset, 0)) { constants.push({ key: 'Offset', label: 'Offset', value: factor(p.offset, 0), unit: 'm' }); }
  if (factor(p.multiplier) !== 1) { constants.push({ key: 'Multiplier', label: 'Multiplier', value: factor(p.multiplier), unit: '' }); terms.push('{Multiplier}'); }
  if (conv.terms.includes('Width')) { constants.push({ key: 'Width', label: 'Width', value: factor(p.width, 0), unit: 'm' }); terms.push('{Width}'); }
  if (conv.terms.includes('Height')) { constants.push({ key: 'Height', label: 'Height', value: factor(p.height, 0), unit: 'm' }); terms.push('{Height}'); }
  if (hasFactor) terms.push('{Factor}');
  for (const v of p.variables || []) { const key = keyOf(v.name); if (!constants.some(c => c.key === key)) constants.push({ key, label: v.name, value: factor(v.value, 0), unit: v.unit || '' }); }
  const base = g.mtype === 'Length' && factor(p.offset, 0) ? '({Base} + {Offset})' : `{${baseKey}}`;
  const qtyLabel = g.name;
  if (terms.length || base !== `{${baseKey}}` || conv.display === 'Weight') formulas.push({ key: 'Qty', label: qtyLabel, unit: displayUnit(g), expr: [base, ...terms].join(' * ') });
  else { const b = inputs.find(i => i.key === baseKey); b.label = `${g.name}: ${b.label}`; }
  const qtyRef = formulas.length ? '{Qty}' : `{${baseKey}}`;
  // custom quantities: {Qty}, {Base}, {Width}, {Height}, {Multiplier}, variables and any BIM quantity of the elements
  const known = new Set([...inputs, ...constants, ...formulas].map(c => c.key));
  const bimKeys = new Map();
  ids.forEach(id => {
    const e = byId.get(id);
    if (!e) return;
    enrichElementQs(e);
    Object.entries(e.q || {}).forEach(([n, [, u]]) => { if (!bimKeys.has(keyOf(n))) bimKeys.set(keyOf(n), { n, u }); });
  });
  for (const [i, c] of (p.custom || []).entries()) {
    let expr = String(c.expr).replace(/\{(Quantity|Qty)\}/g, qtyRef).replace(/\{(Length|Area|Volume|Count)\}/g, (m, k) => (k === g.mtype || (k === 'Count' && g.mtype === 'Count') ? qtyRef : m));
    for (const [, k] of expr.matchAll(/\{([A-Za-z_]\w*)\}/g)) {
      if (known.has(k)) continue;
      if (k === 'Width' || k === 'Height' || k === 'Offset' || k === 'Multiplier') {
        const val = k === 'Multiplier' ? factor(p.multiplier) : factor(p[k.toLowerCase()], 0);
        constants.push({ key: k, label: k, value: val, unit: k === 'Multiplier' ? '' : 'm' }); known.add(k); continue;
      }
      const baseIn = inputs.find(i => i.key === 'Base');
      if (baseIn && (baseIn.source === 'property' ? keyOf(baseIn.name) === k : (baseIn.names || []).some(n => keyOf(n) === k))) { expr = expr.replace(new RegExp(`\\{${k}\\}`, 'g'), '{Base}'); continue; }
      const b = bimKeys.get(k);
      if (b) { inputs.push({ key: k, label: b.n, unit: b.u, source: 'property', name: b.n, sum: !/thickness|level|top$|bottom$/i.test(b.n), ...(/^Thickness/.test(b.n) ? { blankAsZero: true } : {}) }); known.add(k); continue; }
      throw new Error(`Custom quantity "${c.label}" uses {${k}}, which is not a variable or a quantity of these elements.`);
    }
    const key = 'C' + (i + 1);
    formulas.push({ key, label: c.label, unit: c.unit || '', expr, ...(c.rule ? { rule: c.rule } : {}) }); known.add(key);
  }
  if (p.rule) { const q = formulas.find(f => f.key === 'Qty') || inputs.find(i => i.key === baseKey); if (q) q.rule = p.rule; }
  // manual rows keep the dimension id: the Excel cell becomes a live link (=CX.QTY(group, "Base", dimension))
  const manual = measured.map(m => ({ label: m.src?.name ? `${m.label} · ${m.src.name}` : m.label, v: { [baseKey]: m.value, ...(hasFactor ? { Factor: itemFactor(m) } : {}) },
    ...(m.id ? { cx: { gid: g.id, mid: m.id, key: baseKey } } : {}) }));
  return { name: g.name, ids, by: opts.by ?? 'type', note: p.description || `Dimension group (${g.mtype}${conv.display !== g.mtype ? ' shown as ' + conv.display : ''})`,
    details: opts.details || DEFAULT_DETAILS, inputs, constants, formulas, manual, dimGroupId: g.id, parts: [g.name] };
}
function guessUnit(n, byId, ids) {
  for (const id of ids) { const q = byId.get(id)?.q?.[n]; if (q) return q[1]; }
  return '';
}

// ================================================================== one table for the same elements
/** True when two take-offs measure exactly the same elements (order does not matter). */
export function sameElements(a, b) {
  const A = new Set(a.ids || []), B = new Set(b.ids || []);
  if (!A.size || A.size !== B.size) return false;
  for (const x of B) if (!A.has(x)) return false;
  return true;
}
const sig = (c) => JSON.stringify([c.source, c.name, c.names, c.index, c.unit, c.map, c.default]);
/**
 * Merge take-off b into a (same elements): one table with the columns of both. Inputs that read the same
 * quantity are shared, clashing keys are renamed and b's formulas are rewritten to match.
 */
export function mergeSpecs(a, b) {
  const used = new Set([...a.inputs, ...a.constants, ...a.formulas].map(c => c.key));
  const rename = {};
  const fresh = (k) => { let n = 2; while (used.has(`${k}_${n}`)) n++; const nk = `${k}_${n}`; used.add(nk); return nk; };
  const inputs = [...a.inputs], constants = [...a.constants], formulas = [...a.formulas];
  // two different columns must never share a heading (BOQ links and readers find columns by heading)
  const part = (b.parts || [b.name])[0];
  const uniq = (c) => {
    const taken = new Set([...inputs, ...formulas].map(x => `${x.label} (${x.unit})`));
    if (!taken.has(`${c.label} (${c.unit})`)) return c;
    let label = `${c.label} - ${part}`, n = 2;
    while (taken.has(`${label} (${c.unit})`)) label = `${c.label} - ${part} ${n++}`;
    return { ...c, label };
  };
  for (const i of b.inputs) {
    const same = inputs.find(x => sig(x) === sig(i));
    if (same) { if (same.key !== i.key) rename[i.key] = same.key; continue; }
    const key = used.has(i.key) ? fresh(i.key) : (used.add(i.key), i.key);
    if (key !== i.key) rename[i.key] = key;
    inputs.push(uniq({ ...i, key }));
  }
  for (let c of b.constants) {
    const same = constants.find(x => x.key === c.key && x.label === c.label && Number(x.value) === Number(c.value) && x.unit === c.unit);
    if (same) continue;
    // a different value under the same label would be overwritten by "keep assumptions": make the label unique
    if (constants.some(x => x.label === c.label)) c = { ...c, label: `${c.label} (${(b.parts || [b.name])[0]})` };
    const key = used.has(c.key) ? fresh(c.key) : (used.add(c.key), c.key);
    if (key !== c.key) rename[c.key] = key;
    constants.push({ ...c, key });
  }
  const re = (expr) => String(expr).replace(/\{([A-Za-z_]\w*)\}/g, (m, k) => (rename[k] ? `{${rename[k]}}` : m));
  for (const f of b.formulas) {
    const expr = re(f.expr);
    const dup = formulas.find(x => x.label === f.label && x.unit === f.unit && x.expr === expr);
    if (dup) { rename[f.key] = dup.key; continue; }
    const key = used.has(f.key) ? fresh(f.key) : (used.add(f.key), f.key);
    rename[f.key] = key;
    formulas.push(uniq({ ...f, key, expr: re(f.expr) }));
  }
  const parts = [...new Set([...(a.parts || [a.name]), ...(b.parts || [b.name])])];
  const notes = [...new Set([a.note, b.note].filter(Boolean))];
  const details = [...new Set([...(a.details || DEFAULT_DETAILS), ...(b.details || DEFAULT_DETAILS)])];
  const manual = [...(a.manual || []), ...(b.manual || []).map(m => ({ ...m, v: Object.fromEntries(Object.entries(m.v || {}).map(([k, v]) => [rename[k] || k, v])) }))];
  return { ...a, name: mergedName(parts, a.base), parts, base: a.base, note: notes.join(' | '), details, inputs, constants, formulas, manual,
    filter: JSON.stringify(a.filter) === JSON.stringify(b.filter) ? a.filter : undefined };
}
/** "Concrete to beams / Formwork to beams", or "Beams: 4 measurements" when there are many. */
export function mergedName(parts, base) {
  if (parts.length <= 3) return parts.join(' / ');
  return `${base || parts[0]}: ${parts.length} measurements`;
}
/** Merge every group of a list that shares its elements with an earlier one (AI plans, several templates). */
export function mergeList(specs) {
  const out = [];
  for (const s of specs) {
    const i = out.findIndex(x => sameElements(x, s));
    if (i >= 0) out[i] = mergeSpecs(out[i], s); else out.push(s);
  }
  return out;
}
