// Large 3D window: same viewer and tools as the task pane, with drawings and properties side by side.
// Selection, isolate and hide stay linked with the task pane (and through it, with the Take-off sheet).
import { $, esc, api, session, status } from './core.js';
import { Viewer, parseBin, fromLegacy } from './viewer.js';
import { Toolbar } from './vtools.js';
import { fmt, dimsOf } from './engine.js';
import { openDrawing, canView } from './drawings.js';

const W = { ticked: new Set(), hidden: new Set(), isolated: false, level: '', byId: new Map(), E: [], colorMap: null, catColor: new Map(),
  projectId: null, versionId: null, levels: [], side: 'drawings', project: null, mode: 'pane' };
const PALETTE = ['#8a9aa6', '#c98a2b', '#2f6fa3', '#b5473a', '#6b5b8c', '#7a8a5a', '#3f8f8a', '#a8794f', '#5d6f8f', '#9a5d7a', '#6f8f3f', '#4f7fa8', '#b0905a', '#7d7d7d'];
let office = false, V, TB;

// ------------------------------------------------------------------ messaging with the task pane
function send(msg) {
  try {
    if (office) Office.context.ui.messageParent(JSON.stringify(msg));
    else window.opener?.postMessage(msg, location.origin);
  } catch { /* pane closed */ }
}
function receive(m) {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') init(m);
  else if (m.type === 'state' && V?.loaded) { W.ticked = new Set(m.ticked || []); W.hidden = new Set(m.hidden || []); W.isolated = Boolean(m.isolated); W.level = m.level || ''; paint(); }
  else if (m.type === 'colors') { W.colorMap = m.map ? new Map(m.map) : null; W.mode = m.mode || 'category'; paint(); }
  else if (m.type === 'model' && m.versionId && m.versionId !== W.versionId) init({ ...m, token: session.get()?.token, projectId: W.projectId });
}

async function init(m) {
  if (m.token) session.set({ ...(session.get() || {}), token: m.token });
  W.projectId = m.projectId; W.versionId = m.versionId;
  W.ticked = new Set(m.ticked || []); W.hidden = new Set(m.hidden || []); W.isolated = Boolean(m.isolated); W.level = m.level || '';
  W.colorMap = m.colorMap ? new Map(m.colorMap) : null; W.mode = m.colorMode || 'category';
  $('wTitle').textContent = m.label || 'Model'; $('wSub').textContent = 'Linked with the task pane: selections show in both.';
  $('vload').hidden = false; $('vload').textContent = 'Loading the model…';
  try {
    const data = await (await api('GET', `/versions/${m.versionId}/model`, null, { raw: true })).json();
    let g = null;
    if (data.geometryFormat === 'bin2') g = parseBin(await (await api('GET', `/versions/${m.versionId}/geometry`, null, { raw: true })).arrayBuffer());
    else if (data.geometry?.meshes) g = fromLegacy(data.geometry);
    W.E = data.elements; W.byId = new Map(W.E.map(e => [e.id, e]));
    const cats = new Map(); W.E.forEach(e => cats.set(e.cat, (cats.get(e.cat) || 0) + 1));
    [...cats].sort((a, b) => b[1] - a[1]).forEach(([c], i) => W.catColor.set(c, PALETTE[i % PALETTE.length]));
    if (g) V.load(g);
    levels(g);
    paint(); V.fit();
    $('vload').hidden = true;
    if (W.projectId) { try { W.project = await api('GET', `/projects/${W.projectId}`); } catch { W.project = null; } }
    renderSide();
  } catch (err) { $('vload').textContent = 'Could not load the model: ' + err.message; }
}
function levels(g) {
  W.levels = []; if (!g) return;
  const up = { x: 0, y: 1, z: 2 }[g.header.up || 'y'], by = new Map();
  W.E.forEach(e => { if (e.level && e.bb) { if (!by.has(e.level)) by.set(e.level, []); by.get(e.level).push(e.bb[up]); } });
  for (const [name, zs] of by) { zs.sort((a, b) => a - b); W.levels.push({ name, z: zs[Math.floor(zs.length / 2)] }); }
  W.levels.sort((a, b) => a.z - b.z);
}
const visible = (id) => !W.hidden.has(id) && (W.isolated ? W.ticked.has(id) : !W.level || W.byId.get(id)?.level === W.level);
function paint() {
  if (!V?.loaded) return;
  V.paint({ selected: W.ticked, isVisible: visible, colorOf: (id) => (W.colorMap?.get(id)) || W.catColor.get(W.byId.get(id)?.cat) || '#8a9aa6', xray: V.state.xray });
  TB.sync();
  if (W.side === 'props') renderSide();
}

// ------------------------------------------------------------------ toolbar host
const HOST = {
  selectedIds: () => [...W.ticked], isIsolated: () => W.isolated,
  toggleIsolate() { if (!W.isolated && !W.ticked.size) return status('Select elements first.'); W.isolated = !W.isolated; paint(); V.fit(); syncPane(); },
  hideSelected() { W.ticked.forEach(id => W.hidden.add(id)); W.ticked.clear(); paint(); syncPane(); },
  showAll() { W.isolated = false; W.hidden.clear(); W.level = ''; paint(); V.fit(); syncPane(); },
  levels: () => W.levels,
  colorModes: () => [{ id: 'pane', label: 'Same as the task pane' }, { id: 'category', label: 'Category' }],
  colorMode: () => (W.colorMap ? 'pane' : 'category'),
  async setColorMode(id) { if (id === 'category') W.colorMap = null; else status('Choose the colouring in the task pane; this window follows it.'); paint(); },
  legend() {
    const groups = new Map();
    W.E.forEach(e => { const c = W.colorMap?.get(e.id) || W.catColor.get(e.cat); const k = W.colorMap ? c : e.cat; if (!groups.has(k)) groups.set(k, { label: W.colorMap ? c : e.cat, color: c, ids: [] }); groups.get(k).ids.push(e.id); });
    return [...groups.values()].map(g => ({ ...g, count: g.ids.length })).sort((a, b) => b.count - a.count).slice(0, 30);
  },
  selectIds(ids) { W.ticked = new Set(ids); paint(); V.fit(ids); send({ type: 'pick', ids, add: false }); },
  canSaveViews: () => Boolean(W.projectId),
  async views() { return W.projectId ? (await api('GET', `/projects/${W.projectId}/views`)).views : []; },
  async saveView(name) {
    try { await api('POST', `/projects/${W.projectId}/views`, { name, versionId: W.versionId, state: { camera: V.getViewState(), ticked: [...W.ticked], hidden: [...W.hidden], isolated: W.isolated, level: W.level, xray: Boolean(V.state.xray) } }); status(`View "${name}" saved.`, 'ok'); }
    catch (err) { status(err.message, 'bad'); }
  },
  applyView(v) { const s = v.state || {}; W.ticked = new Set(s.ticked || []); W.hidden = new Set(s.hidden || []); W.isolated = Boolean(s.isolated); W.level = s.level || ''; V.state.xray = Boolean(s.xray); paint(); V.setViewState(s.camera); syncPane(); },
  async deleteView(v) { await api('DELETE', `/views/${v.id}`); },
  status,
  openWindow: null,
};
function syncPane() { send({ type: 'windowState', ticked: [...W.ticked], hidden: [...W.hidden], isolated: W.isolated, level: W.level }); }

// ------------------------------------------------------------------ side panel: drawings and properties
function renderSide() {
  const body = $('wbody'); if ($('wside').hidden) return;
  document.querySelectorAll('[data-st]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === W.side)));
  if (W.side === 'props') {
    const id = [...W.ticked][0], e = W.byId.get(id);
    if (!e) { body.innerHTML = '<p class="hint">Select an element to see its properties.</p>'; return; }
    const qs = Object.entries(e.q || {}).sort((a, b) => a[0].localeCompare(b[0]));
    body.innerHTML = `<strong>${esc(e.type)}</strong><div class="hint">${esc(e.cat)} › ${esc(e.fam)} · [${e.id}] · ${esc(e.level || '')}${W.ticked.size > 1 ? ` · first of ${W.ticked.size} selected` : ''}</div>
      ${dimsOf(e.type).length ? `<p class="hint">Size from type name: ${dimsOf(e.type).map(d => d.toFixed(3)).join(' x ')} m</p>` : ''}
      <table class="q"><tbody>${qs.map(([k, [v, u]]) => `<tr><td>${esc(k)}</td><td class="v">${fmt(v, u)} ${esc(u)}</td></tr>`).join('')}</tbody></table>
      <h4>All properties</h4><table class="q"><tbody>${Object.entries(e.props || {}).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="v" style="white-space:normal">${esc(v)}</td></tr>`).join('')}</tbody></table>`;
    return;
  }
  const drawings = (W.project?.drawings || []).filter(d => canView(d.name));
  const sheets = [];
  (W.project?.models || []).forEach(m => m.versions.filter(v => v.id === W.versionId).forEach(v => (v.stats?.sheets || []).forEach(sh => sheets.push({ kind: 'sheet', versionId: v.id, index: sh.index, name: sh.name }))));
  const all = [...sheets, ...drawings];
  if (!all.length) { body.innerHTML = '<p class="hint">No viewable drawings in this project yet. Upload PDFs or images in the task pane (Project > Drawings).</p>'; return; }
  body.innerHTML = `<label class="field">Drawing<select class="input" id="dwSel">${all.map((d, i) => `<option value="${i}">${esc(d.kind === 'sheet' ? 'Sheet: ' + d.name : d.name)}</option>`).join('')}</select></label><div id="drawingHost"></div>`;
  const show = () => openDrawing(all[+$('dwSel').value], $('drawingHost'));
  $('dwSel').onchange = show; show();
}

// ------------------------------------------------------------------ start
function start() {
  V = new Viewer($('vstage'), {
    onPick: (id, add) => {
      if (!add) W.ticked.clear();
      if (id != null) { if (add && W.ticked.has(id)) W.ticked.delete(id); else W.ticked.add(id); }
      const e = W.byId.get(id); $('pickInfo').hidden = !e; if (e) $('pickInfo').textContent = `${e.type}  [${e.id}]  ${e.level || ''}`;
      paint(); send({ type: 'pick', ids: [...W.ticked], add: false });
    },
    onContext: (id) => { W.ticked = new Set([id]); W.side = 'props'; $('wside').hidden = false; $('wgrip').hidden = false; $('wmain').classList.add('split'); paint(); renderSide(); send({ type: 'pick', ids: [id], add: false }); },
    onBoxSelect: (ids, add) => { if (!add) W.ticked.clear(); ids.forEach(id => W.ticked.add(id)); paint(); send({ type: 'pick', ids: [...W.ticked], add: false }); },
    onMeasure: (t) => { $('mInfo').hidden = !t; $('mInfo').textContent = t || ''; },
    labelOf: (id) => { const e = W.byId.get(id); return e ? `${e.type} · ${e.level || ''} [${e.id}]` : ''; },
  });
  TB = new Toolbar($('vbar'), $('vstage'), V, HOST);
  $('wSide').onclick = () => {
    const on = $('wside').hidden; $('wside').hidden = !on; $('wgrip').hidden = !on; $('wmain').classList.toggle('split', on);
    $('wSide').setAttribute('aria-pressed', String(on)); V.resize(); renderSide();
  };
  document.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { W.side = b.dataset.st; renderSide(); });
  let drag = null;
  $('wgrip').onpointerdown = (e) => { drag = e.clientX; $('wgrip').setPointerCapture(e.pointerId); };
  $('wgrip').onpointermove = (e) => { if (drag == null) return; const w = Math.max(260, Math.min(window.innerWidth - 300, window.innerWidth - e.clientX)); $('wmain').style.setProperty('--side', w + 'px'); };
  $('wgrip').onpointerup = () => { drag = null; V.resize(); };
  window.addEventListener('message', (ev) => { if (ev.origin === location.origin) receive(ev.data); });
  const dark = (() => { try { return localStorage.getItem('dwfxTheme'); } catch { return null; } })();
  if (dark === 'dark' || dark === 'light') document.documentElement.dataset.theme = dark;
  V.setTheme();
}
start();
const ready = typeof Office !== 'undefined' ? Office.onReady().catch(() => ({})) : Promise.resolve({});
ready.then(() => {
  office = typeof Office !== 'undefined' && Boolean(Office.context?.ui?.messageParent) && !window.opener;
  if (office) {
    try { Office.context.ui.addHandlerAsync(Office.EventType.DialogParentMessageReceived, (arg) => { try { receive(JSON.parse(arg.message)); } catch { /* ignore */ } }); } catch { /* DialogApi 1.2 missing */ }
  }
  send({ type: 'ready' });
  if (!window.opener && !office) { $('vload').textContent = 'Open this window from the task pane (3D window button).'; }
});
