// Measurement rules (POMI, NRM2, NRM1) as data, the element classification a QS would make, and the project QS
// setup. Pure module: shared by the task pane, the 3D window, the AI and the tests. Rules marked confirm: true
// are written from secondary sources and must be checked against the user's licensed copy before release.
//
// Sources: RICS NRM2 2nd edition (effective 1 Dec 2021), Work section 11 notes (GCU), Principles of Measurement
// (International) 1979, NRM1 (RICS, 2021). The app stores what each rule does, never the RICS wording itself.

export const RULE_SETS = {
  NRM2: { id: 'NRM2', name: 'NRM2', full: 'RICS NRM2: Detailed measurement for building works, 2nd edition (effective 1 Dec 2021)', use: 'Bills of quantities' },
  POMI: { id: 'POMI', name: 'POMI', full: 'Principles of Measurement (International) for works of construction, RICS 1979', use: 'Bills of quantities (common in the Gulf)' },
  NRM1: { id: 'NRM1', name: 'NRM1', full: 'RICS NRM1: Order of cost estimating and cost planning, 3rd edition (2021)', use: 'Cost plans (elemental)' },
};

/** Thresholds and conventions by rule set. confirm: written from secondary sources; check against the RICS copy. */
export const LIMITS = {
  NRM2: { thick: 0.3, slope: 15, narrow: 0.5, concreteVoid: 0.05, formworkVoid: 5, meshVoid: 1, wpVoid: { v: 1, confirm: true },
    bands: true, bandText: 'propping height up to 3 m, 3 to 4.5 m, then 1.5 m stages', laps: 'Mesh laps deemed included' },
  POMI: { thick: null, slope: 15, narrow: null, concreteVoid: { v: null, confirm: true }, formworkVoid: { v: 1, confirm: true }, meshVoid: null, wpVoid: { v: 1, confirm: true },
    bands: false, laps: 'No allowance for laps (fabric and tanking)' },
  NRM1: { },
};

/**
 * Rule items: what is measured, the unit and the reference. Keys are referenced by the measure items.
 * group: Concrete | Formwork | Reinforcement | Waterproofing | Other.
 */
export const RULES = {
  NRM2: {
    'conc.hz.thin': { ref: 'NRM2 11.2', group: 'Concrete', unit: 'm3', title: 'Horizontal work, not exceeding 300 mm thick' },
    'conc.hz.thick': { ref: 'NRM2 11.2', group: 'Concrete', unit: 'm3', title: 'Horizontal work, exceeding 300 mm thick' },
    'conc.vt.thin': { ref: 'NRM2 11.5', group: 'Concrete', unit: 'm3', title: 'Vertical work, not exceeding 300 mm thick' },
    'conc.vt.thick': { ref: 'NRM2 11.5', group: 'Concrete', unit: 'm3', title: 'Vertical work, exceeding 300 mm thick' },
    'conc.sl': { ref: 'NRM2 11.3/11.4', group: 'Concrete', unit: 'm3', title: 'Sloping work (stairs and ramps)' },
    'conc.mass': { ref: 'NRM2 11.1', group: 'Concrete', unit: 'm3', title: 'Mass concrete' },
    'fw.soffit': { ref: 'NRM2 11.15', group: 'Formwork', unit: 'm2', title: 'Soffits of horizontal work', banded: true },
    'fw.soffit.slope': { ref: 'NRM2 11.25', group: 'Formwork', unit: 'm2', title: 'Soffits of sloping work' },
    'fw.edge.narrow': { ref: 'NRM2 11.14', group: 'Formwork', unit: 'm', title: 'Edges of horizontal work, not exceeding 500 mm high' },
    'fw.edge.wide': { ref: 'NRM2 11.14', group: 'Formwork', unit: 'm2', title: 'Edges of horizontal work, exceeding 500 mm high' },
    'fw.fdn.narrow': { ref: 'NRM2 11.13', group: 'Formwork', unit: 'm', title: 'Sides of foundations and bases, not exceeding 500 mm high' },
    'fw.fdn.wide': { ref: 'NRM2 11.13', group: 'Formwork', unit: 'm2', title: 'Sides of foundations and bases, exceeding 500 mm high' },
    'fw.beam.soffit': { ref: 'NRM2 11.17-11.19', group: 'Formwork', unit: 'm2', title: 'Soffits of beams', confirm: true },
    'fw.beam.sides': { ref: 'NRM2 11.17-11.19', group: 'Formwork', unit: 'm2', title: 'Sides of beams' },
    'fw.col': { ref: 'NRM2 11.20-11.21', group: 'Formwork', unit: 'm2', title: 'Sides of columns' },
    'fw.wall': { ref: 'NRM2 11.22', group: 'Formwork', unit: 'm2', title: 'Walls, vertical' },
    'fw.wall.end': { ref: 'NRM2 11.24', group: 'Formwork', unit: 'm', title: 'Wall ends, not exceeding 500 mm wide' },
    'fw.top': { ref: 'NRM2 11.28', group: 'Formwork', unit: 'm2', title: 'Top formwork to surfaces sloping more than 15 degrees' },
    'rb.bars': { ref: 'NRM2 11.33-11.34', group: 'Reinforcement', unit: 't', title: 'Bar reinforcement (allowance from kg/m3 rate until the bar schedule is available)' },
    'wp.flat': { ref: 'NRM2 19', group: 'Waterproofing', unit: 'm2', title: 'Waterproofing, horizontal (flat)', confirm: true },
    'wp.vertical': { ref: 'NRM2 19', group: 'Waterproofing', unit: 'm2', title: 'Waterproofing, vertical', confirm: true },
    'wp.upstand': { ref: 'NRM2 19', group: 'Waterproofing', unit: 'm', title: 'Upstands and skirtings, girth not exceeding 500 mm', confirm: true },
    'pile.nr': { ref: 'NRM2 7', group: 'Piling', unit: 'nr', title: 'Piles', confirm: true },
    'pile.len': { ref: 'NRM2 7', group: 'Piling', unit: 'm', title: 'Pile length', confirm: true },
    'steel.t': { ref: 'NRM2 15', group: 'Structural steel', unit: 't', title: 'Structural steel members', confirm: true },
    'precast.nr': { ref: 'NRM2 13', group: 'Precast concrete', unit: 'nr', title: 'Precast concrete units (formwork and reinforcement deemed included)' },
  },
  POMI: {
    'conc.fdn': { ref: 'POMI C2', group: 'Concrete', unit: 'm3', title: 'Concrete in foundations' },
    'conc.bed': { ref: 'POMI C2', group: 'Concrete', unit: 'm3', title: 'Concrete in beds (ground slabs), thickness stated' },
    'conc.slab': { ref: 'POMI C2', group: 'Concrete', unit: 'm3', title: 'Concrete in suspended slabs, thickness stated' },
    'conc.beam': { ref: 'POMI C2', group: 'Concrete', unit: 'm3', title: 'Concrete in beams' },
    'conc.col': { ref: 'POMI C2', group: 'Concrete', unit: 'm3', title: 'Concrete in columns' },
    'conc.wall': { ref: 'POMI C2', group: 'Concrete', unit: 'm3', title: 'Concrete in walls, thickness stated' },
    'conc.stair': { ref: 'POMI C2', group: 'Concrete', unit: 'm3', title: 'Concrete in staircases' },
    'fw.soffit': { ref: 'POMI C4', group: 'Formwork', unit: 'm2', title: 'Formwork to soffits of slabs' },
    'fw.soffit.slope': { ref: 'POMI C4', group: 'Formwork', unit: 'm2', title: 'Formwork to sloping soffits (over 15 degrees)' },
    'fw.edge': { ref: 'POMI C4', group: 'Formwork', unit: 'm', title: 'Formwork to edges of slabs, height stated' },
    'fw.fdn': { ref: 'POMI C4', group: 'Formwork', unit: 'm2', title: 'Formwork to sides of foundations' },
    'fw.beam.soffit': { ref: 'POMI C4', group: 'Formwork', unit: 'm2', title: 'Formwork to soffits of beams' },
    'fw.beam.sides': { ref: 'POMI C4', group: 'Formwork', unit: 'm2', title: 'Formwork to sides of beams' },
    'fw.col': { ref: 'POMI C4', group: 'Formwork', unit: 'm2', title: 'Formwork to sides of columns' },
    'fw.wall': { ref: 'POMI C4', group: 'Formwork', unit: 'm2', title: 'Formwork to sides of walls' },
    'fw.top': { ref: 'POMI C4', group: 'Formwork', unit: 'm2', title: 'Formwork to top surfaces sloping more than 15 degrees' },
    'rb.bars': { ref: 'POMI C3', group: 'Reinforcement', unit: 't', title: 'Bar reinforcement, diameter stated (allowance from kg/m3 rate until the bar schedule is available)' },
    'wp.flat': { ref: 'POMI G2', group: 'Waterproofing', unit: 'm2', title: 'Tanking and waterproofing, flat' },
    'wp.vertical': { ref: 'POMI G2', group: 'Waterproofing', unit: 'm2', title: 'Tanking and waterproofing, vertical' },
    'wp.upstand': { ref: 'POMI G2', group: 'Waterproofing', unit: 'm', title: 'Waterproofing upstands, girth stated', confirm: true },
    'pile.nr': { ref: 'POMI B', group: 'Piling', unit: 'nr', title: 'Piles', confirm: true },
    'pile.len': { ref: 'POMI B', group: 'Piling', unit: 'm', title: 'Pile length', confirm: true },
    'steel.t': { ref: 'POMI E', group: 'Structural steel', unit: 't', title: 'Structural steelwork', confirm: true },
    'precast.nr': { ref: 'POMI C', group: 'Precast concrete', unit: 'nr', title: 'Precast concrete units', confirm: true },
  },
};

/** NRM1 elements (cost plan). unitQ: how the element unit quantity is measured from the model. confirm: check codes and units. */
export const NRM1 = [
  { code: '0', name: 'Facilitating works' },
  { code: '1', name: 'Substructure', kids: [['1.1.1', 'Standard foundations'], ['1.1.2', 'Specialist foundations (piling)'], ['1.1.3', 'Lowest floor construction'], ['1.1.4', 'Basement excavation'], ['1.1.5', 'Basement retaining walls']] },
  { code: '2', name: 'Superstructure', kids: [['2.1', 'Frame'], ['2.2', 'Upper floors'], ['2.3', 'Roof'], ['2.4', 'Stairs and ramps'], ['2.5', 'External walls'], ['2.6', 'Windows and external doors'], ['2.7', 'Internal walls and partitions'], ['2.8', 'Internal doors']] },
  { code: '3', name: 'Internal finishes', kids: [['3.1', 'Wall finishes'], ['3.2', 'Floor finishes'], ['3.3', 'Ceiling finishes']] },
  { code: '4', name: 'Fittings, furnishings and equipment' },
  { code: '5', name: 'Services' },
  { code: '6', name: 'Prefabricated buildings and building units' },
  { code: '7', name: 'Work to existing buildings' },
  { code: '8', name: 'External works' },
];
export const NRM1_CONFIRM = true;
export const nrm1Name = (code) => { for (const g of NRM1) { if (g.code === code) return g.name; for (const [c, n] of g.kids || []) if (c === code) return n; } return ''; };

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
  return /structural|^floors$|^walls$|stairs?|runs|landings/i.test(e.cat || '') ? 'insitu' : 'other';
}
const q = (e, n) => e.q?.[n]?.[0] ?? 0;
/** The kind of element a QS sees: pile, pilecap, footing, raft, groundbeam, beam, column, slab, groundslab, roofslab, wall, stair, other. */
export function kindOf(e) {
  const cat = String(e.cat || ''), t = `${e.fam} ${e.type}`.toLowerCase();
  const bb = e.bb ? [e.bb[3] - e.bb[0], e.bb[4] - e.bb[1], e.bb[5] - e.bb[2]] : null;
  const plan = q(e, 'Geo plan area') || q(e, 'Area');
  if (/foundation/i.test(cat)) {
    if (/pile/.test(t) && !/cap/.test(t)) return 'pile';
    if (/cap/.test(t)) return 'pilecap';
    if (/raft|mat\b/.test(t) || plan > 50) return 'raft';
    if (/beam|tie/.test(t)) return 'groundbeam';
    if (bb) { const h = q(e, 'Geo box height'), wmax = Math.max(q(e, 'Geo box length'), q(e, 'Geo box width')); if (h > 3 * Math.max(wmax, 0.1)) return 'pile'; }
    return 'footing';
  }
  if (/framing/i.test(cat)) return /ground beam|tie beam|grade beam|\bgb\b/.test(t) || q(e, 'Area on ground') > 0.5 * Math.max(q(e, 'Geo bottom area'), 1e-9) ? 'groundbeam' : 'beam';
  if (/column/i.test(cat)) return 'column';
  if (/^floors?$|slab/i.test(cat)) {
    const bottom = q(e, 'Geo bottom area') || plan;
    if (q(e, 'Area on ground') > 0.5 * bottom) return 'groundslab';
    if (q(e, 'Top exposed') > 0.5 * (q(e, 'Geo top area') || plan)) return 'roofslab';
    return 'slab';
  }
  if (/roof/i.test(cat)) return 'roofslab';
  if (/^walls?$/i.test(cat)) return 'wall';
  if (/stair|runs|landing|ramp/i.test(cat)) return 'stair';
  return 'other';
}
export const KIND_LABEL = { pile: 'Piles', pilecap: 'Pile caps', footing: 'Footings', raft: 'Raft', groundbeam: 'Ground beams', beam: 'Beams', column: 'Columns',
  slab: 'Suspended slabs', groundslab: 'Ground slabs', roofslab: 'Roof slabs', wall: 'Walls', stair: 'Stairs and landings', other: 'Other' };
export const NRM1_OF_KIND = { pile: '1.1.2', pilecap: '1.1.1', footing: '1.1.1', raft: '1.1.1', groundbeam: '1.1.1', groundslab: '1.1.3', column: '2.1', beam: '2.1',
  slab: '2.2', roofslab: '2.3', stair: '2.4', wall: '2.7' };

// ================================================================== project QS setup (assumptions; yellow cells in Excel)
export const DEFAULT_RATES = { pile: 80, pilecap: 100, footing: 90, raft: 110, groundbeam: 130, groundslab: 60, slab: 100, roofslab: 100, beam: 160, column: 180, wall: 100, stair: 100 };
export const DEFAULT_QS = {
  ruleSet: 'NRM2',
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
  if (!RULE_SETS[s.ruleSet]) s.ruleSet = 'NRM2';
  return s;
}
/** Default ground level: the most common top level of ground-bearing slabs (model elevation). */
export function guessGroundLevel(elements) {
  const tops = elements.filter(e => kindOf(e) === 'groundslab' && e.q?.['Top level']).map(e => e.q['Top level'][0]).sort((a, b) => a - b);
  return tops.length ? tops[Math.floor(tops.length / 2)] : null;
}
/** Plain-language explanation of a rule item (for the AI and tooltips). */
export function explainRule(set, key) {
  const r = RULES[set]?.[key]; if (!r) return '';
  return `${r.ref}: ${r.title}, measured in ${r.unit}${r.confirm ? ' (to be confirmed against the RICS document)' : ''}.`;
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
  NRM2: horizontal work (slabs, beams, foundations) and vertical work (walls, columns), each split at 300 mm thick ("Thickness (geometry)"); stairs as sloping work.
  POMI: classes by element (foundations, beds, suspended slabs, beams, columns, walls, staircases), thickness stated.
- Formwork = faces of the concrete that are not in contact with other concrete or with the ground:
  "FW soffit" (undersides with nothing touching; split by propping height "FW soffit 0-3 m", "FW soffit 3-4.5 m", then 1.5 m stages, measured from the surface below; NRM2 only),
  "FW sides" (all free vertical faces), "FW narrow length" (length of edges/sides not over 500 mm high: NRM2 measures these in metres), "FW wide sides" (over 500 mm, m2),
  "FW sloping soffit", "FW sloping top" (top surfaces sloping over 15 degrees). Faces on the ground ("Area on ground") get no formwork.
  Foundation sides: formwork unless the project says "cast against earth" (yellow cell Earth = 1).
- Reinforcement: allowance = concrete volume x rate (kg/m3 by element kind, project QS setup) / 1000 tonnes, until a bar bending schedule is available.
  From a bar schedule: mass = number x length x d^2/162 kg/m (d in mm). Keep the rate as a yellow constant.
- Waterproofing: under foundations and ground slabs = "Area on ground" (flat); walls below ground = outer face area ("Outer face area") from its bottom to ground level + upturn:
  A x MAX(0, MIN(1, (GL + Upturn - bottom) / (top - bottom))); foundation sides when the project asks; roofs = "Top exposed" area (flat) + "Exposed perimeter" x roof upturn (upstands, m).
  Ground level (GL) comes from the project QS setup (or the most common top of ground slabs); if it is unknown and waterproofing below ground is asked, ASK for the ground level.
- Substructure: excavation = area on ground x (GL - bottom level); blinding = area on ground (x thickness); hardcore and DPM under ground slabs = area on ground.
- NRM1 elements: 1.1.1 standard foundations (footings, pile caps, rafts, ground beams), 1.1.2 piling, 1.1.3 lowest floor (ground slabs), 2.1 frame (columns, beams), 2.2 upper floors (slabs),
  2.3 roof (roof slabs), 2.4 stairs, 2.5 external walls, 2.7 internal walls. Element unit quantities: floor areas for floors, roof area for roofs.
- Some rule details are marked "to confirm" (written from secondary sources): say so when you use them.`;
