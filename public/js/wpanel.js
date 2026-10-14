// Right panel of the 3D / app window: Measure (QS rule items), AI (runs the app), Zones, Checks and Output.
// Excel work is sent to the task pane (askPane); everything else runs here.
import { esc, api, status } from './core.js';
import { mountQs } from './qsui.js';
import { renderPlan, checksText, stepLabel } from './actions.js';

let C = null;            // { W, V, askPane, send, setIds, isolate, hideIds, showAll, paint, loadTree }
let qs = null, aiBox = null, aiForm = null;
const ZONE_COLORS = ['#0078d4', '#e3008c', '#00b7c3', '#ca5010', '#498205', '#8764b8', '#986f0b', '#c239b3', '#038387', '#bf0077'];

export const windowHost = {
  E: () => C.W.E, byId: () => C.W.byId, ticked: () => [...C.W.ticked], zoneOf: () => C.W.zoneOf,
  project: () => C.W.project, onProjectChanged: () => { C.send({ type: 'projectChanged' }); },
  projectId: () => C.W.projectId, versionId: () => C.W.versionId,
  canEdit: () => ['owner', 'editor'].includes(C.W.project?.my_role), inExcel: () => C.W.inExcel !== false,
  select: (ids, fit = true) => C.setIds(ids, fit), isolate: (ids) => C.isolate(ids), hide: (ids) => C.hideIds(ids), showAll: () => C.showAll(),
  setView: (v) => C.V.setView(v),
  colorBy: async (mode) => { if (mode === 'zone') return zoneColors(true); if (mode === 'category') { C.W.colorMap = null; C.paint(); return; } await C.askPane('colorBy', { mode }); },
  addSpec: async (spec) => (await C.askPane('addSpecs', { specs: [spec], versionId: C.W.versionId, label: C.W.label })).refs[0],
  excel: (cmd, d = {}) => C.askPane(cmd, { ...d, versionId: C.W.versionId, label: C.W.label }),
  refreshTree: () => C.loadTree(),
  refreshZones: () => loadZones(),
  checks: async (kind) => checksText(kind, C.W.E),
  status,
};

export function initPanel(ctx) { C = ctx; }

export async function loadZones() {
  const W = C.W; W.zones = []; W.zoneOf = new Map();
  if (W.projectId) { try { W.zones = (await api('GET', `/projects/${W.projectId}/zones`)).zones; } catch { /* optional */ } }
  W.zones.forEach(z => (z.ids || []).forEach(id => { if (!W.zoneOf.has(id)) W.zoneOf.set(id, z.name); }));
  W.E.forEach(e => { e.zone = W.zoneOf.get(e.id) || ''; });
  if (W.side === 'zones') renderPanel();
}
function zoneColors(on) {
  const W = C.W;
  if (!on) { W.colorMap = null; C.paint(); return; }
  const col = new Map(W.zones.map((z, i) => [z.name, z.color || ZONE_COLORS[i % ZONE_COLORS.length]]));
  W.colorMap = new Map(W.E.map(e => [e.id, col.get(W.zoneOf.get(e.id)) || '#c8cdd2'])); C.paint();
}

/** Draw the current tab into the side panel body. */
export function renderPanel() {
  const W = C.W, body = document.getElementById('wbody');
  const tab = W.side;
  if (tab === 'measure') {
    if (!qs) {
      const host = document.createElement('div'); host.id = 'qsHost';
      qs = { host, ui: mountQs({ host, E: () => W.E, byId: () => W.byId, ticked: () => [...W.ticked], project: () => W.project,
        onProjectChanged: () => C.send({ type: 'projectChanged' }), selectIds: (ids) => C.setIds(ids, true), status,
        get inExcel() { return W.inExcel !== false; }, add: (spec) => windowHost.addSpec(spec) }) };
    }
    body.replaceChildren(qs.host); qs.ui.render(); return;
  }
  if (tab === 'ai') { body.replaceChildren(aiPanel()); return; }
  if (tab === 'zones') return zonesPanel(body);
  if (tab === 'checks') return checksPanel(body);
  if (tab === 'output') return outputPanel(body);
}
export const resetPanels = () => { if (qs) qs.ui.render(); };

// ------------------------------------------------------------------ AI
function aiPanel() {
  if (aiForm) return aiForm;
  aiForm = document.createElement('div');
  aiForm.innerHTML = `<label class="field">Ask the AI to measure or to do something in the app
      <textarea id="wAiAsk" rows="4" placeholder="e.g. Measure the whole structure by NRM2, put each element type in a folder of dimension groups, then build the NRM1 elemental summary"></textarea></label>
    <div class="chips" id="wAiChips">
      <button data-ask="Measure the whole structure by the project rules and add it to Excel">Whole structure</button>
      <button data-ask="Formwork, concrete, reinforcement and waterproofing to the foundations by the project rules">Foundations</button>
      <button data-ask="Build the summary by level, the NRM2 summary and the NRM1 elemental summary">Summaries</button>
      <button data-ask="Create a folder Structure with one dimension group per element type (volume)">Dimension groups</button>
      <button data-ask="Create zones for each level">Zones by level</button>
      <button data-ask="Check the model for missing data and overlapping elements">Checks</button>
    </div>
    <div class="row"><button class="btn primary" id="wAiGo">Ask AI</button><span class="hint">The AI plans; you see every step and press Run before anything changes.</span></div>`;
  aiBox = document.createElement('div'); aiBox.id = 'wAiOut'; aiForm.append(aiBox);
  const ask = async () => {
    const t = aiForm.querySelector('#wAiAsk'), request = t.value.trim(); if (!request) { t.focus(); return; }
    const go = aiForm.querySelector('#wAiGo'); go.disabled = true;
    aiBox.innerHTML = '<div class="card"><div class="loading">The AI is planning: reading the rules, finding the elements and testing the quantities…</div><div class="progress indet"><div></div></div></div>';
    try {
      let workbook = null; try { workbook = await C.askPane('workbook', {}, 8000); } catch { /* pane closed */ }
      const data = await api('POST', '/ai', { request, versionId: C.W.versionId, ticked: [...C.W.ticked], workbook });
      renderPlan(aiBox, data, windowHost, { stepLabel, onAnswer: (a) => { t.value = `${request}\nAnswer to your question: ${a}`; ask(); } });
    } catch (err) { aiBox.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; }
    finally { go.disabled = false; }
  };
  aiForm.querySelector('#wAiGo').onclick = ask;
  aiForm.querySelector('#wAiAsk').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask(); });
  aiForm.querySelector('#wAiChips').onclick = (e) => { const b = e.target.closest('[data-ask]'); if (b) { const t = aiForm.querySelector('#wAiAsk'); t.value = b.dataset.ask; t.focus(); } };
  return aiForm;
}

// ------------------------------------------------------------------ zones
function zonesPanel(body) {
  const W = C.W, edit = windowHost.canEdit();
  if (!W.projectId) { body.innerHTML = '<p class="hint">Zones belong to a project. Open a model from a project.</p>'; return; }
  body.innerHTML = `<p class="hint">A zone is a named set of elements (for example Villa, Annex, Block A). Take-offs can sub-total by zone and the model can be coloured by zone.</p>
    <div class="row"><button class="btn small" id="zCol">${W.colorMap && W.zoneColored ? 'Normal colours' : 'Colour by zone'}</button></div>
    ${W.zones.map((z, i) => `<div class="zone-row"><span class="sw" style="background:${esc(z.color || ZONE_COLORS[i % ZONE_COLORS.length])}"></span><span class="grow">${esc(z.name)}</span><span class="muted small">${(z.ids || []).length}</span>
      <button class="btn small" data-zs="${i}">Select</button>${edit ? `<button class="btn small" data-zu="${i}" title="Replace with the current selection">Update</button><button class="btn small subtle danger-text" data-zd="${i}">Delete</button>` : ''}</div>`).join('') || '<p class="hint">No zones yet.</p>'}
    ${edit ? `<form class="inline-form" id="zForm"><input class="input" id="zName" placeholder="New zone name" maxlength="80" required aria-label="New zone name"><button class="btn">Create from selection (${W.ticked.size})</button></form>` : ''}`;
  body.querySelector('#zCol').onclick = () => { W.zoneColored = !(W.colorMap && W.zoneColored); zoneColors(W.zoneColored); renderPanel(); };
  body.querySelectorAll('[data-zs]').forEach(b => b.onclick = () => C.setIds(W.zones[+b.dataset.zs].ids.filter(id => W.byId.has(id)), true));
  const save = async (name, color) => {
    if (!W.ticked.size) { status('Select the elements of the zone first.', 'bad'); return; }
    try { await api('POST', `/projects/${W.projectId}/zones`, { name, color, ids: [...W.ticked] }); await loadZones(); C.send({ type: 'zonesChanged' }); status(`Zone "${name}" saved.`, 'ok'); renderPanel(); }
    catch (err) { status(err.message, 'bad'); }
  };
  body.querySelectorAll('[data-zu]').forEach(b => b.onclick = () => { const z = W.zones[+b.dataset.zu]; save(z.name, z.color); });
  body.querySelectorAll('[data-zd]').forEach(b => b.onclick = async () => {
    try { await api('DELETE', `/zones/${W.zones[+b.dataset.zd].id}`); await loadZones(); C.send({ type: 'zonesChanged' }); renderPanel(); status('Zone deleted.', 'ok'); } catch (err) { status(err.message, 'bad'); }
  });
  const f = body.querySelector('#zForm'); if (f) f.onsubmit = (e) => { e.preventDefault(); save(f.querySelector('#zName').value.trim(), ZONE_COLORS[W.zones.length % ZONE_COLORS.length]); };
}

// ------------------------------------------------------------------ checks
function checksPanel(body) {
  const E = C.W.E;
  const concrete = /structural (framing|columns|foundations)|^floors$|^walls$/i;
  const lists = [
    ['Elements without 3D geometry', E.filter(e => !e.bb).map(e => e.id)],
    ['Elements without a level', E.filter(e => !e.level).map(e => e.id)],
    ['Concrete elements without any volume', E.filter(e => concrete.test(e.cat) && !e.q?.Volume && !e.q?.['Geo volume'] && !e.q?.['Net volume']).map(e => e.id)],
    ['Concrete elements without formwork data (old processing)', E.filter(e => concrete.test(e.cat) && e.bb && !Object.keys(e.q || {}).some(k => k.startsWith('FW '))).map(e => e.id)],
  ];
  body.innerHTML = `<h3>Missing data</h3><ul class="check-list">${lists.map(([l, ids], i) => `<li><span class="pill ${ids.length ? 'neutral' : 'ok'}">${ids.length}</span><span class="grow">${esc(l)}</span>${ids.length ? `<button class="btn small" data-cs="${i}">Select</button>` : ''}</li>`).join('')}</ul>
    <h3>Double counting</h3><p class="hint" id="ovOut">${esc(checksText('overlaps', E))}</p>
    <p class="hint">More checks (measured status, AI take-off check, revisions) are in the task pane Review tab.</p>
    <div class="row"><button class="btn small" id="ckPane">Open the Review tab in Excel</button></div>`;
  body.querySelectorAll('[data-cs]').forEach(b => b.onclick = () => C.setIds(lists[+b.dataset.cs][1], true));
  body.querySelector('#ckPane').onclick = () => C.askPane('showTab', { tab: 'review' }).then(() => status('Opened in the task pane.', 'ok')).catch(err => status(err.message, 'bad'));
}

// ------------------------------------------------------------------ output (through the task pane)
function outputPanel(body) {
  const ex = C.W.inExcel !== false;
  body.innerHTML = `<p class="hint">These write to your workbook through the task pane in Excel. Everything is built with formulas from the Take-off sheet.</p>
    <h3>Summary sheets</h3>
    <div class="row wrap"><label><input type="checkbox" data-wsm="summary" checked> Summary by level / zone</label><label><input type="checkbox" data-wsm="NRM2"> NRM2</label>
      <label><input type="checkbox" data-wsm="POMI"> POMI</label><label><input type="checkbox" data-wsm="NRM1"> NRM1 elemental</label></div>
    <div class="row wrap"><label>Split by <select class="input" id="wsBy" style="width:auto"><option value="level">Level</option><option value="zone">Zone</option><option value="none">No split</option></select></label>
      <label>GIFA m² <input class="input" id="wsGifa" type="number" min="0" step="any" style="width:100px"></label></div>
    <div class="row"><button class="btn primary" id="wsRun" ${ex ? '' : 'disabled'}>Build summary sheets</button></div>
    <h3>BOQ</h3>
    <div class="row"><label><input type="checkbox" id="wbAI"> AI descriptions</label><button class="btn" id="wbRun" ${ex ? '' : 'disabled'}>Build BOQ sheet</button></div>
    <h3>Revisions</h3>
    <div class="row"><button class="btn" id="wrRun">Update the take-off to this model version…</button></div>
    ${ex ? '' : '<p class="hint">Open the add-in in Excel to write sheets.</p>'}`;
  const busy = async (btn, fn) => { btn.disabled = true; try { const r = await fn(); status(r, 'ok'); } catch (err) { status(err.message, 'bad'); } finally { btn.disabled = false; } };
  body.querySelector('#wsRun').onclick = (e) => busy(e.target, async () => {
    const kinds = [...body.querySelectorAll('[data-wsm]:checked')].map(c => c.dataset.wsm);
    const r = await windowHost.excel('buildSummaries', { kinds, by: body.querySelector('#wsBy').value, gifa: Number(body.querySelector('#wsGifa').value) || null });
    return `Built ${r.sheets.join(', ')} (${r.rows} quantity rows).`;
  });
  body.querySelector('#wbRun').onclick = (e) => busy(e.target, async () => `BOQ built with ${(await windowHost.excel('buildBoq', { ai: body.querySelector('#wbAI').checked })).items} items.`);
  body.querySelector('#wrRun').onclick = (e) => busy(e.target, async () => { await C.askPane('showTab', { tab: 'review' }); return 'Choose the tables to update in the task pane Review tab (Revisions).'; });
}
