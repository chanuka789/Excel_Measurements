// Classification controls presentation. It never supplies quantity deductions.
import { CATALOGUES } from './standardsCatalogues.js';
export { CATALOGUES };
export const STANDARD_IDS = ['POMI', 'NRM1', 'NRM2'];
export const DEFAULT_PROFILE = { purpose: 'boq', primary: 'NRM2', secondary: 'NRM1', tertiary: '', basis: 'NRM2', formwork: false, formworkFallback: false, rebar: false, ratio: 100, amendments: '' };
export const PRESETS = {
  detailed: { ...DEFAULT_PROFILE },
  international: { ...DEFAULT_PROFILE, primary: 'POMI', secondary: '', basis: 'POMI' },
  elementalBoq: { ...DEFAULT_PROFILE, primary: 'NRM1', secondary: 'NRM2' },
  pomiDetailed: { ...DEFAULT_PROFILE, primary: 'POMI', secondary: 'NRM2' },
  costPlan: { ...DEFAULT_PROFILE, purpose: 'costplan', primary: 'NRM1', secondary: '', basis: 'NRM1' },
};
export function validateProfile(p) {
  for (const key of ['primary', 'basis']) if (!STANDARD_IDS.includes(p[key])) throw new Error(`Choose a valid ${key} standard.`);
  for (const key of ['secondary', 'tertiary']) if (p[key] && !STANDARD_IDS.includes(p[key])) throw new Error(`Choose a valid ${key} classification.`);
  if (!['boq', 'costplan', 'schedule'].includes(p.purpose)) throw new Error('Choose a valid output purpose.');
  if (p.purpose === 'boq' && p.basis === 'NRM1') throw new Error('NRM 1 is a cost-plan basis. Choose POMI or NRM 2 for a detailed BOQ.');
  if (p.rebar && (!Number.isFinite(p.ratio) || p.ratio < 0)) throw new Error('Enter a non-negative reinforcement ratio in kg/m³.');
  return p;
}
export const naturalCompare = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
export function pricingSignature(e) {
  return [...Object.entries(e.props || {}).filter(([k]) => /material|grade|rating|acoustic|finish|system|diameter|size|thickness|insulation|capacity|duty|hardware|layers|species/i.test(k)),
    ...Object.entries(e.q || {}).filter(([k]) => /width|height|thickness|diameter|depth|gauge|insulation|capacity|pressure|flow|weight per|mass per/i.test(k)).map(([k, v]) => [`Quantity: ${k}`, v])].sort(([a], [b]) => naturalCompare(a, b));
}
export function lookup(standard, code) {
  const c = CATALOGUES[standard];
  return [...(c?.sections || []), ...(c?.topics || [])].find(n => n.code === String(code));
}
export function ancestors(standard, code) {
  const out = []; let node = lookup(standard, code);
  if (!node) throw new Error(`Unknown ${standard} reference ${code}.`);
  while (node) { out.unshift({ standard, ...node }); node = node.parent ? lookup(standard, node.parent) : null; }
  return out;
}
export function headingPath(classification, profile) {
  const order = [...new Set([profile.primary, profile.secondary, profile.tertiary].filter(Boolean))];
  return order.flatMap(std => classification[std] ? ancestors(std, classification[std]) : [{ standard: std, code: 'UNASSIGNED', name: 'Needs QS allocation' }]);
}
export function referenceLabel(node) {
  return node.standard === 'NRM2' ? `NRM 2 WS${node.code}` : `${node.standard === 'NRM1' ? 'NRM 1' : 'POMI'} ${node.code}`;
}
export function elementKey(e, context = {}) {
  return JSON.stringify([context.projectId || '', e.modelId || context.modelId || context.versionId || '', e.guid || e.props?.Guid || e.id]);
}

/** Conditional QS allocation. Unknown function is reviewable, never silently a zero quantity. */
export function classify(e) {
  const cat = String(e.cat || '').toLowerCase(), text = `${e.type || ''} ${e.fam || ''} ${e.props?.Material || ''} ${e.props?.['Structural Material'] || ''}`.toLowerCase();
  const ext = /external|exterior|outside/i.test(`${e.props?.Function || ''} ${text}`);
  const internal = /internal|interior/i.test(`${e.props?.Function || ''} ${text}`);
  const roof = /roof/i.test(`${cat} ${e.level || ''} ${text}`), ground = /ground|grade|\bsog\b/i.test(text);
  const result = (pomi, nrm1, nrm2, family, discipline, issues = []) => ({ POMI: pomi, NRM1: nrm1, NRM2: nrm2, family, discipline, issues });
  if (/door|shutter|hatch/.test(cat)) return result('H1', ext ? '2.6.2' : internal ? '2.8.1' : '', '24', 'count', 'Architecture', !ext && !internal ? ['Confirm internal/external door allocation.'] : []);
  if (/window|louver|louvre/.test(cat)) return result('H2', '2.6.1', '23', 'count', 'Architecture');
  if (/curtain|glazing/.test(cat)) return result('H3', ext ? '2.5.1' : '', '21', 'area', 'Architecture', ['Confirm complete façade assembly versus separately measured glazing.']);
  if (/foundation/.test(cat)) return result('C2', /pile/.test(text) && !/cap/.test(text) ? '1.1.2' : '1.1.1', /pile/.test(text) && !/cap/.test(text) ? '7' : '11', 'concrete', 'Structure');
  if (/column|framing/.test(cat)) {
    if (/steel|metal|\b(ub|uc|ukb|ukc|shs|chs|rhs)\d*/.test(text)) return result('E2', '2.1.1', '15', 'steel', 'Structure');
    if (/timber|wood/.test(text)) return result('F2', '2.1.5', '16', 'volume', 'Structure');
    if (/concrete|cip|\brc\b/.test(text)) return result('C2', '2.1.4', '11', 'concrete', 'Structure');
    return result('', '', '', 'volume', 'Structure', ['Confirm structural material.']);
  }
  if (/floor|slab|roof/.test(cat)) {
    if (/tile|carpet|marble|porcelain|epoxy|terrazzo|finish/.test(text)) return result('J3', '3.2.1', '28', 'area', 'Interiors');
    if (/concrete|cip|\brc\b/.test(text)) return result('C2', roof ? '2.3.1' : ground ? '1.1.3' : '2.2.1', '11', 'concrete', 'Structure', !roof && !ground ? ['Confirm upper-floor versus lowest-floor function.'] : []);
    return result('', roof ? '2.3.2' : '', '', 'area', 'Architecture', ['Confirm structural slab versus finish/roof assembly.']);
  }
  if (/wall/.test(cat)) {
    const elem = ext ? '2.5.1' : internal ? '2.7.1' : '';
    const issue = !elem ? ['Confirm wall function: external, internal, basement or site.'] : [];
    if (/concrete|cip|\brc\b/.test(text)) return result('C2', elem, '11', 'concrete', 'Structure', issue);
    if (/block|brick|masonry|aac/.test(text)) return result('D2', elem, '14', 'area', 'Architecture', issue);
    if (/gypsum|drywall|partition|stud/.test(text)) return result('K2', elem, '20', 'area', 'Interiors', issue);
    return result('', elem, '', 'area', 'Architecture', [...issue, 'Confirm wall construction.']);
  }
  if (/ceiling/.test(cat)) return result('J5', /demount|tile/.test(text) ? '3.3.3' : '3.3.2', '30', 'area', 'Interiors');
  if (/stair|ramp|landing/.test(cat)) return result(/steel/.test(text) ? 'E2' : 'C2', '2.4.1', /concrete/.test(text) ? '11' : '25', 'volume', 'Structure', ['Confirm stair structure, finishes and balustrade scope.']);
  if (/rebar|reinforcement/.test(cat)) return result('C3', '', '11', 'rebar', 'Structure', ['Allocate reinforcement to its host element.']);
  if (/duct/.test(cat)) return result('Q3', '', '38', /fitting|accessor/.test(cat) ? 'count' : /flex|round|circular/.test(`${cat} ${text}`) || e.q?.Diameter ? 'length' : 'duct', 'MEP', ['Confirm air-conditioning, ventilation or smoke-control system.']);
  if (/pipe/.test(cat)) {
    const system = `${e.props?.['System Type'] || ''} ${e.props?.['System Name'] || ''} ${text}`;
    const drain = /drain|soil|waste|rainwater/.test(system), fire = /fire|sprinkler/.test(system), chw = /chilled|\bchw\b/.test(system);
    return result('Q2', drain ? '5.3.1' : fire ? '5.11.1' : chw ? '5.6.3' : /cold/.test(system) ? '5.4.2' : /hot/.test(system) ? '5.4.3' : '', drain ? '33' : '38', /fitting|accessor/.test(cat) ? 'count' : 'length', 'MEP', ['Confirm above/below-ground system and fitting/support inclusions.']);
  }
  if (/cable|conduit|trunk|tray/.test(cat)) return result('R4', '5.8.2', '39', /fitting/.test(cat) ? 'count' : 'length', 'MEP', ['Confirm circuit/system allocation and included supports.']);
  if (/lighting/.test(cat)) return result('R7', '5.8.3', '39', 'count', 'MEP');
  if (/electrical/.test(cat)) return result('R7', '', '39', 'count', 'MEP', ['Confirm power, distribution or ELV function.']);
  if (/mechanical|plumbing|sprinkler/.test(cat)) return result('Q4', /sprinkler/.test(cat) ? '5.11.2' : '', '38', 'count', 'MEP', ['Confirm services equipment/system and duty.']);
  if (/planting|landscape/.test(cat)) return result('B22', '8.3.2', '37', 'count', 'Landscape', ['Confirm species, size and associated soil/irrigation scope.']);
  if (/furniture|casework|equipment/.test(cat)) return result(/casework/.test(cat) ? 'F6' : 'L1', '4.1.1', /casework/.test(cat) ? '22' : '32', 'count', 'Interiors');
  return result('', '', '', 'count', 'Other', ['No automatic rule: allocate this category manually.']);
}
