// Measure tab, templates (method library and discipline packs), openings deduction and model checks.
import { $, esc, App, api, status } from './core.js';
import { dimsOf, keyOf, evaluate as evaluateSpec, fmt } from './engine.js';
import { S } from './state.js';
import { selectIds, update } from './model.js';

export const evaluate = (spec) => evaluateSpec(spec, S.byId);

// ================================================================== derived quantities (openings)
const OPENING_CATS = /^(doors|windows)$/i;
const WALL_CATS = /walls?$/i;
/**
 * Doors and windows are matched to the wall they sit in (largest box overlap) and their area is added to
 * the wall as "Openings area", "Openings count" and "Openings to deduct" (only openings over the threshold,
 * default 0.5 m2, the usual rule for finishes).
 */
export function computeDerived() {
  const thr = Number(S.settings.openingThreshold ?? 0.5);
  const openings = S.E.filter(e => OPENING_CATS.test(e.cat) && e.bb);
  const walls = S.E.filter(e => WALL_CATS.test(e.cat) && e.bb);
  walls.forEach(w => { delete w.q['Openings area']; delete w.q['Openings count']; delete w.q['Openings to deduct']; });
  if (!openings.length || !walls.length) return;
  const up = { x: 0, y: 1, z: 2 }[S.data.up || 'y'];
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

// ================================================================== Measure tab
const DEFAULT_Q = /^(area|length|volume|perimeter|face area.*|count|cut length)$/i;
export function quantitiesFor(ids) {
  const m = new Map();
  for (const id of ids) {
    const e = S.byId.get(id);
    for (const [k, [v, u]] of Object.entries(e.q || {})) {
      const key = k + '|' + u;
      if (!m.has(key)) m.set(key, { name: k, unit: u, n: 0, sum: 0, source: 'property' });
      const o = m.get(key); o.n++; o.sum += v;
    }
    dimsOf(e.type).forEach((d, i) => {
      const key = 'type_dim|' + i;
      if (!m.has(key)) m.set(key, { name: `Type-name size ${i + 1}`, unit: 'm', n: 0, sum: 0, source: 'type_dim', index: i });
      const o = m.get(key); o.n++; o.sum += d;
    });
  }
  return [...m.values()].sort((a, b) => (DEFAULT_Q.test(b.name) - DEFAULT_Q.test(a.name)) || (a.name.startsWith('Geo') - b.name.startsWith('Geo')) || b.n - a.n || a.name.localeCompare(b.name));
}
export function defaultName(ids) {
  const types = new Set(ids.map(id => S.byId.get(id).type)), cats = new Set(ids.map(id => S.byId.get(id).cat));
  const lv = new Set(ids.map(id => S.byId.get(id).level));
  const base = types.size === 1 ? [...types][0] : cats.size === 1 ? [...cats][0] : 'Selected elements';
  return base + (lv.size === 1 && [...lv][0] ? ' - ' + [...lv][0] : '');
}
const BY = [['type', 'Type'], ['level', 'Level'], ['zone', 'Zone'], ['category', 'Category'], ['', 'None']];

export function renderMeasure() {
  const box = $('measureBody'); const ids = [...S.ticked];
  if (!ids.length) { box.innerHTML = '<div class="empty">Select elements in the Elements tab or in 3D (click, Ctrl+click or Box select), then choose what to measure here. Or apply a template below, or ask the AI.</div>'; return; }
  const qs = quantitiesFor(ids);
  const src = (q) => q.source === 'type_dim' ? 'type name' : q.name.startsWith('Geo') ? 'geometry' : /^Openings/.test(q.name) ? 'doors/windows' : 'Revit';
  box.innerHTML = `<div class="sum">${ids.length} element${ids.length > 1 ? 's' : ''} selected</div>
    <label class="field">Take-off group name <input type="text" id="gName" value="${esc(defaultName(ids))}"></label>
    <table class="q"><thead><tr><th></th><th>Quantity</th><th>Source</th><th style="text-align:right">Total</th></tr></thead><tbody>
    <tr><td><input type="checkbox" data-i="-1" checked aria-label="Count"></td><td>Count <code>{Count}</code></td><td class="hint">model</td><td class="v">${ids.length} nr</td></tr>
    ${qs.map((q, i) => `<tr><td><input type="checkbox" data-i="${i}" ${DEFAULT_Q.test(q.name) && q.n >= ids.length / 2 ? 'checked' : ''} aria-label="${esc(q.name)}"></td>
      <td>${esc(q.name)} <code>{${keyOf(q.name)}}</code>${q.n < ids.length ? ` <span class="hint">(${q.n} of ${ids.length})</span>` : ''}</td><td class="hint">${src(q)}</td>
      <td class="v">${q.source === 'type_dim' ? '' : fmt(q.sum, q.unit) + ' ' + esc(q.unit)}</td></tr>`).join('')}
    </tbody></table>
    <h4>Formula columns</h4>
    <div id="cfList">${S.customF.map((f, i) => `<div class="row"><code>${esc(f.label)} (${esc(f.unit)}) = ${esc(f.expr)}</code> <button data-del="${i}">Remove</button></div>`).join('') || '<div class="hint">None. Example: formwork to beams = {Geo_bottom_area} + {Geo_side_area}</div>'}</div>
    <div class="row"><input type="text" id="cfLabel" placeholder="Column name" style="flex:1;min-width:110px"><input type="text" id="cfUnit" placeholder="Unit" value="m2" style="width:56px"></div>
    <div class="row"><input type="text" id="cfExpr" placeholder="Formula, e.g. {Length} * {Unconnected_Height} * 2" style="flex:1"><button id="cfAdd">Add column</button></div>
    <div class="row"><label>Sub-totals by <select id="gBy">${BY.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label></div>
    <div class="row">
      ${S.inExcel ? '<button class="primary" id="toExcel">Add to Excel take-off</button>' : '<button class="primary" id="toList">Add to take-off list</button>'}
      ${!S.inExcel ? `<button id="csv" ${S.takeoff.length ? '' : 'disabled'}>Download take-off (${S.takeoff.length} groups)</button>` : ''}
      <button id="saveTpl" title="Save this method (quantities and formulas) to reuse on any project">Save as template</button>
    </div>
    <div id="mErr" class="hint" role="alert"></div>
    <div class="hint">Revit values are converted to metres. "Geo" values are measured exactly from the 3D faces. Formula columns are written to Excel as live formulas.</div>`;
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { S.customF.splice(+b.dataset.del, 1); renderMeasure(); });
  $('cfAdd').onclick = () => {
    const label = $('cfLabel').value.trim(), expr = $('cfExpr').value.trim(), unit = $('cfUnit').value.trim();
    if (!label || !expr) { $('mErr').textContent = 'Give the column a name and a formula.'; return; }
    S.customF.push({ label, unit, expr }); renderMeasure();
  };
  const build = () => {
    const picked = [...box.querySelectorAll('input[data-i]:checked')].map(c => +c.dataset.i);
    const all = qs.map(q => ({ key: keyOf(q.name), label: q.name, unit: q.unit, source: q.source, name: q.name, index: q.index, sum: q.source !== 'type_dim' && q.unit !== '' }));
    const used = new Set(picked.filter(i => i >= 0));
    S.customF.forEach(f => all.forEach((a, i) => { if (f.expr.includes('{' + a.key + '}')) used.add(i); }));
    const inputs = [];
    if (picked.includes(-1) || S.customF.some(f => f.expr.includes('{Count}'))) inputs.push({ key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true });
    [...used].sort((a, b) => a - b).forEach(i => inputs.push(all[i]));
    const formulas = S.customF.map((f, i) => ({ key: 'F' + (i + 1), label: f.label, unit: f.unit, expr: f.expr }));
    return { name: $('gName').value.trim() || defaultName(ids), ids, by: $('gBy').value, note: '', inputs, constants: [], formulas };
  };
  const go = async (fnc) => { try { const s = build(); evaluate(s); await fnc(s); } catch (err) { $('mErr').textContent = err.message; } };
  if (S.inExcel) $('toExcel').onclick = () => go((s) => App.addToExcel(s));
  else {
    $('toList').onclick = () => go(async (s) => { S.takeoff.push(s); App.saveTakeoff?.(s); status(`Added "${s.name}". ${S.takeoff.length} group(s) in the list.`, 'ok'); renderMeasure(); });
    $('csv') && ($('csv').onclick = downloadCsv);
  }
  $('saveTpl').onclick = () => go(async (s) => saveTemplateDialog(s));
}

function downloadCsv() {
  const lines = [];
  S.takeoff.forEach((g, gi) => {
    const { rows } = evaluate(g);
    lines.push([`G${gi + 1}`, g.name]);
    if (g.note) lines.push(['', 'Method: ' + g.note]);
    g.constants.forEach(c => lines.push(['', c.label, c.value, c.unit]));
    const cols = [...g.inputs, ...g.formulas];
    lines.push(['Revit ID', 'Category', 'Family', 'Type', 'Level', 'Mark', ...cols.map(c => `${c.label} (${c.unit})`)]);
    rows.forEach(({ e, v }) => lines.push([e.id, e.cat, e.fam, e.type, e.level, e.mark, ...cols.map(c => v[c.key] ?? '')]));
    lines.push([]);
  });
  const cell = (v) => { let t = String(v ?? ''); if (/^[=+\-@\t\r]/.test(t) && typeof v === 'string') t = "'" + t; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = lines.map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = (S.data?.fileName || 'model').replace(/\.dwfx$/i, '') + '_takeoff.csv'; a.click();
}

// ================================================================== templates
let TPL = [];
export async function renderTemplates() {
  const box = $('tplBody'); if (!box) return;
  box.innerHTML = '<div class="loading">Loading templates…</div>';
  try { TPL = (await api('GET', '/templates' + (App.currentProjectId?.() ? `?projectId=${App.currentProjectId()}` : ''))).templates; }
  catch (err) { box.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; return; }
  const groups = new Map();
  TPL.forEach((t, i) => { const k = t.builtin ? `${t.discipline} pack` : t.scope === 'project' ? 'This project' : t.scope === 'company' ? 'Company' : 'My templates'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push([t, i]); });
  box.innerHTML = `<p class="hint">A template is a saved method. Applying it finds the matching elements in this model, previews the totals and adds the group with live formulas.</p>
    <input type="search" class="input" id="tplFind" placeholder="Search templates" aria-label="Search templates">
    <div id="tplList">${[...groups].map(([g, list]) => `<div class="tpl-group">${esc(g)}</div>` + list.map(([t, i]) => `
      <div class="tpl" data-name="${esc((t.name + ' ' + (t.description || '') + ' ' + (t.discipline || '')).toLowerCase())}">
        <div class="grow"><strong>${esc(t.name)}</strong><span>${esc(t.description || '')}</span></div>
        <button class="btn small" data-ap="${i}">Apply</button>${!t.builtin ? `<button class="btn small subtle danger-text" data-td="${i}" aria-label="Delete ${esc(t.name)}">×</button>` : ''}</div>`).join('')).join('')}</div>
    <div id="tplPreview"></div>`;
  $('tplFind').oninput = (e) => { const q = e.target.value.toLowerCase(); box.querySelectorAll('.tpl').forEach(x => { x.hidden = !x.dataset.name.includes(q); }); };
  box.querySelectorAll('[data-ap]').forEach(b => b.onclick = () => applyTemplate(TPL[+b.dataset.ap]));
  box.querySelectorAll('[data-td]').forEach(b => b.onclick = async () => {
    try { await api('DELETE', `/templates/${TPL[+b.dataset.td].id}`); status('Template deleted.', 'ok'); renderTemplates(); } catch (err) { status(err.message, 'bad'); }
  });
}
export function applyTemplate(t, { useSelection = false } = {}) {
  const spec = specFromPlanGroup({ ...t.spec, filter: useSelection ? { use_ticked: true } : t.spec.filter });
  const box = $('tplPreview');
  if (!spec.ids.length) { box.innerHTML = `<div class="msg bad">No elements in this model match "${esc(t.name)}". It looks for: ${esc(JSON.stringify(t.spec.filter))}.</div>`; return; }
  let ev; try { ev = evaluate(spec); } catch (err) { box.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; return; }
  const cols = [...spec.inputs, ...spec.formulas];
  box.innerHTML = `<div class="card"><h3>${esc(spec.name)}</h3><div>${spec.ids.length} elements found</div>
    ${spec.constants.length ? spec.constants.map((c, i) => `<div class="row"><label>${esc(c.label)} <input type="text" data-c="${i}" value="${c.value}" style="width:70px"> ${esc(c.unit)}</label></div>`).join('') : ''}
    <table class="q"><tbody>${cols.map(c => `<tr><td>${esc(c.label)} <span class="hint">${esc(c.unit)}</span>${ev.missing[c.key] ? ` <span class="hint">(${ev.missing[c.key]} missing)</span>` : ''}</td><td class="v">${ev.tot[c.key] != null ? fmt(ev.tot[c.key], c.unit === 'nr' ? '' : c.unit) : ''}</td></tr>`).join('')}</tbody></table>
    <div class="row"><button id="tpShow">Show in model</button><button class="primary" id="tpAdd">${S.inExcel ? 'Add to Excel' : 'Add to list'}</button></div></div>`;
  box.querySelectorAll('input[data-c]').forEach(inp => inp.onchange = () => { spec.constants[+inp.dataset.c].value = Number(inp.value) || 0; });
  $('tpShow').onclick = () => selectIds(spec.ids);
  $('tpAdd').onclick = async () => {
    try { if (S.inExcel) await App.addToExcel(spec); else { S.takeoff.push(spec); App.saveTakeoff?.(spec); status(`Added "${spec.name}".`, 'ok'); } $('tpAdd').disabled = true; $('tpAdd').textContent = 'Added'; }
    catch (err) { status(err.message, 'bad'); }
  };
  box.scrollIntoView({ block: 'nearest' });
}
function saveTemplateDialog(spec) {
  const box = $('measureBody');
  const form = document.createElement('form'); form.className = 'card form';
  form.innerHTML = `<h3>Save as template</h3>
    <label class="field">Template name<input class="input" id="tName" value="${esc(spec.name)}" required maxlength="120"></label>
    <div class="two"><label class="field">Discipline<select class="input" id="tDisc"><option>Structure</option><option>Architecture</option><option>Interiors</option><option>MEP</option><option>Landscape</option><option>Other</option></select></label>
    <label class="field">Who can use it<select class="input" id="tScope"><option value="user">Only me</option>${App.currentProjectId?.() ? '<option value="project">This project team</option>' : ''}<option value="company">Everyone (admin only)</option></select></label></div>
    <label class="field">Elements it applies to<select class="input" id="tFilter"><option value="cat">The same categories (${esc([...new Set(spec.ids.map(id => S.byId.get(id).cat))].join(', '))})</option><option value="type">The same types</option><option value="ticked">Whatever is selected when applied</option></select></label>
    <label class="field">Description<input class="input" id="tDesc" maxlength="500" placeholder="What it measures and how"></label>
    <div class="actions"><button type="button" class="btn" id="tCancel">Cancel</button><button class="btn primary">Save template</button></div>`;
  box.prepend(form); $('tName').focus();
  $('tCancel').onclick = () => form.remove();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const els = spec.ids.map(id => S.byId.get(id));
    const filter = $('tFilter').value === 'cat' ? { category: [...new Set(els.map(x => x.cat))] } : $('tFilter').value === 'type' ? { category: [...new Set(els.map(x => x.cat))], type: [...new Set(els.map(x => x.type))] } : { use_ticked: true };
    const tspec = { name: $('tName').value, filter, by: spec.by, note: $('tDesc').value || spec.note, inputs: spec.inputs, constants: spec.constants, formulas: spec.formulas };
    try {
      await api('POST', '/templates', { name: $('tName').value, discipline: $('tDisc').value, description: $('tDesc').value, scope: $('tScope').value, projectId: App.currentProjectId?.(), spec: tspec });
      form.remove(); status('Template saved. Find it under Templates and discipline packs.', 'ok'); renderTemplates();
    } catch (err) { status(err.message, 'bad'); }
  };
}

// ================================================================== plan groups (AI and templates) to specs
export function applyFilter(f = {}) {
  if (f.use_ticked) return [...S.ticked];
  const lc = (a) => (Array.isArray(a) ? a : a ? [a] : []).map(s => String(s).toLowerCase());
  const [cat, fam, typ, inc, exc, lev] = [lc(f.category), lc(f.family), lc(f.type), lc(f.type_contains), lc(f.type_excludes), lc(f.level)];
  return S.E.filter(e => {
    const t = e.type.toLowerCase();
    return (!cat.length || cat.includes(e.cat.toLowerCase())) && (!fam.length || fam.includes(e.fam.toLowerCase())) &&
      (!typ.length || typ.includes(t)) && (!inc.length || inc.some(s => t.includes(s))) &&
      (!exc.length || !exc.some(s => t.includes(s))) && (!lev.length || lev.includes((e.level || '').toLowerCase()));
  }).map(e => e.id);
}
export function specFromPlanGroup(g) {
  const ids = applyFilter(g.filter);
  let inputs = (g.inputs || []).map(i => ({ key: keyOf(i.key || i.name || i.label), label: i.label || i.name || i.key, unit: i.unit || (i.source === 'count' ? 'nr' : 'm'),
    source: i.source || 'property', name: i.name, index: i.index, sum: i.sum ?? (i.source === 'count') }));
  if (!inputs.length && g.quantities) {
    inputs = g.quantities.map(q => /^count$/i.test(q) ? { key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true }
      : { key: keyOf(q), label: q, unit: (quantitiesFor(ids).find(x => x.name === q) || {}).unit || '', source: 'property', name: q, sum: true });
  }
  const constants = (g.constants || []).map(c => ({ key: keyOf(c.key || c.label), label: c.label || c.key, value: Number(c.value) || 0, unit: c.unit || '' }));
  const formulas = (g.formulas || []).map((f, i) => ({ key: keyOf(f.key || 'F' + (i + 1)), label: f.label || f.key, unit: f.unit || '', expr: f.expr }));
  return { name: g.name || (ids.length ? defaultName(ids) : 'Take-off group'), ids, by: g.group_by ?? g.by ?? 'type', note: g.note || '', inputs, constants, formulas,
    filter: g.filter && !g.filter.use_ticked ? g.filter : undefined };
}

// ================================================================== model checks
/** Elements that a take-off normally needs data for, but the model does not provide. */
export function missingDataReport() {
  const no3d = S.E.filter(e => !e.bb).map(e => e.id);
  const noLevel = S.E.filter(e => !e.level).map(e => e.id);
  const concrete = /structural (framing|columns|foundations)|^floors$|^walls$/i;
  const noVol = S.E.filter(e => concrete.test(e.cat) && !e.q?.Volume && !e.q?.['Geo volume']).map(e => e.id);
  const noSize = S.E.filter(e => /structural (framing|columns)/i.test(e.cat) && !dimsOf(e.type).length).map(e => e.id);
  const notSolid = S.E.filter(e => e.bb && concrete.test(e.cat) && !e.q?.['Geo volume']).map(e => e.id);
  return [
    { label: 'Elements without 3D geometry', ids: no3d, hint: 'Measurable from properties only; they cannot be picked in 3D.' },
    { label: 'Elements without a level', ids: noLevel, hint: 'They are left out of level filters and level sub-totals.' },
    { label: 'Concrete elements without any volume', ids: noVol, hint: 'Check the Revit export settings or measure them by size.' },
    { label: 'Beams and columns without a size in the type name', ids: noSize, hint: 'Formulas using type-name sizes will be empty for these.' },
    { label: 'Concrete elements that are not closed solids', ids: notSolid, hint: 'No geometry volume; use the Revit volume for these.' },
  ];
}
/** Pairs of elements whose boxes overlap heavily: possible duplicates or double counting. */
export function overlapReport(limit = 200) {
  const concrete = /structural (framing|columns|foundations)|^floors$|^walls$/i;
  const els = S.E.filter(e => e.bb && concrete.test(e.cat)).sort((a, b) => a.bb[0] - b.bb[0]);
  const vol = (b) => Math.max(b[3] - b[0], 0) * Math.max(b[4] - b[1], 0) * Math.max(b[5] - b[2], 0);
  const out = [];
  for (let i = 0; i < els.length && out.length < limit; i++) {
    const a = els[i], va = vol(a.bb);
    for (let j = i + 1; j < els.length && els[j].bb[0] <= a.bb[3]; j++) {
      const b = els[j];
      let v = 1;
      for (let k = 0; k < 3; k++) { const d = Math.min(a.bb[k + 3], b.bb[k + 3]) - Math.max(a.bb[k], b.bb[k]); if (d <= 0.005) { v = 0; break; } v *= d; }
      if (!v) continue;
      const small = Math.min(va, vol(b.bb));
      if (small > 0.001 && v / small > 0.5) out.push({ a: a.id, b: b.id, share: v / small, label: `${a.type} [${a.id}] and ${b.type} [${b.id}]`, same: a.type === b.type });
    }
  }
  return out.sort((x, y) => (y.same - x.same) || (y.share - x.share));
}

export function initMeasure() {
  App.renderMeasure = renderMeasure;
  App.computeDerived = computeDerived;
  App.specFromPlanGroup = specFromPlanGroup;
  $('tplBox').addEventListener('toggle', () => { if ($('tplBox').open) renderTemplates(); });
}
export { update };
