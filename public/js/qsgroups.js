// Structural dimension groups: one group per element type (slabs and walls also per thickness) that carries the
// concrete volume as its quantity and formwork, reinforcement, waterproofing (and piling, steel mass) as custom
// quantities, filed in folders by POMI section and element group, e.g.
//   Section C - Concrete works \ Substructure | Frame | Superstructure | Roof
// Pure module: the AI action, the Measure tab and the tests all use it, so they give the same groups.
import { keyOf, evaluate } from './engine.js';
import { KIND_LABEL, kindOf, materialOf, qsSetup, guessGroundLevel, steelMass, elementThickness, enrichElementQs } from './rules.js';
import { structuralSpecs } from './qsitems.js';

export const POMI_SECTIONS = [
  ['B', 'Site works'], ['C', 'Concrete works'], ['D', 'Masonry'], ['E', 'Metal work'], ['F', 'Wood works'],
  ['G', 'Thermal and Moisture Protection'], ['H', 'Doors and Windows'], ['J', 'Finishes'], ['K', 'Accessories'],
  ['L', 'Equipment'], ['M', 'Furnishings'], ['N', 'Special construction'], ['P', 'Conveying Systems'],
  ['Q', 'Mechanical Engineering Installations'], ['R', 'Electrical Engineering Installations'],
].map(([l, n]) => `Section ${l} - ${n}`);
export const sectionName = (letter) => POMI_SECTIONS.find(s => s.startsWith(`Section ${letter} `));
export const ELEMENT_GROUPS = ['Substructure', 'Frame', 'Superstructure', 'Roof'];

const SUB = new Set(['pile', 'pilecap', 'footing', 'raft', 'groundbeam', 'groundslab']);
const BY_THICKNESS = new Set(['slab', 'groundslab', 'roofslab', 'wall', 'raft']);
const SINGULAR = { slab: 'suspended slab', groundslab: 'ground slab', roofslab: 'roof slab', wall: 'wall', raft: 'raft' };

/** Element group (folder under the section) for an element. */
export function elementGroup(e, kind, gl) {
  if (SUB.has(kind)) return 'Substructure';
  if (kind === 'column' || kind === 'beam') return 'Frame';
  if (kind === 'roofslab' || /roof/i.test(e.cat || '') || /roof/i.test(e.level || '')) return 'Roof';
  if (kind === 'wall') { const top = e.q?.['Top level']?.[0]; if (top != null && gl != null && top <= gl + 0.01) return 'Substructure'; }
  return 'Superstructure';
}
/** POMI section folder for a material. */
export function sectionOf(mat) {
  return sectionName(mat === 'steel' ? 'E' : mat === 'timber' ? 'F' : mat === 'masonry' ? 'D' : 'C');
}
export const mm = (e) => { const t = elementThickness(e); return t ? Math.round(t * 1000) : null; };

/** Turn a take-off spec into dimension-group custom quantities (formula references expanded, constants as variables). */
export function specToGroupProps(spec, byId, { keepConcrete = 'auto' } = {}) {
  const fk = new Map(spec.formulas.map(f => [f.key, f]));
  const varName = (c) => String(c.label).replace(/\s*\([^)]*\)\s*$/, '').trim() || c.key;
  const consts = new Map(spec.constants.map(c => [c.key, keyOf(varName(c))]));
  const inputs = new Map(spec.inputs.map(i => [i.key, i]));
  const expand = (expr, depth = 0) => String(expr).replace(/\{(\w+)\}/g, (m, k) => {
    if (fk.has(k)) { if (depth > 8) throw new Error('formula loop'); return `(${expand(fk.get(k).expr, depth + 1)})`; }
    if (consts.has(k)) return `{${consts.get(k)}}`;
    const i = inputs.get(k);
    if (i?.source === 'count') return '1';
    if (i && i.source !== 'property') throw new Error('not a model quantity');
    if (i && keyOf(i.name) !== k) return `{${keyOf(i.name)}}`;
    return m;
  });
  const ev = evaluate(spec, byId);
  const nonZero = (f) => Math.abs(ev.tot[f.key] || 0) > 1e-9;
  const concrete = spec.formulas.filter(f => f.rule?.group === 'Concrete' && !f.rule?.info && nonZero(f));
  const custom = [];
  for (const f of spec.formulas) {
    if (!nonZero(f) || f.rule?.group === 'Element') continue;
    if (f.rule?.group === 'Concrete' && (keepConcrete === false || (keepConcrete === 'auto' && concrete.length <= 1))) continue;
    let expr; try { expr = expand(f.expr); } catch { continue; }
    custom.push({ label: f.label, unit: f.unit, expr, rule: f.rule ? { ...f.rule } : undefined });
  }
  const variables = spec.constants.map(c => ({ name: varName(c), value: Number(c.value) || 0, unit: c.unit || '' }));
  const volume = spec.inputs.find(i => i.unit === 'm3' && /volume/i.test(i.name || ''));
  return { custom, variables, quantity: volume?.name, rule: concrete.length === 1 ? { ...concrete[0].rule } : undefined, note: spec.note };
}

/**
 * The structural dimension groups for a set of elements.
 * Returns [{ path: [section, element group], name, mtype, ids, props }]
 */
export function structureGroupPlan(E, byId, { ids = null, set, setup = {}, root = '' } = {}) {
  const S = qsSetup({ qs: setup });
  const ruleSet = set || S.ruleSet;
  const gl = S.groundLevel ?? guessGroundLevel(E) ?? 0;
  const els = (ids ? ids.map(id => byId.get(id)).filter(Boolean) : E);
  for (const e of els) enrichElementQs(e);
  const buckets = new Map();
  for (const e of els) {
    const mat = materialOf(e), kind = kindOf(e);
    if (kind === 'other' && mat !== 'steel') continue;
    if (!['insitu', 'precast', 'steel'].includes(mat)) continue;
    const grp = mat === 'steel' ? (kind === 'column' ? 'Frame' : kind === 'roofslab' ? 'Roof' : elementGroup(e, kind === 'other' ? 'beam' : kind, gl)) : elementGroup(e, kind, gl);
    let name;
    if (mat === 'steel') name = `Steel ${e.type}`;
    else if (mat === 'precast') name = `Precast ${(KIND_LABEL[kind] || 'units').toLowerCase()}`;
    else if (BY_THICKNESS.has(kind) && mm(e)) name = `${mm(e)} mm ${SINGULAR[kind]}${kind === 'wall' && grp === 'Substructure' ? ' below ground' : ''}`;
    else name = KIND_LABEL[kind] || kind;
    const path = [...(root ? [root] : []), sectionOf(mat), grp];
    const key = path.join('\\') + '|' + name;
    if (!buckets.has(key)) buckets.set(key, { path, name, ids: [], mat, kind });
    buckets.get(key).ids.push(e.id);
  }
  const out = [];
  for (const b of buckets.values()) {
    if (b.mat === 'steel') {
      const e = byId.get(b.ids[0]), kgm = steelMass(e.type);
      const len = ['Cut Length', 'Length', 'Geo box length'].find(n => b.ids.some(id => byId.get(id)?.q?.[n]));
      out.push({ path: b.path, name: b.name, mtype: 'Length', ids: b.ids, props: { display: 'Length', quantity: len,
        variables: kgm ? [{ name: 'Section mass', value: kgm, unit: 'kg/m' }] : [],
        custom: kgm ? [{ label: 'Structural steel members', unit: 't', expr: '{Length} * {Section_mass} / 1000', rule: { set: ruleSet, key: 'steel.t', ref: ruleSet === 'POMI' ? 'POMI E' : 'NRM2 15', group: 'Structural steel', title: 'Structural steel members', confirm: true, nrm1: '2.1' } }] : [],
        description: kgm ? `Steel ${e.type}: length x ${kgm} kg/m (from the section name).` : `Steel ${e.type}: section mass not found in the type name; add a "Section mass" variable.` } });
      continue;
    }
    const specs = structuralSpecs(b.ids, byId, { set: ruleSet, setup, elements: E });
    if (!specs.length) continue;
    const p = specToGroupProps(specs[0].spec, byId);
    out.push({ path: b.path, name: b.name, mtype: 'Volume', ids: b.ids,
      props: { display: 'Volume', quantity: p.quantity, variables: p.variables, custom: p.custom, rule: p.rule, description: p.note } });
  }
  const rank = (x) => [POMI_SECTIONS.indexOf(x.path.at(-2)), ELEMENT_GROUPS.indexOf(x.path.at(-1))];
  return out.sort((a, b) => { const [a1, a2] = rank(a), [b1, b2] = rank(b); return a1 - b1 || a2 - b2 || a.name.localeCompare(b.name, undefined, { numeric: true }); });
}
