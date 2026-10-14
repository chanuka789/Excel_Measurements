// Canonical ledger: alternative heading orders are views, never extra measured items.
import { CATALOGUES, classify, elementKey, headingPath, referenceLabel, validateProfile, naturalCompare, pricingSignature } from './standards.js';
import { quantityBand } from './sizeBander.js';
import { measuredArea, calculateFormwork } from './formworkCalculator.js';
import { stableKey } from './stableKey.js';
const METRIC_UNITS = { mm: ['m', 0.001], m: ['m', 1], m2: ['m2', 1], 'm²': ['m2', 1], m3: ['m3', 1], 'm³': ['m3', 1], kg: ['t', 0.001], t: ['t', 1], nr: ['nr', 1] };
export function readQuantity(e, names, unit) {
  for (const name of names) {
    const raw = e.q?.[name]; if (!raw || !Number.isFinite(raw[0]) || raw[0] < 0) continue;
    const conversion = METRIC_UNITS[raw[1]];
    if (conversion?.[0] === unit) return { value: raw[0] * conversion[1], source: name };
  }
  return { value: null, source: '' };
}
const dimensions = e => ({
  thickness: readQuantity(e, ['Thickness (geometry)', 'Thickness', 'Width'], 'm').value,
  propping: readQuantity(e, ['Propping height'], 'm').value,
  width: readQuantity(e, ['Width'], 'm').value,
  height: readQuantity(e, ['Height'], 'm').value,
  diameter: readQuantity(e, ['Nominal Diameter', 'Diameter'], 'm').value,
});
const literal = v => typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
export function specificationKey(e) {
  return pricingSignature(e);
}

export function buildLedger(elements, profile, { context = {}, allocations = {} } = {}) {
  validateProfile(profile);
  const records = [], review = [];
  const add = (e, classification, stream, unit, quantity, source, issues = [], provisional = false, ref = '') => {
    const dims = dimensions(e), cls = { ...classification };
    if (stream.startsWith('formwork')) cls.POMI = 'C4';
    if (stream === 'rebar-estimate' || stream === 'rebar') cls.POMI = 'C3';
    const problems = [...classification.issues, ...issues];
    if ((e.qsEstimatedQuantities || []).includes(source)) problems.push('Geometry fallback estimate: verify dimensions and actual formed interfaces.');
    if (quantity == null) problems.push(`Missing ${stream} quantity in ${unit}.`);
    if (!cls.POMI || !cls.NRM1 || !cls.NRM2) problems.push('Classification incomplete: choose the missing allocation.');
    if (provisional) problems.push('Provisional quantity: confirm assumptions.');
    // Rule completeness is not inferred from a model quantity. All generated items are reviewable drafts.
    const record = { elementId: e.id, elementKey: elementKey(e, context), revisionId: context.versionId || '', stream, unit, quantity, physicalQuantity: quantity,
      source, basis: profile.basis, classification: cls, dims, band: quantityBand(stream === 'formwork-soffit' ? 'soffit' : stream, profile.basis, dims),
      type: e.type || '', family: e.fam || '', level: e.level || '', mark: e.mark || '', specification: specificationKey(e),
      ref, provisional, issues: [...new Set(problems)], status: 'draft', reviewed: false };
    records.push(record);
    review.push(...record.issues.map(message => ({ elementId: e.id, stream, message })));
    return record;
  };
  for (const e of elements) {
    const cls = classify(e), override = allocations[elementKey(e, context)];
    if (override) { for (const s of ['POMI', 'NRM1', 'NRM2']) if (override[s]) cls[s] = override[s]; cls.issues = cls.issues.filter(i => !/allocation|function|automatic rule/.test(i)); }
    const get = (names, unit) => readQuantity(e, names, unit);
    const family = cls.family;
    let q, unit, stream;
    if (family === 'count') { q = { value: 1, source: 'Model instance count' }; unit = 'nr'; stream = 'count'; }
    else if (family === 'concrete' || family === 'volume') { q = get(['Net volume', 'Geo volume', 'Volume'], 'm3'); unit = 'm3'; stream = family; }
    else if (family === 'area') { q = get(['Area', 'Geo plan area', 'Geo surface area'], 'm2'); unit = 'm2'; stream = 'area'; }
    else if (family === 'length') { q = get(['Length', 'Cut Length'], 'm'); unit = 'm'; stream = 'length'; }
    else if (family === 'rebar' || family === 'steel') { q = get(['Weight', 'Mass', 'Net weight'], 't'); unit = 't'; stream = family; }
    else if (family === 'duct') {
      const length = get(['Length'], 'm'), width = get(['Width'], 'm'), height = get(['Height'], 'm');
      q = { value: [length.value, width.value, height.value].every(v => v != null) ? 2 * (width.value + height.value) * length.value : null, source: 'Straight rectangular duct: 2(W+H)L' };
      unit = 'm2'; stream = 'duct';
    }
    if (q) add(e, cls, stream, unit, q.value, q.source, profile.basis === 'NRM1' ? ['Model component quantity is supporting detail, not an NRM 1 element unit quantity.'] : ['Check rule inclusions, deductions and assembly scope.'], false);
    if (family !== 'concrete' || cls.NRM2 !== '11') continue;
    if (profile.formwork) {
      const options = [['formwork-soffit', ['FW soffit'], 'm2', '16'], ['formwork-sloping-soffit', ['FW sloping soffit'], 'm2', '18'],
        ['formwork-sides', ['FW sides'], 'm2', ''], ['formwork-edges', ['FW narrow length'], 'm', '15'], ['formwork-wide-sides', ['FW wide sides'], 'm2', '']];
      let any = false;
      for (const [fw, names, u, item] of options) {
        const f = get(names, u); if (f.value == null) continue;
        if (profile.formworkFallback && (e.qsEstimatedQuantities || []).includes(f.source)) continue;
        // Aggregate FW sides includes narrow/wide side streams in processed geometry: do not also export those areas.
        if (fw === 'formwork-sides' && (e.q?.['FW narrow length'] || e.q?.['FW wide sides'])) continue;
        any = true;
        const adjusted = u === 'm2' ? measuredArea(f.value, e.formworkOpenings?.[fw], profile.basis, 'formwork') : { quantity: f.value, issues: [] };
        add(e, cls, fw, u, adjusted.quantity, f.source, [...adjusted.issues, 'Confirm face role and shared interfaces; opening reveals/extra-over may already be included.'], false,
          profile.basis === 'NRM2' && item ? `NRM 2 WS11 / item ${fw === 'formwork-edges' && /foundation/.test(String(e.cat).toLowerCase()) ? '14' : item}` : `${profile.basis} / face allocation to review`);
      }
      if (!any && profile.formworkFallback) {
        const cat = String(e.cat).toLowerCase(), d = dimensions(e), length = get(['Length', 'Cut Length'], 'm').value, depth = get(['Depth'], 'm').value;
        const kind = /foundation/.test(cat) ? 'footing' : /column/.test(cat) ? d.diameter != null ? 'circular-column' : 'column' : /framing/.test(cat) ? 'beam' : /wall/.test(cat) ? 'wall' : 'slab';
        const formed = calculateFormwork({ kind, length, width: d.width, depth: kind === 'slab' || kind === 'wall' ? d.thickness : kind === 'footing' ? length : depth,
          height: kind === 'footing' ? get(['Depth', 'Height', 'Thickness'], 'm').value : d.height, diameter: d.diameter });
        const foundationHeight = kind === 'footing' ? get(['Depth', 'Height', 'Thickness'], 'm').value : null;
        const narrowFoundation = kind === 'footing' && profile.basis === 'NRM2' && foundationHeight != null && foundationHeight <= 0.5;
        add(e, cls, kind === 'slab' ? 'formwork-soffit' : 'formwork-sides', narrowFoundation ? 'm' : 'm2', narrowFoundation ? formed.edgeLength : formed.area, 'Simple-shape dimension formula', formed.issues, true);
        if (kind === 'slab' && formed.edgeLength != null) {
          const wide = profile.basis === 'NRM2' && d.thickness > 0.5;
          add(e, cls, 'formwork-edges', wide ? 'm2' : 'm', wide ? formed.edgeLength * d.thickness : formed.edgeLength, 'Rectangular perimeter; depth stated', ['Confirm exposed boundaries and standard unit.'], true);
        }
        any = true;
      }
      if (!any) add(e, cls, 'formwork', 'm2', null, '', ['No processed formed-face quantities available. Use reviewed dimensions or a manual take-off.']);
    }
    if (profile.rebar) {
      if (e.q?.['Reinforcement weight']) { const r = get(['Reinforcement weight'], 't'); add(e, cls, 'rebar', 't', r.value, r.source, ['Confirm modeled reinforcement scope and host allocation.']); }
      else {
        const r = add(e, cls, 'rebar-estimate', 't', q?.value == null ? null : q.value * profile.ratio / 1000, `Concrete × ${profile.ratio} kg/m³ ÷ 1000`, [], true, 'Office provisional ratio; not a standard-specified ratio');
        r.baseQuantity = q?.value; r.ratio = profile.ratio;
      }
    }
  }
  return { records, review };
}

export function groupLedger(records, profile) {
  validateProfile(profile); const groups = new Map();
  for (const r of records) {
    // Presentation order excluded from identity. Rates survive heading changes; specification changes create a new ID.
    const key = stableKey(JSON.stringify([r.basis, r.stream, r.classification.POMI, r.classification.NRM1, r.classification.NRM2, r.type, r.family, r.unit, r.dims, r.specification, r.provisional]));
    if (!groups.has(key)) groups.set(key, { ...r, key, members: [], links: [], quantity: 0, missing: 0, issues: [] });
    const g = groups.get(key); g.members.push(r.elementId); g.links.push(r.elementKey);
    if (r.quantity == null) g.missing++; else g.quantity += r.quantity;
    g.issues.push(...r.issues);
  }
  return [...groups.values()].map(g => ({ ...g, quantity: g.missing ? null : g.quantity, issues: [...new Set(g.issues)], path: headingPath(g.classification, profile) }))
    .sort((a, b) => naturalCompare(a.path.map(n => `${n.standard}:${n.code}`).join('/'), b.path.map(n => `${n.standard}:${n.code}`).join('/')) || (a.dims.thickness ?? Infinity) - (b.dims.thickness ?? Infinity) || naturalCompare(a.type, b.type) || naturalCompare(a.key, b.key));
}

export function boqLayout(groups, profile, { keep = new Map(), quantities = new Map() } = {}) {
  const name = profile.purpose === 'costplan' ? 'Smart Cost Plan' : 'Smart BOQ';
  const rows = [[name.toUpperCase() + ' — DRAFT'], [`Quantity basis: ${profile.basis}; headings: ${[profile.primary, profile.secondary, profile.tertiary].filter(Boolean).join(' → ')}. QS review required.`], [],
    ['Stable item key', 'Item / standard reference', 'Description', 'Unit', 'Quantity', 'Rate', 'Amount', 'Review', 'NRM 1 allocation']];
  const kinds = ['title', 'note', 'blank', 'head'], inputs = [], amounts = []; let previous = [];
  groups.forEach((g, index) => {
    const path = g.path.map(n => `${referenceLabel(n)} ${n.name}`);
    let same = 0; while (same < path.length && same < previous.length && path[same] === previous[same]) same++;
    path.slice(same).forEach(h => { rows.push(['', h]); kinds.push('section'); }); previous = path;
    const r = rows.length + 1, linked = quantities.get(g.key);
    const dimensionsText = g.dims.width != null && g.dims.height != null ? `; ${Math.round(g.dims.width * 1000)} × ${Math.round(g.dims.height * 1000)} mm` : g.dims.diameter != null ? `; diameter ${g.dims.diameter * 1000} mm` : '';
    rows.push([g.key, String(index + 1), literal(`${g.type || g.family || 'Selected item'}${dimensionsText}; ${g.stream}${g.band ? '; ' + g.band : ''}${g.provisional ? '; provisional allowance' : ''}`), g.unit,
      linked ? `=${linked}` : g.quantity ?? '', keep.get(g.key) ?? '', `=IF(OR(E${r}="",F${r}=""),"",E${r}*F${r})`, [...g.issues, 'Draft: detailed rule/assembly review required.'].join(' '), g.classification.NRM1 || 'UNASSIGNED']);
    kinds.push('item'); inputs.push([r, 5]); amounts.push(`G${r}`);
  });
  rows.push(['', '', 'TOTAL', '', '', '', amounts.length ? `=SUM(G5:G${rows.length})` : 0]); kinds.push('total');
  return { name, rows, kinds, headRow: 4, hidden: [0, 8], inputs, keepCol: 5, widths: [50, 180, 310, 45, 85, 75, 95, 250, 60], numFmt: (r, c) => kinds[r] === 'item' && c >= 4 && c <= 6 ? '#,##0.000' : null };
}

/** Batched source ledger: repeat export replaces this sheet rather than appending duplicate take-offs. */
export function takeoffLayout(records, groups) {
  const rowKeys = new Map(); groups.forEach(g => g.links.forEach(link => rowKeys.set(`${link}\0${g.stream}`, g.key)));
  const rows = [['SMART TAKE-OFF — DRAFT'], ['Source-backed rows. Reinforcement ratios are editable assumptions. Re-export to reconcile a model/rule revision.'], [],
    ['Item key', 'Element key', 'Element ID', 'Stream', 'Unit', 'Source', 'Source quantity', 'Ratio kg/m³', 'Measured quantity', 'Review', 'Basis', 'NRM 1']];
  const kinds = ['title', 'note', 'blank', 'head'], inputs = [];
  for (const record of records) {
    const r = rows.length + 1, estimate = record.stream === 'rebar-estimate';
    rows.push([rowKeys.get(`${record.elementKey}\0${record.stream}`), record.elementKey, record.elementId, record.stream, record.unit, literal(record.source),
      estimate ? record.baseQuantity ?? '' : record.quantity ?? '', estimate ? record.ratio : '',
      estimate ? `=IF(OR(G${r}="",H${r}=""),"",G${r}*H${r}/1000)` : `=IF(G${r}="","",G${r})`, record.issues.join(' '), record.basis, record.classification.NRM1 || 'UNASSIGNED']);
    kinds.push('item'); if (estimate) inputs.push([r, 7]);
  }
  return { name: 'Smart Take-off', rows, kinds, headRow: 4, inputs, hidden: [0, 1], widths: [60, 60, 80, 140, 45, 210, 95, 95, 100, 250, 60, 80], numFmt: (r, c) => kinds[r] === 'item' && c >= 6 && c <= 8 ? '#,##0.000' : null };
}
export function basisLayout(profile, context, review) {
  const fields = [['Output purpose', profile.purpose], ['Primary headings', profile.primary], ['Secondary headings', profile.secondary], ['Tertiary headings', profile.tertiary],
    ['Quantity basis', profile.basis], ['Source editions', 'POMI 1979 linked reprint; NRM 1 third edition 2021; NRM 2 second edition 2021'], ['Project', context.projectId || ''], ['Model revision', context.versionId || ''],
    ['Project amendments', profile.amendments || 'None declared'], ['Status', 'DRAFT — QS measurement/assembly review required'], ['Review messages', review.length], ['Provisional ratio kg/m³', profile.rebar ? profile.ratio : 'Not used']];
  return { name: 'Smart Basis', rows: [['BASIS & SCOPE'], ['Heading changes do not recalculate quantities. Measurement basis changes require reconciliation.'], [], ['Setting', 'Value'], ...fields].map(r => r.map(literal)), kinds: ['title', 'note', 'blank', 'head', ...fields.map(() => 'item')], headRow: 4, widths: [200, 440] };
}

/** Costs aggregate, unlike incompatible element quantities. Explicit allowances cover non-modeled groups 0–14. */
export function elementalLayout({ source = 'Smart Cost Plan', keep = new Map() } = {}) {
  const sh = "'" + source.replace(/'/g, "''") + "'", rows = [['NRM 1 ELEMENTAL COST SUMMARY — DRAFT'], ['Component costs plus declared allowances; this is not an automatic element unit-rate measurement. Review scope and assumptions.'], [],
    ['Code', 'Element', 'Linked component cost', 'Other allowance', 'Total cost']];
  const kinds = ['title', 'note', 'blank', 'head'], inputs = [], groupTotals = [];
  for (const group of CATALOGUES.NRM1.sections.filter(n => n.level === 1)) {
    rows.push([group.code, group.name]); kinds.push('group'); const first = rows.length + 1;
    for (const element of CATALOGUES.NRM1.sections.filter(n => n.parent === group.code)) {
      const r = rows.length + 1;
      rows.push([element.code, element.name, `=SUMIFS(${sh}!$G:$G,${sh}!$I:$I,"=${element.code}")+SUMIFS(${sh}!$G:$G,${sh}!$I:$I,"${element.code}.*")`, keep.get(element.code) ?? '', `=SUM(C${r}:D${r})`]); kinds.push('item'); inputs.push([r, 3]);
    }
    const r = rows.length + 1; rows.push(['', `Total ${group.code}`, '', '', `=SUM(E${first}:E${r - 1})`]); kinds.push('subtotal'); groupTotals.push(`E${r}`);
  }
  const ur = rows.length + 1; rows.push(['UNASSIGNED', 'Unallocated component cost — resolve before final issue', `=SUMIF(${sh}!$I:$I,"UNASSIGNED",${sh}!$G:$G)`, '', `=C${ur}`]); kinds.push('item'); groupTotals.push(`E${ur}`);
  rows.push(['', 'TOTAL PROJECT COST', '', '', '=' + groupTotals.join('+')]); kinds.push('total');
  return { name: 'Smart Elemental', rows, kinds, headRow: 4, inputs, widths: [65, 330, 120, 120, 120], numFmt: (r, c) => c >= 2 && kinds[r] === 'item' ? '#,##0.00' : null };
}
