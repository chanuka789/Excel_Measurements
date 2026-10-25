import { $, esc, App, api, session, status } from './core.js';
import { S } from './state.js';
import { selectIds } from './model.js';
import { CATALOGUES, DEFAULT_PROFILE, PRESETS, classify, elementKey, lookup, validateProfile, referenceLabel } from './standards.js';
import { parameterColumns, buildSchedule, csvText } from './scheduleExporter.js';
import { buildLedger, groupLedger, boqLayout, basisLayout, elementalLayout, takeoffLayout } from './standardsBOQ.js';
import { writeLayout, safeText, forgetSmartLinks } from './excel.js';

let step = 1, profile = { ...DEFAULT_PROFILE }, selectedColumns = new Set(['type', 'mark', 'count']), mode = 'grouped', allocations = {}, templateList = [], busy = false;
let filter = { discipline: '', category: '', level: '', zone: '' }, loadedContext = '';
const context = () => ({ projectId: App.currentProjectId?.() || '', versionId: S.versionId || '', modelId: S.versionId || S.label || 'quick-open' });
const storageKey = () => `dwfxSmart:${session.get()?.user?.id || 'user'}:${JSON.stringify(context())}`;
function loadState() {
  const key = storageKey(); if (loadedContext === key) return; loadedContext = key;
  profile = { ...DEFAULT_PROFILE }; allocations = {}; filter = { discipline: '', category: '', level: '', zone: '' }; step = 1;
  try { const data = JSON.parse(localStorage.getItem(key) || 'null'); if (data) { validateProfile(data.profile); profile = data.profile;
    allocations = Object.fromEntries(Object.entries(data.allocations || {}).filter(([, values]) => Object.entries(values).every(([std, code]) => lookup(std, code)))); } } catch { /* corrupt or blocked local storage */ }
}
function saveState() { try { localStorage.setItem(storageKey(), JSON.stringify({ profile, allocations })); } catch { /* storage blocked */ } }
const selected = () => [...S.ticked].map(id => S.byId.get(id)).filter(Boolean);
function matching() { return S.E.filter(e => (!filter.discipline || classify(e).discipline === filter.discipline) && (!filter.category || e.cat === filter.category) && (!filter.level || e.level === filter.level) && (!filter.zone || S.zoneOf.get(e.id) === filter.zone)); }
const option = (value, label, chosen) => `<option value="${esc(value)}" ${value === chosen ? 'selected' : ''}>${esc(label)}</option>`;
const stdOptions = (chosen, none = false) => (none ? option('', 'None', chosen) : '') + ['POMI', 'NRM1', 'NRM2'].map(id => option(id, id === 'NRM1' ? 'NRM 1 — elemental' : id === 'NRM2' ? 'NRM 2 — work sections' : 'POMI', chosen)).join('');
const wrapped = async (button, run) => {
  if (busy) return; busy = true; button.disabled = true;
  try { await run(); } catch (err) { status(err.message, 'bad'); const error = $('smartError'); if (error) { error.hidden = false; error.textContent = err.message; } }
  finally { busy = false; button.disabled = false; }
};
function download(rows, name) {
  const url = URL.createObjectURL(new Blob([csvText(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
}
const textLayout = (name, title, headers, rows) => ({ name, rows: [[title], [], [], headers, ...rows].map(r => r.map(safeText)), kinds: ['title', 'blank', 'blank', 'head', ...rows.map(() => 'item')], headRow: 4, widths: headers.map(() => 120) });
function ledger() { return buildLedger(selected(), profile, { context: context(), allocations }); }

export function renderSmart() {
  const host = $('smartBody'); if (!host) return; loadState();
  if (!S.data) { host.innerHTML = '<div class="empty">Open a model in Project &amp; Models to start Smart Takeoff.</div>'; return; }
  const els = selected();
  host.innerHTML = `<div class="smart-header"><h2>Smart Takeoff</h2><p class="muted">Select, auto-classify and export with a clear measurement basis.</p></div>
    <nav class="smart-steps" aria-label="Takeoff steps">${['Filter & Select', 'Classify & Review', 'Export / Link'].map((t, i) => `<button data-step="${i + 1}" ${step === i + 1 ? 'aria-current="step"' : ''}>${i + 1}. ${t}</button>`).join('')}</nav>
    <div class="smart-selection"><strong>${els.length}</strong> selected · ${S.E.length} model elements <button class="link" id="smartBrowse">Browse / view selection</button></div>
    <div id="smartStep"></div><div id="smartError" class="msg bad" role="alert" hidden></div>
    <div class="smart-footer"><button id="smartBack" ${step === 1 ? 'disabled' : ''}>Back</button><button class="primary" id="smartNext" ${step === 3 ? 'hidden' : ''}>${step === 1 ? 'Classify & Review' : 'Export / Link'}</button></div>`;
  host.querySelectorAll('[data-step]').forEach(b => b.onclick = () => { if (+b.dataset.step > 1 && !els.length) return status('Select elements first.', 'bad'); step = +b.dataset.step; renderSmart(); });
  $('smartBrowse').onclick = () => App.selectTab('elements');
  $('smartBack').onclick = () => { step--; renderSmart(); };
  $('smartNext').onclick = () => { if (!els.length) return status('Select elements first.', 'bad'); step++; renderSmart(); };
  if (step === 1) renderSelection(); else if (step === 2) renderReview(); else renderOutput();
}
function renderSelection() {
  const categories = [...new Set(S.E.map(e => e.cat).filter(Boolean))].sort(), levels = [...new Set(S.E.map(e => e.level).filter(Boolean))].sort(), zones = [...new Set(S.zoneOf.values())].sort();
  $('smartStep').innerHTML = `<div class="smart-grid">
    <label class="field">Discipline<select id="smartDiscipline">${option('', 'All disciplines', filter.discipline)}${['Structure', 'Architecture', 'Interiors', 'MEP', 'Landscape', 'Other'].map(x => option(x, x, filter.discipline)).join('')}</select></label>
    <label class="field">Category<select id="smartCategory">${option('', 'All categories', filter.category)}${categories.map(x => option(x, x, filter.category)).join('')}</select></label>
    <label class="field">Level<select id="smartLevel">${option('', 'All levels', filter.level)}${levels.map(x => option(x, x, filter.level)).join('')}</select></label>
    <label class="field">Zone<select id="smartZone">${option('', 'All zones', filter.zone)}${zones.map(x => option(x, x, filter.zone)).join('')}</select></label></div>
    <div class="row"><button class="primary" id="smartSelect">Select matches (${matching().length})</button><button id="smartClear">Clear selection</button></div>
    <p class="hint">Repeat selections to combine categories, or use the viewer's box selection. Select matches replaces the selection; Add matches keeps it.</p><button id="smartAddMatches">Add matches</button>`;
  for (const [id, key] of [['smartDiscipline', 'discipline'], ['smartCategory', 'category'], ['smartLevel', 'level'], ['smartZone', 'zone']]) $(id).onchange = e => { filter[key] = e.target.value; renderSelection(); };
  $('smartSelect').onclick = () => selectIds(matching().map(e => e.id), { fit: false });
  $('smartAddMatches').onclick = () => selectIds([...new Set([...S.ticked, ...matching().map(e => e.id)])], { fit: false });
  $('smartClear').onclick = () => selectIds([], { fit: false });
}
function renderReview() {
  const { records, review } = ledger(), groups = groupLedger(records, profile);
  $('smartStep').innerHTML = `<label class="field">Workflow preset<select id="smartPreset"><option value="">Custom settings</option>${[['detailed', 'Detailed NRM 2 BOQ'], ['international', 'POMI BOQ'], ['elementalBoq', 'Elemental BOQ / NRM 2 basis'], ['pomiDetailed', 'POMI headings / NRM 2 basis'], ['costPlan', 'NRM 1 cost-plan supporting detail']].map(([v, t]) => option(v, t, '')).join('')}</select></label>
    <div class="smart-grid"><label class="field">Output purpose<select id="smartPurpose">${[['boq', 'Detailed BOQ'], ['costplan', 'Cost-plan supporting detail'], ['schedule', 'Custom schedule']].map(([v, t]) => option(v, t, profile.purpose)).join('')}</select></label>
    <label class="field">Quantity measurement basis<select id="smartBasis">${stdOptions(profile.basis)}</select></label>
    <label class="field">Primary headings<select id="smartPrimary">${stdOptions(profile.primary)}</select></label><label class="field">Secondary classification<select id="smartSecondary">${stdOptions(profile.secondary, true)}</select></label></div>
    <details class="box"><summary>Advanced heading order & amendments</summary><label class="field">Third classification<select id="smartTertiary">${stdOptions(profile.tertiary, true)}</select></label><label class="field">Declared project amendments<textarea id="smartAmendments" maxlength="2000">${esc(profile.amendments)}</textarea></label><p class="hint">All nine heading pairs and six non-repeating three-standard orders are supported. Repeated standards collapse to their native hierarchy. Headings do not change quantities.</p></details>
    <div class="smart-checks"><label><input id="smartFormwork" type="checkbox" ${profile.formwork ? 'checked' : ''}> Processed formwork quantities</label><label><input id="smartFormworkFallback" type="checkbox" ${profile.formworkFallback ? 'checked' : ''}> Allow provisional simple-shape formwork (explicit dimensions only)</label><label><input id="smartRebar" type="checkbox" ${profile.rebar ? 'checked' : ''}> Reinforcement allowance</label><label>Ratio kg/m³ <input id="smartRatio" type="number" min="0" max="1000" step="any" value="${profile.ratio}"></label></div>
    <div class="msg">Draft preview · ${groups.length} items · ${review.length} review messages. Full standard compliance is not inferred from BIM properties.</div>
    <div class="smart-table-wrap"><table class="tbl"><thead><tr><th>Type / stream</th><th>References</th><th>Quantity</th><th>Review</th></tr></thead><tbody>${groups.slice(0, 100).map((g, i) => `<tr><td><button class="link" data-smart-show="${i}">${esc(g.type)}<br>${esc(g.stream)}</button></td><td>${g.path.map(n => esc(referenceLabel(n))).join('<br>')}</td><td>${g.quantity == null ? 'Missing' : g.quantity.toFixed(3)} ${esc(g.unit)}</td><td>${esc(g.issues.join(' '))}</td></tr>`).join('')}</tbody></table></div>
    ${groups.length > 100 ? '<p class="hint">Preview shows 100 items. Exports include all selected items.</p>' : ''}
    <details class="box"><summary>Manual QS allocation for current selection</summary><p class="hint">Apply only when every selected element has the same function. Selection previews can highlight a group before allocation.</p>${['POMI', 'NRM1', 'NRM2'].map(std => `<label class="field">${std}<select id="allocate${std}"><option value="">Keep automatic allocation</option>${[...CATALOGUES[std].sections, ...(CATALOGUES[std].topics || [])].map(n => option(n.code, `${n.code} ${n.name}`, '')).join('')}</select></label>`).join('')}<button id="smartAllocate">Apply allocation to selection</button></details>`;
  const change = (key, value) => { const next = { ...profile, [key]: value }; try { validateProfile(next); profile = next; saveState(); renderSmart(); } catch (e) { status(e.message, 'bad'); renderSmart(); } };
  $('smartPreset').onchange = e => { if (PRESETS[e.target.value]) { profile = { ...PRESETS[e.target.value] }; saveState(); renderSmart(); } };
  for (const [id, key] of [['smartPurpose', 'purpose'], ['smartBasis', 'basis'], ['smartPrimary', 'primary'], ['smartSecondary', 'secondary'], ['smartTertiary', 'tertiary'], ['smartAmendments', 'amendments']]) $(id).onchange = e => change(key, e.target.value);
  $('smartFormwork').onchange = e => change('formwork', e.target.checked); $('smartRebar').onchange = e => change('rebar', e.target.checked); $('smartRatio').onchange = e => change('ratio', e.target.value === '' ? NaN : Number(e.target.value));
  $('smartFormworkFallback').onchange = e => change('formworkFallback', e.target.checked);
  $('smartBasis').querySelector('option[value=NRM1]').disabled = profile.purpose === 'boq';
  $('smartStep').querySelectorAll('[data-smart-show]').forEach(b => b.onclick = () => { const ids = groups[+b.dataset.smartShow].members; selectIds(ids); App.selectTab('elements'); });
  $('smartAllocate').onclick = () => { for (const e of selected()) { const key = elementKey(e, context()); allocations[key] = { ...allocations[key] }; for (const std of ['POMI', 'NRM1', 'NRM2']) if ($('allocate' + std).value) allocations[key][std] = $('allocate' + std).value; } saveState(); renderSmart(); };
}

function renderOutput() {
  const els = selected(), cols = parameterColumns(els), picked = () => cols.filter(c => selectedColumns.has(c.key));
  $('smartStep').innerHTML = `<h3>Custom schedule</h3><p class="hint">Choose columns. Numeric dimensions stay descriptive; compatible quantities are summed. Missing values remain missing.</p>
    <div class="row"><label>Rows <select id="smartMode">${option('itemized', 'Itemized', mode)}${option('grouped', 'Grouped by type/mark + selected specifications', mode)}</select></label></div>
    <div class="smart-columns">${cols.map(c => `<label><input type="checkbox" data-smart-col="${esc(c.key)}" ${selectedColumns.has(c.key) ? 'checked' : ''}> ${esc(c.label)} ${esc(c.unit)} <span class="hint">${c.available}/${els.length}</span></label>`).join('')}</div>
    <label class="field">Schedule preset name<input id="smartTemplateName" maxlength="120" placeholder="Standard Door Schedule"></label><div class="row"><button id="smartSaveTemplate">Save preset</button><button id="smartLoadTemplates">Load presets</button></div><div id="smartTemplateList"></div>
    <div class="row"><button id="smartScheduleCsv">Download schedule CSV</button><button id="smartScheduleExcel" ${S.inExcel ? '' : 'disabled'}>Schedule to Excel</button><button id="smartActiveCell" ${S.inExcel ? '' : 'disabled'}>Link to active Excel cell</button></div>
    <h3>BOQ / cost-plan supporting detail</h3><p class="hint">Export includes basis, review queue and a one-to-many link registry. All outputs are drafts pending QS validation. Heading changes preserve item keys; quantity-basis changes create different items.</p>
    <div class="row"><button id="smartBoqCsv">Download draft BOQ CSV</button><button class="primary" id="smartBoqExcel" ${S.inExcel ? '' : 'disabled'}>Export draft workbook</button></div>
    <div id="smartExportStatus" role="status" aria-live="polite"></div>`;
  $('smartMode').onchange = e => { mode = e.target.value; };
  $('smartStep').querySelectorAll('[data-smart-col]').forEach(c => c.onchange = () => c.checked ? selectedColumns.add(c.dataset.smartCol) : selectedColumns.delete(c.dataset.smartCol));
  const schedule = () => buildSchedule(selected(), picked(), { mode, zoneOf: S.zoneOf, context: context() });
  const headers = () => picked().map(c => `${c.label}${c.unit ? ` (${c.unit})` : ''}`);
  $('smartScheduleCsv').onclick = e => wrapped(e.target, async () => { const rows = schedule(); download([headers(), ...rows.map(r => r.values)], 'model_schedule.csv'); });
  $('smartScheduleExcel').onclick = e => wrapped(e.target, async () => {
    const rows = schedule(); await writeLayout(textLayout('Smart Schedule', `MODEL SCHEDULE — ${mode}`, headers(), rows.map(r => r.values)));
    await writeLinks(rows.map((r, i) => ({ key: `schedule-row-${i + 5}`, links: r.links, ids: r.ids, sheet: 'Smart Schedule', row: i + 5 })), 'Smart Schedule'); status('Schedule and link registry exported.', 'ok');
  });
  $('smartActiveCell').onclick = e => wrapped(e.target, async () => {
    const rows = schedule(), values = [headers(), ...rows.map(r => r.values)].map(r => r.map(safeText));
    let sheetName, firstRow;
    await Excel.run(async ctx => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet(); sheet.load('name');
      const cell = ctx.workbook.getActiveCell(); cell.load('rowIndex'); const range = cell.getResizedRange(values.length - 1, values[0].length - 1); range.load('values'); await ctx.sync();
      if (sheet.name === 'Smart Links') throw new Error('Choose a visible worksheet for the schedule.');
      if (range.values.some(r => r.some(v => v !== '' && v != null))) throw new Error('The target range contains data. Choose an empty destination.');
      sheetName = sheet.name; firstRow = cell.rowIndex + 2; range.values = values; await ctx.sync();
    });
    await writeLinks(rows.map((r, i) => ({ key: `active-row-${firstRow + i}`, links: r.links, ids: r.ids, sheet: sheetName, row: firstRow + i })), `${sheetName}:${firstRow}`); status('Schedule written at the active cell; links recorded.', 'ok');
  });
  $('smartBoqCsv').onclick = e => wrapped(e.target, async () => {
    const { records } = ledger(), groups = groupLedger(records, profile);
    download([['Heading path', 'Description', 'Unit', 'Qty', 'Measurement basis', 'Review'], ...groups.map(g => [g.path.map(referenceLabel).join(' / '), `${g.type}; ${g.stream}`, g.unit, g.quantity, g.basis, g.issues.join(' ')])], 'draft_boq.csv');
  });
  $('smartBoqExcel').onclick = e => wrapped(e.target, exportWorkbook);
  $('smartSaveTemplate').onclick = e => wrapped(e.target, async () => {
    const name = $('smartTemplateName').value.trim(); if (!name) throw new Error('Enter a preset name.');
    await api('POST', '/templates', { name, discipline: 'Schedule', description: 'Smart Takeoff schedule and standards preset', scope: 'user',
      spec: { kind: 'smart-schedule', inputs: [], profile, columns: [...selectedColumns], mode } }); status('Preset saved to your template library.', 'ok');
  });
  $('smartLoadTemplates').onclick = e => wrapped(e.target, async () => {
    const pid = App.currentProjectId?.(); templateList = (await api('GET', '/templates' + (pid ? `?projectId=${pid}` : ''))).templates.filter(t => t.spec?.kind === 'smart-schedule');
    $('smartTemplateList').innerHTML = templateList.map((t, i) => `<button data-smart-template="${i}">${esc(t.name)}</button>`).join('') || '<p class="hint">No saved schedule presets yet.</p>';
    $('smartTemplateList').querySelectorAll('[data-smart-template]').forEach(b => b.onclick = () => { const s = templateList[+b.dataset.smartTemplate].spec; validateProfile(s.profile); profile = { ...s.profile }; selectedColumns = new Set(s.columns); mode = s.mode; saveState(); renderSmart(); });
  });
}

async function writeLinks(groups, scope) {
  let previous = [];
  await Excel.run(async ctx => { const sh = ctx.workbook.worksheets.getItemOrNullObject('Smart Links'); await ctx.sync(); if (sh.isNullObject) return;
    const used = sh.getUsedRangeOrNullObject(true); used.load('values'); await ctx.sync(); if (!used.isNullObject) previous = used.values.slice(4).filter(r => r[6] !== scope); });
  const rows = [...previous, ...groups.flatMap(g => g.links.map((link, i) => [g.key, link, g.ids?.[i] ?? g.members?.[i] ?? '', context().versionId, g.sheet || '', g.row || '', scope]))];
  await writeLayout(textLayout('Smart Links', 'MODEL LINK REGISTRY', ['Row key', 'Element key', 'Element ID', 'Revision', 'Worksheet', 'Excel row', 'Scope'], rows), { activate: false });
  await Excel.run(async ctx => { ctx.workbook.worksheets.getItem('Smart Links').visibility = Excel.SheetVisibility.hidden; await ctx.sync(); });
  forgetSmartLinks();
}
async function exportWorkbook() {
  const { records, review } = ledger(), groups = groupLedger(records, profile), keep = new Map(), quantities = new Map();
  const name = profile.purpose === 'costplan' ? 'Smart Cost Plan' : 'Smart BOQ';
  await Excel.run(async ctx => {
    const sheet = ctx.workbook.worksheets.getItemOrNullObject(name); await ctx.sync(); if (sheet.isNullObject) return;
    const used = sheet.getUsedRangeOrNullObject(true); used.load('values'); await ctx.sync(); if (used.isNullObject) return;
    for (const row of used.values) if (row[0] && typeof row[5] === 'number') keep.set(String(row[0]), row[5]);
  });
  await writeLayout(takeoffLayout(records, groups), { activate: false });
  for (const g of groups) if (g.quantity != null) quantities.set(g.key, `SUMIF('Smart Take-off'!$A:$A,"=${g.key}",'Smart Take-off'!$I:$I)`);
  await writeLinks(records.map((r, i) => ({ key: `source-row-${i + 5}`, links: [r.elementKey], ids: [r.elementId], sheet: 'Smart Take-off', row: i + 5 })), 'Smart Take-off');
  await writeLayout(basisLayout(profile, context(), review), { activate: false });
  await writeLayout(textLayout('Smart Review', 'QS REVIEW QUEUE', ['Element ID', 'Quantity stream', 'Review message'], review.map(r => [r.elementId, r.stream, r.message])), { activate: false });
  const layout = boqLayout(groups, profile, { keep, quantities });
  await writeLinks(groups.map(g => ({ ...g, sheet: name, row: layout.rows.findIndex(r => r[0] === g.key) + 1 })), name);
  await writeLayout(layout);
  if (profile.purpose === 'costplan') {
    const allowances = new Map();
    await Excel.run(async ctx => { const sh = ctx.workbook.worksheets.getItemOrNullObject('Smart Elemental'); await ctx.sync(); if (sh.isNullObject) return;
      const used = sh.getUsedRangeOrNullObject(true); used.load('values'); await ctx.sync(); if (!used.isNullObject) used.values.forEach(r => { if (r[0] && typeof r[3] === 'number') allowances.set(String(r[0]), r[3]); }); });
    await writeLayout(elementalLayout({ keep: allowances }));
  }
  status('Draft workbook exported. Rates preserved by stable item key; review required.', 'ok');
}
export function initSmartTakeoff() {
  App.renderSmart = renderSmart;
  App.openSmartTakeoff = () => { step = 1; App.selectTab('smart'); };
  App.openSmartOutput = () => { loadState(); step = 3; App.selectTab('smart'); };
}
