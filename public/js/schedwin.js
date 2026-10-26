// DWFx Schedules window: quantity schedules from the model data, separate from measuring. The user selects
// elements (tree, 3D, filter or the AI), picks the columns each element has, adds calculated columns (formwork,
// reinforcement, any formula) to the same table, and exports it. Only the task pane can write to the workbook, so
// the tables and sheets are written by the pane (askPane); the model is processed and shown here, on this computer.
import { $, esc, App, api, session, status } from './core.js';
import { S, snapshot } from './state.js';
import { initModel, viewer, update, openVersion, closeModel, setColorMode, selectIds, loadZones } from './model.js';
import { initMeasure } from './measure.js';
import { initAI, refreshAIStatus } from './aiclient.js';
import { checksText } from './actions.js';
import { createWinLink, windowButtons } from './winlink.js';

const L = createWinLink({
  onMessage: (m) => receive(m),
  onPeer: (online) => { if (!online) status('The Excel task pane is closed or offline. Waiting…'); },
  onEnded: (text) => { $('vload').hidden = false; $('vload').textContent = text; },
});
const send = (m) => L.send(m);
const askPane = (cmd, data = {}, timeout) => L.askPane(cmd, { versionId: S.versionId, label: S.label, ...data }, timeout);
let project = null;

// ================================================================== tabs
let currentTab = 'elements';
function selectTab(name) {
  currentTab = name;
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + name));
  document.querySelectorAll('.nomodel').forEach(el => { el.hidden = Boolean(S.data); });
  document.querySelectorAll('.withmodel').forEach(el => { el.hidden = !S.data; });
  if (name === 'measure' && S.data) { App.renderMeasure(); renderSummaries(); }
  if (name === 'ai') refreshAIStatus();
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => selectTab(b.dataset.tab));

// ================================================================== the pane does the Excel work
const addSpec = async (spec) => { const r = await askPane('addSpecs', { specs: [spec] }); status(`Exported "${spec.name}" to Excel (${r.refs.join(', ')}).`, 'ok'); return r.refs[0]; };
const addToList = async (spec) => { await askPane('addSpecs', { specs: [spec] }); status(`Added "${spec.name}" to the take-off list.`, 'ok'); };
const host = {
  E: () => S.E, byId: () => S.byId, ticked: () => [...S.ticked], zoneOf: () => S.zoneOf,
  project: () => project, onProjectChanged: () => send({ type: 'projectChanged' }),
  projectId: () => project?.project?.id || null, versionId: () => S.versionId,
  canEdit: () => ['owner', 'editor'].includes(project?.my_role), inExcel: () => S.inExcel,
  select: (ids, fit = true) => selectIds(ids, { fit }),
  isolate: (ids) => { snapshot(); S.ticked = new Set(ids); S.isolated = true; S.hidden.clear(); update(); viewer()?.fit(ids.filter(id => viewer().hasGeometry(id))); },
  hide: (ids) => { snapshot(); ids.forEach(id => { S.hidden.add(id); S.ticked.delete(id); }); update(); },
  showAll: () => { snapshot(); S.hidden.clear(); S.isolated = false; S.level = ''; update(); viewer()?.fit(); },
  setView: (v) => viewer()?.setView(v),
  colorBy: (mode) => setColorMode(mode),
  addSpec: (spec) => (S.inExcel ? addSpec(spec) : addToList(spec).then(() => null)),
  excel: (cmd, d = {}) => askPane(cmd, d),
  refreshTree: () => send({ type: 'treeChanged' }),
  refreshZones: async () => { await loadZones(); send({ type: 'zonesChanged' }); },
  checks: async (kind) => checksText(kind, S.E),
  status,
  saveTemplate: (spec) => api('POST', '/templates', { name: spec.name, discipline: 'Structure', description: spec.note, scope: project ? 'project' : 'user', projectId: project?.project?.id,
    spec: { name: spec.name, filter: spec.filter, by: spec.by, note: spec.note, details: spec.details, inputs: spec.inputs, constants: spec.constants, formulas: spec.formulas } }),
};

/** Summary sheets: the Quantities register and a pivot by level or zone, all formulas over the Take-off sheet. */
function renderSummaries() {
  const box = $('sumBody'); if (!box) return;
  box.innerHTML = `<p class="hint">Built by formulas from the schedules on the Take-off sheet, so they follow every change.</p>
    <div class="row"><label>Totals by <select id="sumBy"><option value="level">Level</option><option value="zone">Zone</option><option value="none">Schedule only</option></select></label>
    <button class="primary" id="sumGo" ${S.inExcel ? '' : 'disabled'}>Build summary sheets</button></div>`;
  $('sumGo').onclick = async () => {
    try { const r = await askPane('buildSummaries', { by: $('sumBy').value }); status(`Built ${r.sheets.join(', ')} (${r.rows} rows).`, 'ok'); }
    catch (err) { status(err.message, 'bad'); }
  };
}

// ================================================================== messages from the task pane
function receive(m) {
  if (m.type === 'init') return init(m);
  if (m.type === 'select' && S.data) {
    const ids = (m.ids || []).filter(id => S.byId.has(id)); if (!ids.length) return;
    S.ticked = new Set(ids); update(); viewer()?.fit(ids.filter(id => viewer().hasGeometry(id)));
    status(`${ids.length} element${ids.length > 1 ? 's' : ''} highlighted from Excel.`);
  }
  if (m.type === 'paneEvent' && m.what === 'zones') loadZones();
  if (m.type === 'paneEvent' && m.what === 'takeoff' && S.colorBy === 'measured') setColorMode('measured');
  if (m.type === 'closed') { $('vload').hidden = false; $('vload').textContent = 'The task pane closed this window. You can close it.'; }
}
async function init(m) {
  if (m.token && !L.link) session.set({ ...(session.get() || {}), token: m.token });
  S.inExcel = m.inExcel !== false;
  if (m.projectId && m.projectId !== project?.project?.id) {
    try { project = await api('GET', `/projects/${m.projectId}`); } catch (err) { status(err.message, 'bad'); project = null; }
  }
  S.settings = { openingThreshold: 0.5, ...(project?.project?.settings || {}) };
  $('ctxProject').textContent = project ? `${project.project.name} · DWFx Schedules` : 'DWFx Schedules';
  document.title = $('ctxProject').textContent;
  renderVersions(m.versionId);
  if (m.versionId && m.versionId !== S.versionId) await open(m.versionId);
  else if (!S.data) { $('vload').hidden = false; $('vload').textContent = 'Choose a model version (top right). The model is read on this computer.'; selectTab('elements'); }
}
function versions() { return (project?.models || []).flatMap(mo => mo.versions.filter(v => v.status === 'ready').map(v => ({ id: v.id, label: `${mo.name} v${v.version} · ${v.file_name}` }))); }
function renderVersions(cur) {
  const list = versions(), sel = $('verPick');
  sel.hidden = !list.length;
  sel.innerHTML = '<option value="">Choose a model…</option>' + list.map(v => `<option value="${v.id}" ${v.id === (cur || S.versionId) ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
  sel.onchange = () => { if (sel.value) open(sel.value); };
}
async function open(vid) {
  const v = versions().find(x => x.id === vid);
  await openVersion(vid, v?.label || '');
  $('verPick').value = vid;
}

// ================================================================== start
Object.assign(App, {
  selectTab, currentTab: () => currentTab, update, viewer, setColorMode, openVersion, closeModel,
  currentProject: () => project, currentProjectId: () => project?.project?.id || null, currentVersionId: () => S.versionId,
  addToExcel: (spec) => addSpec(spec), addToList, paneHost: host,
  workbookState: () => askPane('workbook'),
  loadMeasured: async () => { const r = await askPane('measured'); S.measured = new Map(r.measured || []); return S.measured; },
  goToRows: (ids) => send({ type: 'pick', ids }),
  onModelLoaded: () => { selectTab(currentTab === 'project' ? 'elements' : currentTab); },
});
initModel(); initMeasure(); initAI();
const dark = (() => { try { return localStorage.getItem('dwfxTheme'); } catch { return null; } })();
if (dark === 'dark' || dark === 'light') document.documentElement.dataset.theme = dark;
L.start().then((ok) => {
  windowButtons($('wWin'), send, () => ({ camera: viewer()?.getViewState?.() }));
  if (!ok) $('vload').textContent = 'Open this window from the Excel task pane (DWFx Schedules).';
});
window.__sched = { S, App, host, receive, askPane };          // used by the automated browser tests
