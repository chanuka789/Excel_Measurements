// Measure items: QS methods that turn a set of elements into take-off tables (one per element kind) with every
// related item in one table: concrete, formwork, reinforcement, waterproofing, worded and split by the chosen rule
// set (POMI, NRM2, NRM1). Pure module: used by the task pane, the 3D window and the AI, so all give the same numbers.
import { keyOf } from './engine.js';
import { RULES, LIMITS, KIND_LABEL, NRM1_OF_KIND, kindOf, materialOf, qsSetup, guessGroundLevel, steelMass, enrichElementQs } from './rules.js';

const BAND_ORDER = ['0-3', '3-4.5', '4.5-6', '6-7.5', '7.5-9', '9-10.5', '10.5-12', '12-13.5', '13.5-15', '>15'];
const bandText = (b) => (b.startsWith('>') ? `propping height over ${b.slice(1)} m` : `propping height ${b.replace('-', ' to ')} m`);
const has = (els, n) => els.some(e => (e.q?.[n]?.[0] ?? 0) > 1e-9);

/**
 * Build the take-off specs for a set of elements.
 * opts: { set: 'NRM2'|'POMI'|'NRM1', setup (project QS setup), name (prefix), elements (all elements, for the ground level) }
 * Returns [{ kind, spec }] - one spec per element kind (concrete / steel / precast handled separately).
 */
export function structuralSpecs(ids, byId, opts = {}) {
  const setup = qsSetup({ qs: opts.setup || {} });
  const set = opts.set || setup.ruleSet;
  const gl = setup.groundLevel ?? guessGroundLevel(opts.elements || [...byId.values()]) ?? 0;
  const groups = new Map();
  for (const id of ids) {
    const e = byId.get(id); if (!e) continue;
    enrichElementQs(e);
    const mat = materialOf(e), kind = mat === 'steel' ? 'steel' : mat === 'precast' ? 'precast' : kindOf(e);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(e);
  }
  const out = [];
  for (const [kind, els] of groups) {
    const spec = kind === 'steel' ? steelSpec(els, set) : kind === 'precast' ? precastSpec(els, set) : concreteSpec(kind, els, set, setup, gl);
    if (spec && els.some(e => e.qsEstimatedQuantities?.length)) {
      spec.note += ' Some quantities use geometry/dimension fallbacks; confirm formed interfaces and measurements.';
      spec.formulas.forEach(f => { if (f.rule) f.rule.confirm = true; });
    }
    if (spec) out.push({ kind, spec: { ...spec, name: (opts.name ? opts.name + ' - ' : '') + spec.name, ids: els.map(e => e.id), ruleSet: set, parts: [(opts.name ? opts.name + ' - ' : '') + spec.name] } });
  }
  return out;
}

function makeBuilder(set, kind) {
  const inputs = [], constants = [], formulas = [];
  const R = RULES[set] || {};
  const meta = (key, extra = {}) => { const r = R[key] || {}; return { set, key, ref: r.ref || set, group: r.group || extra.group || 'Other', title: r.title || extra.title || key, confirm: Boolean(r.confirm), nrm1: NRM1_OF_KIND[kind] || '', ...extra }; };
  const input = (name, label, unit, sum = true) => {
    const key = keyOf(name);
    if (!inputs.some(i => i.key === key)) inputs.push({ key, label: label || name, unit, source: 'property', name, sum });
    return `{${key}}`;
  };
  const constant = (key, label, value, unit) => { if (!constants.some(c => c.key === key)) constants.push({ key, label, value, unit }); return `{${key}}`; };
  const formula = (key, label, unit, expr, rule) => { formulas.push({ key, label, unit, expr, rule }); };
  // a quantity read straight from the model, as a rule column
  const ruleInput = (name, ruleKey, labelExtra = '', unitOverride) => {
    const r = R[ruleKey]; if (!r) return;
    const key = keyOf(name) + '_' + keyOf(ruleKey);
    const unit = unitOverride || r.unit;
    formulas.push({ key, label: r.title + labelExtra, unit, expr: `{${keyOf(name)}}`, rule: meta(ruleKey, { band: labelExtra.trim() || undefined }) });
    if (!inputs.some(i => i.key === keyOf(name))) inputs.push({ key: keyOf(name), label: name, unit, source: 'property', name, sum: true });
  };
  return { inputs, constants, formulas, meta, input, constant, formula, ruleInput, R };
}

function concreteSpec(kind, els, set, setup, gl) {
  const B = makeBuilder(set, kind);
  const { input, constant, formula, meta, R } = B;
  B.inputs.push({ key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true });
  const V = has(els, 'Net volume') ? input('Net volume', 'Net volume', 'm3') : has(els, 'Geo volume') ? input('Geo volume', 'Geo volume', 'm3') : input('Volume', 'Volume', 'm3');
  const thick = input('Thickness (geometry)', 'Thickness', 'm', false);
  const horizontal = ['slab', 'roofslab', 'groundslab', 'beam', 'groundbeam', 'footing', 'pilecap', 'raft'].includes(kind);
  const vertical = ['column', 'wall'].includes(kind);
  const earth = () => constant('Earth', 'Foundation sides cast against earth (1 = yes, 0 = formwork)', setup.earthFaced ? 1 : 0, '');
  const anyThin = els.some(e => e.q?.['Thickness (geometry)']?.[0] != null && e.q['Thickness (geometry)'][0] <= 0.3 + 1e-9), anyThick = els.some(e => e.q?.['Thickness (geometry)']?.[0] > 0.3 + 1e-9);

  // ---------------- concrete
  if (set === 'NRM2') {
    if (kind === 'pile') {
      formula('Pile_nr', R['pile.nr'].title, 'nr', '{Count}', meta('pile.nr'));
      const len = input('Geo box height', 'Pile length', 'm');
      formula('Pile_len', R['pile.len'].title, 'm', len, meta('pile.len'));
      formula('Pile_conc', 'Concrete in piles (for reference)', 'm3', V, meta('pile.len', { group: 'Concrete', title: 'Concrete in piles', info: true }));
    } else if (kind === 'stair') {
      formula('Conc_sl', R['conc.sl'].title, 'm3', V, meta('conc.sl'));
    } else if (horizontal || vertical) {
      const thin = horizontal ? 'conc.hz.thin' : 'conc.vt.thin', thk = horizontal ? 'conc.hz.thick' : 'conc.vt.thick';
      if (anyThin) formula('Conc_thin', R[thin].title, 'm3', `IF(${thick}<=0.3, ${V}, 0)`, meta(thin));
      if (anyThick) formula('Conc_thick', R[thk].title, 'm3', `IF(${thick}>0.3, ${V}, 0)`, meta(thk));
      const unknown = els.filter(e => e.q?.['Thickness (geometry)']?.[0] == null);
      if (unknown.length) {
        B.inputs.push({ key: 'Unclassified_volume', label: 'Concrete volume with unknown thickness', unit: 'm3', source: 'map', map: Object.fromEntries(els.map(e => [e.id,
          unknown.includes(e) ? e.q?.['Net volume']?.[0] ?? e.q?.['Geo volume']?.[0] ?? e.q?.Volume?.[0] ?? null : 0])), sum: false });
        formula('Conc_unknown', 'Concrete; thickness unknown (review)', 'm3', '{Unclassified_volume}', meta(thin, { confirm: true, title: 'Concrete; thickness unknown (review)' }));
      }
    }
  } else if (set === 'POMI') {
    const ck = { footing: 'conc.fdn', pilecap: 'conc.fdn', raft: 'conc.fdn', groundbeam: 'conc.fdn', pile: 'conc.fdn', groundslab: 'conc.bed', slab: 'conc.slab', roofslab: 'conc.slab',
      beam: 'conc.beam', column: 'conc.col', wall: 'conc.wall', stair: 'conc.stair' }[kind];
    if (ck) formula('Conc', R[ck].title, 'm3', V, meta(ck));
    if (kind === 'pile') { formula('Pile_nr', R['pile.nr'].title, 'nr', '{Count}', meta('pile.nr')); formula('Pile_len', R['pile.len'].title, 'm', input('Geo box height', 'Pile length', 'm'), meta('pile.len')); }
  } else {           // NRM1: components with the element code; the element unit quantity is added below
    formula('Conc', 'Concrete', 'm3', V, meta('conc', { group: 'Concrete', title: 'Concrete' }));
  }

  // ---------------- formwork
  const fw = (name, ruleKey, extra = '', factor = '') => {
    if (!has(els, name)) return;
    const r = R[ruleKey];
    const key = 'FW_' + keyOf(ruleKey) + (extra ? '_' + keyOf(extra) : '');
    const src = input(name, name, r ? r.unit : 'm2');
    if (set === 'NRM1') return;                      // NRM1 totals formwork below
    formula(key, r.title + (extra ? `, ${extra}` : ''), r.unit, factor ? `${src} * ${factor}` : src, meta(ruleKey, { band: extra || undefined }));
  };
  const notEarth = () => `(1 - ${earth()})`;
  if (['slab', 'roofslab'].includes(kind)) {
    if (set === 'NRM2') { for (const b of BAND_ORDER) fw(`FW soffit ${b} m`, 'fw.soffit', bandText(b));
      if (!BAND_ORDER.some(b => has(els, `FW soffit ${b} m`))) fw('FW soffit', 'fw.soffit', 'propping height unknown (review)'); }
    else fw('FW soffit', 'fw.soffit');
    fw('FW sloping soffit', 'fw.soffit.slope');
    if (set === 'NRM2') { fw('FW narrow length', 'fw.edge.narrow'); fw('FW wide sides', 'fw.edge.wide'); }
    else fw('FW narrow length', 'fw.edge');
    fw('FW sloping top', 'fw.top');
  } else if (kind === 'groundslab') {
    if (set === 'NRM2') { fw('FW narrow length', 'fw.edge.narrow'); fw('FW wide sides', 'fw.edge.wide'); }
    else fw('FW narrow length', 'fw.edge');
  } else if (kind === 'beam') {
    fw('FW soffit', 'fw.beam.soffit'); fw('FW sloping soffit', set === 'NRM2' ? 'fw.soffit.slope' : 'fw.soffit.slope');
    fw('FW sides', 'fw.beam.sides');
  } else if (kind === 'groundbeam') {
    fw('FW sides', 'fw.beam.sides', 'ground beams', has(els, 'FW sides') ? notEarth() : '');
  } else if (kind === 'column') {
    fw('FW sides', 'fw.col');
  } else if (kind === 'wall') {
    fw('FW wide sides', 'fw.wall');
    if (set === 'NRM2') fw('FW narrow length', 'fw.wall.end'); else fw('FW narrow sides', 'fw.wall', 'wall ends');
  } else if (['footing', 'pilecap', 'raft'].includes(kind)) {
    if (set === 'NRM2') { if (has(els, 'FW narrow length')) fw('FW narrow length', 'fw.fdn.narrow', '', notEarth()); if (has(els, 'FW wide sides')) fw('FW wide sides', 'fw.fdn.wide', '', notEarth()); }
    else if (has(els, 'FW sides')) fw('FW sides', 'fw.fdn', '', notEarth());
  } else if (kind === 'stair') {
    fw('FW sloping soffit', 'fw.soffit.slope'); fw('FW soffit', set === 'NRM2' ? 'fw.soffit' : 'fw.soffit', 'landings');
  }
  if (set === 'NRM1') {
    const parts = ['FW soffit', 'FW sloping soffit', 'FW sides', 'FW sloping top'].filter(n => has(els, n)).map(n => input(n, n, 'm2'));
    const fdn = ['footing', 'pilecap', 'raft', 'groundbeam'].includes(kind);
    if (parts.length) formula('FW', 'Formwork', 'm2', fdn ? `(${parts.join(' + ')}) * ${notEarth()}` : parts.join(' + '), meta('fw', { group: 'Formwork', title: 'Formwork' }));
  }

  // ---------------- reinforcement (allowance until a bar schedule is available)
  {
    const rate = constant('Rate', `Reinforcement rate, ${KIND_LABEL[kind] || kind} (kg/m3)`, setup.rates[kind] ?? 100, 'kg/m3');
    formula('Rebar', set === 'NRM1' ? 'Reinforcement' : R['rb.bars'].title, 't', `${V} * ${rate} / 1000`, meta('rb.bars', { allowance: true }));
  }

  // ---------------- waterproofing (where the project setup says it is required)
  const wp = (key, ruleKey, unit, expr, extra = '') => formula(key, (R[ruleKey]?.title || 'Waterproofing') + (extra ? `, ${extra}` : ''), unit, expr, meta(ruleKey, { group: 'Waterproofing' }));
  if (setup.wpUnderGround && ['footing', 'pilecap', 'raft', 'groundslab', 'groundbeam'].includes(kind) && has(els, 'Area on ground'))
    wp('WP_under', 'wp.flat', 'm2', input('Area on ground', 'Area on ground', 'm2'), 'under foundations and slabs');
  if (setup.wpFoundationSides && ['footing', 'pilecap', 'raft', 'groundbeam'].includes(kind) && has(els, 'FW sides'))
    wp('WP_fsides', 'wp.vertical', 'm2', input('FW sides', 'FW sides', 'm2'), 'sides of foundations');
  if (kind === 'wall' && has(els, 'Outer face area') && els.some(e => (e.q?.['Outer face bottom']?.[0] ?? Infinity) < gl)) {
    const A = input('Outer face area', 'Outer face area', 'm2', false), lo = input('Outer face bottom', 'Outer face bottom level', 'm', false), hi = input('Outer face top', 'Outer face top level', 'm', false);
    const G = constant('GL', 'Ground level (model elevation, m)', Math.round(gl * 1000) / 1000, 'm'), U = constant('Upturn', 'Waterproofing upturn above ground level', setup.wpUpturn, 'm');
    wp('WP_wall', 'wp.vertical', 'm2', `IF(${hi}>${lo}, ${A} * MAX(0, MIN(1, (${G} + ${U} - ${lo}) / (${hi} - ${lo}))), 0)`, 'outer face of walls below ground');
  }
  if (setup.wpRoof && kind === 'roofslab' && has(els, 'Top exposed')) {
    wp('WP_roof', 'wp.flat', 'm2', input('Top exposed', 'Top exposed', 'm2'), 'roof');
    if (has(els, 'Exposed perimeter')) {
      const P = input('Exposed perimeter', 'Roof perimeter', 'm'), U = constant('RoofUp', 'Roof upturn height', setup.roofUpturn, 'm');
      if (setup.roofUpturn <= 0.5 && set === 'NRM2') wp('WP_upstand', 'wp.upstand', 'm', P, `girth ${Math.round(setup.roofUpturn * 1000)} mm`);
      else wp('WP_upstand', 'wp.vertical', 'm2', `${P} * ${U}`, 'roof upstands');
    }
  }

  // ---------------- NRM1 element unit quantity
  if (set === 'NRM1') {
    const euq = { slab: ['Geo plan area', 'Upper floor area'], roofslab: ['Top exposed', 'Roof area'], groundslab: ['Area on ground', 'Lowest floor area'], wall: ['FW wide sides', 'Wall area (both faces)'] }[kind];
    if (euq && has(els, euq[0])) formula('EUQ', `Element unit quantity: ${euq[1]}`, 'm2', input(euq[0], euq[1], 'm2'), meta('euq', { group: 'Element', title: euq[1] }));
  }
  const name = KIND_LABEL[kind] || 'Concrete';
  const note = `${set} take-off of ${name.toLowerCase()}: concrete, formwork, reinforcement${B.formulas.some(f => f.rule?.group === 'Waterproofing') ? ', waterproofing' : ''}. Formwork = free faces (not touching concrete, ground or blinding). Reinforcement is an allowance at the stated rate.`;
  return { name, by: 'type', note, details: ['type', 'level', 'mark'], inputs: B.inputs, constants: B.constants, formulas: B.formulas, qsKind: kind };
}

function steelSpec(els, set) {
  const R = RULES[set === 'NRM1' ? 'NRM2' : set];
  const len = els.some(e => e.q?.['Cut Length']) ? 'Cut Length' : els.some(e => e.q?.Length) ? 'Length' : 'Geo box length';
  const map = Object.fromEntries(els.map(e => [e.id, steelMass(e.type)]).filter(([, m]) => m != null));
  const inputs = [{ key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true }, { key: 'Len', label: len, unit: 'm', source: 'property', name: len, sum: true },
    { key: 'Kgm', label: 'Section mass', unit: 'kg/m', source: 'map', map, sum: false }];
  return { name: 'Structural steel', by: 'type', note: `${set}: structural steel, mass = length x section mass (kg/m from the section name).`, details: ['type', 'level'],
    inputs, constants: [], formulas: [{ key: 'Steel_t', label: R['steel.t'].title, unit: 't', expr: '{Len} * {Kgm} / 1000', rule: { set, key: 'steel.t', ref: R['steel.t'].ref, group: 'Structural steel', title: R['steel.t'].title, confirm: true, nrm1: '2.1' } }], qsKind: 'steel' };
}
function precastSpec(els, set) {
  const R = RULES[set === 'NRM1' ? 'NRM2' : set];
  return { name: 'Precast concrete', by: 'type', note: `${set}: precast concrete units, enumerated; formwork and reinforcement are part of the unit.`, details: ['type', 'level', 'mark'],
    inputs: [{ key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true }, { key: 'Volume', label: 'Volume', unit: 'm3', source: 'property', name: els.some(e => e.q?.['Geo volume']) ? 'Geo volume' : 'Volume', sum: true }],
    constants: [], formulas: [{ key: 'PC_nr', label: R['precast.nr'].title, unit: 'nr', expr: '{Count}', rule: { set, key: 'precast.nr', ref: R['precast.nr'].ref, group: 'Precast concrete', title: R['precast.nr'].title, confirm: Boolean(R['precast.nr'].confirm), nrm1: '2.1' } }], qsKind: 'precast' };
}

// ================================================================== the library (structural items + other trades)
/** Each item: { id, name, discipline, filter (applyFilter format), kind: 'structural' | 'simple', quantities, formulas, constants } */
const S = (id, name, filter, desc) => ({ id, name, discipline: 'Structure', kind: 'structural', filter, description: desc });
const Q = (id, name, discipline, filter, quantities, extra = {}) => ({ id, name, discipline, kind: 'simple', filter, quantities, ...extra });
export const ITEMS = [
  // structure: concrete, formwork, reinforcement and waterproofing in one table, by the chosen rules
  S('st-piles', 'Piles', { category: ['Structural Foundations'], qsKind: ['pile'] }, 'Number, length, concrete (reference), reinforcement allowance'),
  S('st-pilecaps', 'Pile caps', { category: ['Structural Foundations'], qsKind: ['pilecap'] }, 'Concrete, side formwork, reinforcement, waterproofing under'),
  S('st-footings', 'Isolated and strip footings', { category: ['Structural Foundations'], qsKind: ['footing'] }, 'Concrete, side formwork (or earth-faced), reinforcement, waterproofing'),
  S('st-raft', 'Raft foundations', { category: ['Structural Foundations'], qsKind: ['raft'] }, 'Concrete, edge formwork, reinforcement, waterproofing under'),
  S('st-groundbeams', 'Ground beams', { category: ['Structural Framing', 'Structural Foundations'], qsKind: ['groundbeam'] }, 'Concrete, side formwork, reinforcement'),
  S('st-groundslab', 'Ground-bearing slabs', { category: ['Floors'], qsKind: ['groundslab'] }, 'Concrete by thickness, edge formwork, reinforcement, waterproofing under'),
  S('st-columns', 'Columns', { category: ['Structural Columns'], qsKind: ['column'] }, 'Concrete, column formwork, reinforcement'),
  S('st-beams', 'Beams', { category: ['Structural Framing'], qsKind: ['beam'] }, 'Concrete, soffit and side formwork, reinforcement'),
  S('st-slabs', 'Suspended slabs', { category: ['Floors'], qsKind: ['slab'] }, 'Concrete by thickness, soffit formwork by propping height, edges, reinforcement'),
  S('st-roofslabs', 'Roof slabs', { category: ['Floors', 'Roofs'], qsKind: ['roofslab'] }, 'As slabs, plus roof waterproofing and upstands'),
  S('st-walls', 'Walls and cores', { category: ['Walls'], material: ['insitu'] }, 'Concrete, wall formwork, ends, reinforcement, waterproofing below ground'),
  S('st-stairs', 'Stairs and landings', { category: ['Stairs', 'Runs', 'Landings'] }, 'Concrete, soffit formwork, reinforcement'),
  S('st-steel', 'Structural steel', { material: ['steel'] }, 'Mass in tonnes from section mass x length'),
  S('st-precast', 'Precast concrete', { material: ['precast'] }, 'Number of units, volume'),
  S('st-all', 'Whole structure (all of the above)', { category: ['Structural Foundations', 'Structural Framing', 'Structural Columns', 'Floors', 'Walls', 'Stairs', 'Runs', 'Landings', 'Roofs'] }, 'One table per element type'),
  // substructure work from the foundation geometry (ground level from the project QS setup)
  Q('sb-excavation', 'Excavation to formation (net)', 'Structure', { category: ['Structural Foundations', 'Floors', 'Structural Framing'], qsKind: ['footing', 'pilecap', 'raft', 'groundbeam', 'groundslab'] },
    ['Count', 'Area on ground', 'Bottom level'], { constants: [{ key: 'GL', label: 'Ground level (model elevation, m)', value: 'GL', unit: 'm' }],
      formulas: [{ label: 'Excavation, net volume to formation', unit: 'm3', expr: '{Area_on_ground} * MAX(0, {GL} - {Bottom_level})' }], note: 'Net volume: plan area on ground x depth from ground level to the underside. Working space and battering are not included.' }),
  Q('sb-blinding', 'Blinding under foundations and slabs', 'Structure', { category: ['Structural Foundations', 'Floors', 'Structural Framing'], qsKind: ['footing', 'pilecap', 'raft', 'groundbeam', 'groundslab'] },
    ['Count', 'Area on ground'], { constants: [{ key: 'BT', label: 'Blinding thickness', value: 0.05, unit: 'm' }],
      formulas: [{ label: 'Blinding, area', unit: 'm2', expr: '{Area_on_ground}' }, { label: 'Blinding, volume', unit: 'm3', expr: '{Area_on_ground} * {BT}' }] }),
  Q('sb-hardcore', 'Hardcore and fill under ground slabs', 'Structure', { category: ['Floors'], qsKind: ['groundslab'] },
    ['Count', 'Area on ground'], { constants: [{ key: 'HT', label: 'Hardcore thickness', value: 0.15, unit: 'm' }],
      formulas: [{ label: 'Hardcore, area', unit: 'm2', expr: '{Area_on_ground}' }, { label: 'Hardcore, volume', unit: 'm3', expr: '{Area_on_ground} * {HT}' }] }),
  Q('sb-dpm', 'Damp-proof membrane under ground slabs', 'Structure', { category: ['Floors'], qsKind: ['groundslab'] },
    ['Count', 'Area on ground'], { formulas: [{ label: 'Damp-proof membrane (no allowance for laps)', unit: 'm2', expr: '{Area_on_ground}' }] }),
  // masonry and architecture
  Q('ar-blockwork', 'Blockwork walls', 'Architecture', { category: ['Walls'], material: ['masonry', 'other'] }, ['Count', 'Area', 'Openings to deduct', 'Length'], { formulas: [{ label: 'Net wall area', unit: 'm2', expr: '{Area} - {Openings_to_deduct}' }] }),
  Q('ar-curtain', 'Curtain walling', 'Architecture', { category: ['Curtain Panels', 'Curtain Wall Mullions', 'Walls'], type_contains: ['curtain', 'glazing'] }, ['Count', 'Area', 'Length']),
  Q('ar-doors', 'Doors', 'Architecture', { category: ['Doors'] }, ['Count', 'Width', 'Height']),
  Q('ar-windows', 'Windows', 'Architecture', { category: ['Windows'] }, ['Count', 'Width', 'Height', 'Area']),
  Q('ar-roofs', 'Roof coverings', 'Architecture', { category: ['Roofs'] }, ['Count', 'Area']),
  Q('ar-ceilings', 'Ceilings', 'Interiors', { category: ['Ceilings'] }, ['Count', 'Area', 'Perimeter']),
  Q('ar-floorfin', 'Floor finishes', 'Interiors', { category: ['Floors'], type_contains: ['finish', 'tile', 'screed', 'carpet', 'vinyl', 'marble', 'stone'] }, ['Count', 'Area', 'Perimeter']),
  Q('ar-skirting', 'Skirtings (from floor finish perimeters)', 'Interiors', { category: ['Floors'], type_contains: ['finish', 'tile', 'carpet', 'vinyl', 'marble'] }, ['Count', 'Perimeter']),
  Q('ar-wallfin', 'Wall finishes (plaster and paint)', 'Interiors', { category: ['Walls'], type_contains: ['finish', 'plaster', 'paint', 'cladding', 'tile'] }, ['Count', 'Area', 'Openings to deduct'], { formulas: [{ label: 'Net finish area', unit: 'm2', expr: '{Area} - {Openings_to_deduct}' }] }),
  Q('ar-wetareas', 'Wet area waterproofing (floors marked wet)', 'Architecture', { category: ['Floors'], type_contains: ['wet', 'toilet', 'bath', 'kitchen', 'balcony', 'wc'] }, ['Count', 'Area', 'Perimeter'],
    { constants: [{ key: 'Upturn', label: 'Waterproofing upturn on walls', value: 0.15, unit: 'm' }], formulas: [{ label: 'Waterproofing, flat', unit: 'm2', expr: '{Area}' }, { label: 'Waterproofing, upturn', unit: 'm2', expr: '{Perimeter} * {Upturn}' }] }),
  Q('ar-railings', 'Railings and balustrades', 'Architecture', { category: ['Railings'] }, ['Count', 'Length']),
  Q('ar-stairs-arch', 'Stair finishes', 'Interiors', { category: ['Stairs', 'Runs'] }, ['Count', 'Actual Number of Risers', 'Actual Run Width']),
  Q('ar-casework', 'Casework and joinery', 'Interiors', { category: ['Casework'] }, ['Count', 'Width']),
  Q('ar-furniture', 'Furniture', 'Interiors', { category: ['Furniture', 'Furniture Systems'] }, ['Count']),
  Q('ar-sanitary', 'Sanitary fittings', 'Interiors', { category: ['Plumbing Fixtures'] }, ['Count']),
  Q('ar-specialty', 'Specialty equipment', 'Interiors', { category: ['Specialty Equipment'] }, ['Count']),
  Q('ar-generic', 'Generic models', 'Architecture', { category: ['Generic Models'] }, ['Count', 'Volume', 'Area']),
  // MEP
  Q('mep-pipes', 'Pipes by size', 'MEP', { category: ['Pipes'] }, ['Count', 'Length'], { by: 'type' }),
  Q('mep-pipefit', 'Pipe fittings', 'MEP', { category: ['Pipe Fittings'] }, ['Count']),
  Q('mep-pipeacc', 'Pipe accessories and valves', 'MEP', { category: ['Pipe Accessories'] }, ['Count']),
  Q('mep-pipeins', 'Pipe insulation', 'MEP', { category: ['Pipe Insulations'] }, ['Count', 'Length', 'Area']),
  Q('mep-ducts', 'Ductwork', 'MEP', { category: ['Ducts'] }, ['Count', 'Length', 'Area']),
  Q('mep-ductfit', 'Duct fittings', 'MEP', { category: ['Duct Fittings'] }, ['Count']),
  Q('mep-ductins', 'Duct insulation and lining', 'MEP', { category: ['Duct Insulations', 'Duct Linings'] }, ['Count', 'Area']),
  Q('mep-terminals', 'Air terminals (grilles, diffusers)', 'MEP', { category: ['Air Terminals'] }, ['Count']),
  Q('mep-mech', 'Mechanical equipment', 'MEP', { category: ['Mechanical Equipment'] }, ['Count']),
  Q('mep-trays', 'Cable trays and ladders', 'MEP', { category: ['Cable Trays'] }, ['Count', 'Length']),
  Q('mep-trayfit', 'Cable tray fittings', 'MEP', { category: ['Cable Tray Fittings'] }, ['Count']),
  Q('mep-conduits', 'Conduits', 'MEP', { category: ['Conduits'] }, ['Count', 'Length']),
  Q('mep-lights', 'Light fixtures', 'MEP', { category: ['Lighting Fixtures', 'Lighting Devices'] }, ['Count']),
  Q('mep-elec', 'Electrical equipment and fixtures', 'MEP', { category: ['Electrical Equipment', 'Electrical Fixtures'] }, ['Count']),
  Q('mep-devices', 'Devices (fire alarm, data, security)', 'MEP', { category: ['Fire Alarm Devices', 'Data Devices', 'Security Devices', 'Communication Devices', 'Nurse Call Devices'] }, ['Count']),
  Q('mep-sprinklers', 'Sprinklers', 'MEP', { category: ['Sprinklers'] }, ['Count']),
  // landscape
  Q('ls-paving', 'Hard landscape paving', 'Landscape', { category: ['Floors', 'Topography', 'Hardscape', 'Site'], type_contains: ['paving', 'paver', 'hardscape', 'asphalt', 'interlock', 'stone'] }, ['Count', 'Area', 'Perimeter']),
  Q('ls-kerbs', 'Kerbs and edgings', 'Landscape', { type_contains: ['kerb', 'curb', 'edging'] }, ['Count', 'Length']),
  Q('ls-planters', 'Planters', 'Landscape', { type_contains: ['planter'] }, ['Count', 'Volume']),
  Q('ls-planting', 'Trees and planting', 'Landscape', { category: ['Planting'] }, ['Count']),
  Q('ls-softscape', 'Soft landscape areas', 'Landscape', { type_contains: ['grass', 'turf', 'soft', 'shrub', 'mulch'] }, ['Count', 'Area']),
  Q('ls-irrigation', 'Irrigation pipes and ducts', 'Landscape', { category: ['Pipes', 'Conduits'], type_contains: ['irrigation', 'ir '] }, ['Count', 'Length'], { by: 'type' }),
  Q('ls-site', 'Site furniture and lighting', 'Landscape', { category: ['Site', 'Lighting Fixtures'], type_contains: ['bench', 'bollard', 'bin', 'pole', 'site'] }, ['Count']),
  Q('ls-walls', 'Landscape walls', 'Landscape', { category: ['Walls'], type_contains: ['landscape', 'retaining', 'boundary', 'garden'] }, ['Count', 'Length', 'Area', 'Volume']),
];

/** Elements matching an item's filter (extends the template filter with qsKind and material). */
export function itemIds(item, E, applyFilter) {
  const f = item.filter || {};
  const base = applyFilter({ category: f.category, type_contains: f.type_contains });
  const byId = new Map(E.map(e => [e.id, e]));
  return base.filter(id => {
    const e = byId.get(id);
    if (f.qsKind && !f.qsKind.includes(kindOf(e))) return false;
    if (f.material && !f.material.includes(materialOf(e))) return false;
    if (item.kind === 'structural' && !f.material && ['steel', 'precast'].includes(materialOf(e)) && item.id !== 'st-all') return false;
    return true;
  });
}
/** Specs for an item on given ids. Structural items use the rules; the others list their quantities. */
export function itemSpecs(item, ids, byId, opts = {}) {
  if (item.kind === 'structural') return structuralSpecs(ids, byId, { ...opts, name: item.id === 'st-all' ? '' : '' }).map(x => x.spec);
  const els = ids.map(id => byId.get(id)).filter(Boolean);
  const inputs = [];
  for (const qn of item.quantities) {
    if (qn === 'Count') { inputs.push({ key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true }); continue; }
    const e = els.find(x => x.q?.[qn]); if (!e) continue;
    inputs.push({ key: keyOf(qn), label: qn, unit: e.q[qn][1], source: 'property', name: qn, sum: e.q[qn][1] !== '' });
  }
  const keys = new Set(inputs.map(i => i.key));
  const setup = qsSetup({ qs: opts.setup || {} });
  const gl = setup.groundLevel ?? guessGroundLevel(opts.elements || [...byId.values()]) ?? 0;
  const constants = (item.constants || []).map(c => ({ ...c, value: c.value === 'GL' ? Math.round(gl * 1000) / 1000 : c.value }));
  constants.forEach(c => keys.add(c.key));
  const formulas = (item.formulas || []).filter(f => [...f.expr.matchAll(/\{(\w+)\}/g)].every(m => keys.has(m[1])))
    .map((f, i) => ({ key: 'F' + (i + 1), label: f.label, unit: f.unit, expr: f.expr, rule: { set: opts.set || 'NRM2', key: item.id, ref: '', group: item.discipline, title: f.label, nrm1: '' } }));
  return [{ name: item.name, ids: els.map(e => e.id), by: item.by || 'type', note: item.note || `${item.name}: quantities from the model (${item.discipline}).`, details: ['type', 'level'], inputs, constants, formulas, parts: [item.name], ruleSet: opts.set }];
}
export const LIMITS_TEXT = (set) => {
  const l = LIMITS[set] || {};
  const v = (x) => (x == null ? 'n/a' : typeof x === 'object' ? (x.v == null ? 'to confirm' : `${x.v} (to confirm)`) : x);
  return set === 'NRM1' ? 'NRM1: element unit quantities with component quantities (concrete, formwork, reinforcement).'
    : `${set}: thickness split ${v(l.thick)} m; narrow items ${v(l.narrow)} m; voids not deducted in concrete ${v(l.concreteVoid)} m3, formwork ${v(l.formworkVoid)} m2; soffits ${l.bands ? l.bandText : 'not split by propping height'}; ${l.laps || ''}`;
};
