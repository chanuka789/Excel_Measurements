// Large 3D window: project tree with drawings, models and dimension groups on the left, the 3D model in
// the middle, drawings and properties on the right. Selection, isolate and hide stay linked with the task pane (and
// through it with the Take-off sheet). Schedules are written to Excel by the task pane.
import { $, esc, api, session, status } from './core.js';
import { LinkChannel } from './link.js';
import { Viewer, parseBin, fromLegacy } from './viewer.js';
import { Toolbar } from './vtools.js';
import { fmt, dimsOf, uLabel } from './engine.js';
import { openDrawing, canView } from './drawings.js';
import { menu, closeMenu, dialog } from './wui.js';
import { initTree, onProjectLoaded, refresh as refreshTree, loadTree, importObjects, createGroupFor, currentGroup, onScheduleDone, tkSource } from './wtree.js';
import { TakeoffStore, drawingKey } from './tkstore.js';
import { DrawingTakeoff, newGroupDialog, measurableDrawings } from './takeoff2d.js';
import { PointTakeoff } from './takeoff3d.js';
import { initPanel, renderPanel, loadZones } from './wpanel.js';

const W = { zones: [], zoneOf: new Map(), inExcel: true, ticked: new Set(), hidden: new Set(), isolated: false, level: '', byId: new Map(), E: [], colorMap: null, catColor: new Map(),
  projectId: null, versionId: null, levels: [], side: 'drawings', project: null, mode: 'pane', groupColor: null, drawing: null, measure: null, label: '' };
const PALETTE = ['#8a9aa6', '#c98a2b', '#2f6fa3', '#b5473a', '#6b5b8c', '#7a8a5a', '#3f8f8a', '#a8794f', '#5d6f8f', '#9a5d7a', '#6f8f3f', '#4f7fa8', '#b0905a', '#7d7d7d'];
let office = false, V, TB, PT, started = false;
/** Dimension groups (from the project tree) and drawing settings for on-screen take-off. */
const STORE = new TakeoffStore({ projectId: () => W.projectId, canEdit: () => ['owner', 'editor'].includes(W.project?.my_role), source: tkSource });

// ------------------------------------------------------------------ messaging with the task pane
// dialog: Office dialog (messageParent); pop-up: window.opener; app: server link (a normal window with minimise/maximise)
// window settings come in the query string (Excel on the web can drop the #fragment) or, from older panes, the fragment
const HASH = new URLSearchParams(location.search); new URLSearchParams(location.hash.slice(1)).forEach((v, k) => { if (!HASH.has(k)) HASH.set(k, v); });
const MODE = HASH.get('link') ? 'app' : HASH.get('dlg') ? 'dialog' : 'popup';
let link = null;
function send(msg) {
  try {
    if (link) link.send(msg);
    else if (office) Office.context.ui.messageParent(JSON.stringify(msg));
    else window.opener?.postMessage(msg, location.origin);
  } catch { /* pane closed */ }
}
const pending = new Map(); let reqN = 0;
/** Ask the task pane to do something only it can do (write to Excel). Resolves with its answer. */
export function askPane(cmd, data = {}, timeout = 180000) {
  const id = ++reqN;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('The task pane did not answer. Is the add-in still open in Excel?')); }, timeout);
    pending.set(id, { resolve, reject, t });
    send({ type: 'pane', id, cmd, ...data });
  });
}
function receive(m) {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') init(m);
  else if (m.type === 'state' && V?.loaded) { W.ticked = new Set(m.ticked || []); W.hidden = new Set(m.hidden || []); W.isolated = Boolean(m.isolated); W.level = m.level || ''; paint(); }
  else if (m.type === 'colors') { W.colorMap = m.map ? new Map(m.map) : null; W.mode = m.mode || 'category'; paint(); }
  else if (m.type === 'model' && m.versionId && m.versionId !== W.versionId) init({ ...m, token: session.get()?.token, projectId: W.projectId });
  else if (m.type === 'scheduleDone') onScheduleDone(m);
  else if (m.type === 'paneReply' && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t);
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || 'The task pane could not do that.'));
  } else if (m.type === 'paneEvent') {
    if (m.what === 'tree') loadTree().catch(() => {});
    else if (m.what === 'zones') loadZones();
    else if (m.what === 'project' && W.projectId) api('GET', `/projects/${W.projectId}`).then(p => { W.project = p; if (PANEL_TABS.includes(W.side)) renderSide(); }).catch(() => {});
    onPaneEvent?.(m);
  }
  else if (m.type === 'closed') ended('The task pane closed this window. You can close it.');
}
let onPaneEvent = null;
export const setPaneEventHandler = (f) => { onPaneEvent = f; };
function ended(text) {
  $('vload').hidden = false; $('vload').textContent = text;
  $('wSub').textContent = 'Not linked to Excel.';
}
/** The app window gets its own session from a one-time code in the URL fragment, then removes it from the address. */
async function startLink() {
  const id = HASH.get('link'), claim = HASH.get('claim');
  session.useMemory(null);
  history.replaceState(null, '', location.pathname);      // the one-time code leaves the address bar
  const r = await fetch('api/link/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, claim }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { ended(data.error || 'This window link has expired. Open the app window again from the Excel task pane.'); return false; }
  session.set({ token: data.token, user: data.user });
  link = new LinkChannel(id, 'win', {
    onMessage: (m) => { if (m.type === 'peer') { if (m.side === 'pane') $('wSub').textContent = m.online ? 'Linked with Excel: selections show in both.' : 'Excel task pane is closed or offline. Waiting…'; return; } receive(m); },
    onState: (st) => { if (st === 'ended') ended('The link with Excel has ended. Open the app window again from the task pane.'); },
  });
  link.start();
  return true;
}

async function init(m) {
  if (m.token && !link) session.set({ ...(session.get() || {}), token: m.token });
  const newProject = m.projectId && m.projectId !== W.projectId;
  W.projectId = m.projectId || W.projectId; W.versionId = m.versionId; W.label = m.label || 'Model';
  W.ticked = new Set(m.ticked || []); W.hidden = new Set(m.hidden || []); W.isolated = Boolean(m.isolated); W.level = m.level || '';
  W.colorMap = m.colorMap ? new Map(m.colorMap) : null; W.mode = m.colorMode || 'category';
  $('wTitle').textContent = W.label; $('wSub').textContent = 'Linked with the task pane: selections show in both.';
  $('vload').hidden = false; $('vload').textContent = 'Loading the model…';
  try {
    const data = await (await api('GET', `/versions/${m.versionId}/model`, null, { raw: true })).json();
    let g = null;
    if (data.geometryFormat === 'bin2') g = parseBin(await (await api('GET', `/versions/${m.versionId}/geometry`, null, { raw: true })).arrayBuffer());
    else if (data.geometry?.meshes) g = fromLegacy(data.geometry);
    W.E = data.elements; W.byId = new Map(W.E.map(e => [e.id, e]));
    const cats = new Map(); W.E.forEach(e => cats.set(e.cat, (cats.get(e.cat) || 0) + 1));
    W.catColor.clear(); [...cats].sort((a, b) => b[1] - a[1]).forEach(([c], i) => W.catColor.set(c, PALETTE[i % PALETTE.length]));
    if (g) V.load(g); else V.clear();
    levels(g);
    paint(); V.fit();
    $('vload').hidden = true;
    if (m.view) applyCarry(m.view);
    W.inExcel = m.inExcel !== false; W.winMode = m.mode || MODE;
    if (W.projectId && (newProject || !W.project)) { try { W.project = await api('GET', `/projects/${W.projectId}`); } catch { W.project = null; } }
    await loadZones();
    renderSide();
    await onProjectLoaded();
    await STORE.load().catch(() => {});
    PT?.refresh();
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
  V.paint({ selected: W.ticked, isVisible: visible, xray: V.state.xray, solid: W.groupColor ? (id) => W.groupColor.has(id) : null,
    colorOf: (id) => W.groupColor?.get(id) || (W.colorMap?.get(id)) || W.catColor.get(W.byId.get(id)?.cat) || '#8a9aa6' });
  TB.sync();
  if (W.side === 'props') renderSide();
}

// ------------------------------------------------------------------ actions shared by the menus and the tree
function setIds(ids, fit = false) {
  W.ticked = new Set(ids.filter(id => W.byId.has(id))); paint();
  if (fit) V.fit([...W.ticked].filter(id => V.hasGeometry(id)));
  send({ type: 'pick', ids: [...W.ticked], add: false });
}
function showOnly(ids) {
  const keep = new Set(ids); W.isolated = false; W.level = '';
  W.hidden = new Set(W.E.map(e => e.id).filter(id => !keep.has(id)));
  paint(); V.fit(ids.filter(id => V.hasGeometry(id))); syncPane();
  status(`Showing only ${keep.size} object(s). Right-click > Show All Objects to bring the rest back.`);
}
function hideIds(ids) {
  ids.forEach(id => { W.hidden.add(id); W.ticked.delete(id); });
  paint(); syncPane(); status(`${ids.length} object(s) hidden. Press Show All Objects to see them again.`);
}
function showAll() { W.isolated = false; W.hidden.clear(); W.level = ''; paint(); V.fit(); syncPane(); }
function isolate(ids) { W.ticked = new Set(ids.filter(id => W.byId.has(id))); W.isolated = true; W.hidden.clear(); paint(); V.fit([...W.ticked].filter(id => V.hasGeometry(id))); syncPane(); }
/** Colour the current dimension group's objects with its positive / negative colours. */
function setGroupColors(g) {
  if (!g) { W.groupColor = null; paint(); return; }
  const pos = g.props.posColor || '#107c10', neg = g.props.negColor || '#d13438';
  W.groupColor = new Map(g.items.map(i => [i.element_id, i.sign < 0 ? neg : pos]));
  paint();
}
async function openVersion(vid, label) {
  if (vid === W.versionId) return;
  send({ type: 'openVersion', versionId: vid, label });          // the task pane follows, so the link stays exact
  await init({ versionId: vid, label, projectId: W.projectId, token: session.get()?.token });
}
function openDrawingSide(d) {
  W.drawing = d; W.side = 'drawings';
  showSidePanel(true); renderSide();
}

// ------------------------------------------------------------------ centre tabs: the 3D model and drawings opened to measure (CostX)
const TABS = []; let curTab = '3d';
function renderCTabs() {
  const bar = $('ctabs');
  bar.innerHTML = `<button class="ct" role="tab" data-ct="3d" aria-selected="${curTab === '3d'}"><span class="nm">3D model</span></button>` +
    TABS.map(t => `<span class="ct" role="tab" data-ct="${esc(t.key)}" aria-selected="${curTab === t.key}" tabindex="0" title="${esc(t.d.name)}"><span class="nm">${esc(t.d.kind === 'sheet' ? 'Sheet: ' + t.d.name : t.d.name)}</span><button class="x" data-cx="${esc(t.key)}" aria-label="Close ${esc(t.d.name)}">×</button></span>`).join('');
  bar.querySelectorAll('[data-ct]').forEach(b => { b.onclick = (e) => { if (!e.target.closest('[data-cx]')) showCTab(b.dataset.ct); }; b.onkeydown = (e) => { if (e.key === 'Enter') showCTab(b.dataset.ct); }; });
  bar.querySelectorAll('[data-cx]').forEach(b => b.onclick = () => closeCTab(b.dataset.cx));
}
function showCTab(key) {
  curTab = TABS.some(t => t.key === key) ? key : '3d';
  const in3d = curTab === '3d';
  $('vbar').hidden = !in3d; $('vstage').hidden = !in3d; $('w2d').hidden = in3d;
  TABS.forEach(t => { t.host.hidden = t.key !== curTab; });
  if (in3d) V.resize(); else { PT?.stop(); TABS.find(t => t.key === curTab)?.tk.fit(); }
  renderCTabs();
}
function closeCTab(key) {
  const i = TABS.findIndex(t => t.key === key); if (i < 0) return;
  TABS[i].tk.destroy(); TABS[i].host.remove(); TABS.splice(i, 1);
  if (curTab === key) curTab = TABS[i - 1]?.key || TABS[i]?.key || '3d';
  showCTab(curTab);
}
/** Open a drawing in the centre to measure on it (or switch to it when it is already open). */
async function openDrawingCentre(d) {
  if (!W.projectId) return openDrawingSide(d);
  const key = drawingKey(d);
  let t = TABS.find(x => x.key === key);
  if (!t) {
    const host = document.createElement('div'); $('w2d').append(host);
    const tk = new DrawingTakeoff(host, STORE, { onDimSelect: () => {}, drawings: () => measurableDrawings(W.project) });
    t = { key, d, host, tk, ready: null }; TABS.push(t);
    showCTab(key);
    t.ready = tk.open(d);
  } else showCTab(key);
  await t.ready;
  return t;
}
/** A measured dimension chosen in the Dimensions list: show it on its drawing, or highlight it in 3D. */
async function focusMeasured(m) {
  const s = m.src; if (!s) return;
  if (s.t === '3d') { showCTab('3d'); if (PT) { PT.sel = new Set([m.id]); PT.refresh(); } return; }
  let d = null;
  if (s.t === 'd') { const id = s.key.slice(2); d = (W.project?.drawings || []).find(x => x.id === id); }
  else { const [, vid, idx] = s.key.split(':'); const sh = (W.project?.models || []).flatMap(x => x.versions).find(v => v.id === vid)?.stats?.sheets?.find(x => String(x.index) === idx); d = { kind: 'sheet', versionId: vid, index: Number(idx), name: sh?.name || s.name || 'Sheet' }; }
  if (!d) return status('The drawing of this dimension is no longer in the project.', 'warn');
  const t = await openDrawingCentre(d);
  if (t && !(await t.tk.focusDim(m.id))) status('Could not find this dimension on its drawing.', 'warn');
}

// ------------------------------------------------------------------ the right-click menu on an object
function setsFor(id) {
  const e = W.byId.get(id); if (!e) return [];
  const by = (f) => W.E.filter(f).map(x => x.id);
  return [
    { label: `${e.cat} (${by(x => x.cat === e.cat).length})`, ids: () => by(x => x.cat === e.cat) },
    { label: `${e.fam} (${by(x => x.cat === e.cat && x.fam === e.fam).length})`, ids: () => by(x => x.cat === e.cat && x.fam === e.fam) },
    { label: `${e.type} (${by(x => x.cat === e.cat && x.fam === e.fam && x.type === e.type).length})`, ids: () => by(x => x.cat === e.cat && x.fam === e.fam && x.type === e.type) },
    { label: `${e.fam} [${e.id}]`, ids: () => [e.id] },
  ];
}
function objectSub(id, act) {
  return [...setsFor(id).map(s => ({ label: s.label, run: () => act(s.ids()) })), '-',
    { label: `Current Selection${W.ticked.size ? ` (${W.ticked.size})` : ''}`, key: act === hideIds ? 'H' : '', disabled: !W.ticked.size, run: () => act([...W.ticked]) },
    { label: 'Custom...', run: () => customSet(act) },
    { label: 'Area', run: () => { status('Drag a rectangle over the objects (left to right: fully inside; right to left: touched). Esc cancels.'); V.pickArea((ids) => act(ids)); } }];
}
/** Right-click on empty space (or an object with no data): view commands and the current selection. */
function viewMenu(x, y) {
  const editor = ['owner', 'editor'].includes(W.project?.my_role), sel = [...W.ticked], cur = currentGroup();
  const views = [['Top', 'top'], ['Bottom', 'bottom'], ['Front', 'front'], ['Back', 'back'], ['Left', 'left'], ['Right', 'right'], ['Isometric', 'iso']];
  menu([
    { label: `Object Properties${sel.length ? '' : ' (select an object)'}`, disabled: !sel.length, run: () => { W.side = 'props'; showSidePanel(true); renderSide(); } },
    { label: 'Create Dimension Group from Selection', disabled: !editor || !sel.length, run: () => createGroupFor(sel) },
    { label: `Import Selection${cur ? ` into "${cur.name}"` : ''}`, disabled: !editor || !sel.length, run: () => importObjects(sel) }, '-',
    { label: 'Show Only Selection', disabled: !sel.length, run: () => showOnly(sel) },
    { label: 'Hide Selection', key: 'H', disabled: !sel.length, run: () => hideIds(sel) },
    { label: 'Clear Selection', disabled: !sel.length, run: () => setIds([]) },
    { label: 'Show Objects In', items: [{ label: 'Custom...', run: () => customSet(showOnly) }, { label: 'Area', run: () => { status('Drag a rectangle over the objects. Esc cancels.'); V.pickArea((ids) => showOnly(ids)); } }] },
    { label: 'Select Objects In', items: [{ label: 'Custom...', run: () => customSet((ids) => setIds(ids, true)) }, { label: 'Area', run: () => { status('Drag a rectangle over the objects. Esc cancels.'); V.pickArea((ids) => setIds(ids)); } }] },
    { label: 'Show All Objects', run: showAll }, '-',
    { label: 'Zoom Area', run: () => { status('Drag a rectangle to zoom to. Esc cancels.'); V.pickArea((ids) => { if (ids.length) V.fit(ids); else status('Nothing inside that area.'); }, { crossing: true }); } },
    { label: 'Zoom Extents', run: () => V.fit() },
    { label: 'Zoom to Selection', disabled: !sel.length, run: () => V.fit(sel.filter(i => V.hasGeometry(i))) },
    { label: 'Reset View', run: () => V.setView('iso', false) },
    { label: 'Default Views', items: views.map(([l, v]) => ({ label: l, run: () => V.setView(v) })) }, '-',
    { label: V.imagesHidden ? 'Show Images' : 'Hide Images', title: 'Faded objects and edge lines', run: () => V.setImagesHidden(!V.imagesHidden) }, '-',
    { label: 'Close Menu' },
  ], x, y);
}
function objectMenu(id, x, y) {
  const e = W.byId.get(id); if (!e) return viewMenu(x, y);
  const editor = ['owner', 'editor'].includes(W.project?.my_role);
  const cur = currentGroup();
  const views = [['Top', 'top'], ['Bottom', 'bottom'], ['Front', 'front'], ['Back', 'back'], ['Left', 'left'], ['Right', 'right'], ['Isometric', 'iso']];
  menu([
    { label: 'Object Properties', run: () => { W.ticked = new Set([id]); W.side = 'props'; showSidePanel(true); paint(); renderSide(); send({ type: 'pick', ids: [id], add: false }); } },
    { label: 'Create Dimension Group', disabled: !editor, run: () => createGroupFor(W.ticked.has(id) ? [...W.ticked] : [id]) }, '-',
    { label: 'Show Only Objects In', items: objectSub(id, showOnly) },
    { label: 'Hide Objects In', items: objectSub(id, hideIds) },
    { label: `Import Objects In${cur ? '' : ''}`, disabled: !editor, title: cur ? `Adds to "${cur.name}"` : 'Creates a dimension group first', items: objectSub(id, importObjects) }, '-',
    { label: 'Hide Geometry', key: 'H', run: () => hideIds(W.ticked.has(id) ? [...W.ticked] : [id]) },
    { label: 'Show All Objects', run: showAll }, '-',
    { label: 'Zoom Area', run: () => { status('Drag a rectangle to zoom to. Esc cancels.'); V.pickArea((ids) => { if (ids.length) V.fit(ids); else status('Nothing inside that area.'); }, { crossing: true }); } },
    { label: 'Zoom Extents', run: () => V.fit() },
    { label: 'Reset View', run: () => V.setView('iso', false) },
    { label: 'Default Views', items: views.map(([l, v]) => ({ label: l, run: () => V.setView(v) })) }, '-',
    { label: V.imagesHidden ? 'Show Images' : 'Hide Images', title: 'Faded objects and edge lines', run: () => V.setImagesHidden(!V.imagesHidden) }, '-',
    { label: 'Close Menu' },
  ], x, y);
}
/** "Custom...": objects chosen by category, family, type, level or any property. */
async function customSet(act) {
  const opts = (k) => [...new Set(W.E.map(e => e[k] || ''))].filter(Boolean).sort();
  const propNames = [...new Set(W.E.slice(0, 3000).flatMap(e => Object.keys(e.props || {})))].sort();
  let picked = [];
  const match = (d) => {
    const cat = d.querySelector('#csC').value, fam = d.querySelector('#csF').value, type = d.querySelector('#csT').value, lev = d.querySelector('#csL').value;
    const pn = d.querySelector('#csP').value, pv = d.querySelector('#csV').value.trim().toLowerCase();
    return W.E.filter(e => (!cat || e.cat === cat) && (!fam || e.fam === fam) && (!type || e.type === type) && (!lev || e.level === lev) &&
      (!pn || (pv ? String(e.props?.[pn] ?? '').toLowerCase().includes(pv) : e.props?.[pn] != null))).map(e => e.id);
  };
  const sel = (id, label, list) => `<label class="field">${label}<select class="input" id="${id}"><option value="">(any)</option>${list.map(v => `<option>${esc(v)}</option>`).join('')}</select></label>`;
  const r = await dialog({ title: 'Choose objects', wide: true, body: `<div class="two">${sel('csC', 'Category', opts('cat'))}${sel('csF', 'Family', opts('fam'))}</div>
      <div class="two">${sel('csT', 'Type', opts('type'))}${sel('csL', 'Level', opts('level'))}</div>
      <div class="two">${sel('csP', 'Property', propNames)}<label class="field">contains<input class="input" id="csV" placeholder="text (empty: has the property)"></label></div>
      <p id="csN" class="sum"></p>`,
    onOpen: (d) => { const upd = () => { picked = match(d); d.querySelector('#csN').textContent = `${picked.length} object(s) match`; }; d.oninput = upd; d.onchange = upd; upd(); },
    validate: (d) => { picked = match(d); return picked.length ? '' : 'No objects match.'; } });
  if (r) act(picked);
}

// ------------------------------------------------------------------ toolbar host
const HOST = {
  selectedIds: () => [...W.ticked], isIsolated: () => W.isolated,
  toggleIsolate() { if (!W.isolated && !W.ticked.size) return status('Select elements first.'); W.isolated = !W.isolated; paint(); V.fit(); syncPane(); },
  hideSelected() { hideIds([...W.ticked]); },
  showAll,
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
  takeoff: () => (W.projectId && PT ? { store: STORE, pt: PT, newGroup: () => newGroupDialog(STORE, status) } : null),
};
function syncPane() { send({ type: 'windowState', ticked: [...W.ticked], hidden: [...W.hidden], isolated: W.isolated, level: W.level }); }

// ------------------------------------------------------------------ right panel: drawings and properties
function showSidePanel(on) {
  $('wside').hidden = !on; $('wgrip').hidden = !on; $('wmain').classList.toggle('split', on);
  $('wSide').setAttribute('aria-pressed', String(on)); V.resize();
}
const PANEL_TABS = ['measure', 'ai', 'zones', 'checks', 'output'];
function renderSide() {
  const body = $('wbody'); if ($('wside').hidden) return;
  document.querySelectorAll('[data-st]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === W.side)));
  if (PANEL_TABS.includes(W.side)) { renderPanel(); return; }
  if (W.side === 'props') {
    const id = [...W.ticked][0], e = W.byId.get(id);
    if (!e) { body.innerHTML = '<p class="hint">Select an element to see its properties.</p>'; return; }
    const qs = Object.entries(e.q || {}).sort((a, b) => a[0].localeCompare(b[0]));
    body.innerHTML = `<strong>${esc(e.type)}</strong><div class="hint">${esc(e.cat)} › ${esc(e.fam)} · [${e.id}] · ${esc(e.level || '')}${W.ticked.size > 1 ? ` · first of ${W.ticked.size} selected` : ''}</div>
      ${dimsOf(e.type).length ? `<p class="hint">Size from type name: ${dimsOf(e.type).map(d => d.toFixed(3)).join(' x ')} m</p>` : ''}
      <table class="q"><tbody>${qs.map(([k, [v, u]]) => `<tr><td>${esc(k)}</td><td class="v">${fmt(v, u)} ${esc(uLabel(u))}</td></tr>`).join('')}</tbody></table>
      <h4>All properties</h4><table class="q"><tbody>${Object.entries(e.props || {}).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="v" style="white-space:normal">${esc(v)}</td></tr>`).join('')}</tbody></table>`;
    return;
  }
  const drawings = (W.project?.drawings || []).filter(d => canView(d.name));
  const sheets = [];
  (W.project?.models || []).forEach(m => m.versions.filter(v => v.id === W.versionId).forEach(v => (v.stats?.sheets || []).forEach(sh => sheets.push({ kind: 'sheet', versionId: v.id, index: sh.index, name: sh.name }))));
  const all = [...sheets, ...drawings];
  if (W.drawing && !all.some(d => same(d, W.drawing))) all.unshift(W.drawing);
  if (!all.length) { body.innerHTML = '<p class="hint">No viewable drawings in this project yet. Upload PDFs or images: right-click the Drawings tree > Upload Drawings.</p>'; return; }
  const at = Math.max(0, all.findIndex(d => W.drawing && same(d, W.drawing)));
  body.innerHTML = `<label class="field">Drawing<select class="input" id="dwSel">${all.map((d, i) => `<option value="${i}" ${i === at ? 'selected' : ''}>${esc(d.kind === 'sheet' ? 'Sheet: ' + d.name : d.name)}</option>`).join('')}</select></label><div id="drawingHost"></div>`;
  const show = () => { W.drawing = all[+$('dwSel').value]; openDrawing(W.drawing, $('drawingHost')); };
  $('dwSel').onchange = show; show();
}
const same = (a, b) => (a.kind === 'sheet' ? b.kind === 'sheet' && a.versionId === b.versionId && a.index === b.index : a.id === b.id);

// ------------------------------------------------------------------ start
function grip(el, onMove) {
  let on = false;
  el.onpointerdown = (e) => { on = true; el.setPointerCapture(e.pointerId); };
  el.onpointermove = (e) => { if (on) onMove(e); };
  el.onpointerup = () => { on = false; V.resize(); };
}
function start() {
  if (started) return; started = true;
  V = new Viewer($('vstage'), {
    onPick: (id, add) => {
      if (!add) W.ticked.clear();
      if (id != null) { if (add && W.ticked.has(id)) W.ticked.delete(id); else W.ticked.add(id); }
      const e = W.byId.get(id); $('pickInfo').hidden = !e; if (e) $('pickInfo').textContent = `${e.type}  [${e.id}]  ${e.level || ''}`;
      paint(); send({ type: 'pick', ids: [...W.ticked], add: false });
    },
    onContext: (id, x, y) => objectMenu(id, x, y),
    onBoxSelect: (ids, add) => { if (!add) W.ticked.clear(); ids.forEach(id => W.ticked.add(id)); paint(); send({ type: 'pick', ids: [...W.ticked], add: false }); },
    onMeasure: (t, info) => {
      $('mInfo').hidden = !t; $('mInfo').textContent = t || '';
      if (info?.distance != null) W.measure = { text: t.split(' · ')[0], value: info.distance, unit: 'm', kind: 'distance' };
      if (info?.area != null) W.measure = { text: t, value: info.area, unit: 'm2', kind: 'area' };
    },
    labelOf: (id) => { const e = W.byId.get(id); return e ? `${e.type} · ${e.level || ''} [${e.id}]` : ''; },
  });
  TB = new Toolbar($('vbar'), $('vstage'), V, HOST);
  PT = new PointTakeoff(V, STORE, { versionId: () => W.versionId, label: () => W.label, status });
  renderCTabs();
  $('wSide').onclick = () => { showSidePanel($('wside').hidden); renderSide(); };
  $('wLeft').onclick = () => {
    const on = $('wleft').hidden; $('wleft').hidden = !on; $('lgrip').hidden = !on; $('wmain').classList.toggle('left', on);
    $('wLeft').setAttribute('aria-pressed', String(on)); V.resize();
  };
  document.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { W.side = b.dataset.st; renderSide(); });
  grip($('wgrip'), (e) => { const w = Math.max(260, Math.min(window.innerWidth - 400, window.innerWidth - e.clientX)); $('wmain').style.setProperty('--side', w + 'px'); });
  grip($('lgrip'), (e) => { const w = Math.max(240, Math.min(window.innerWidth - 400, e.clientX)); $('wmain').style.setProperty('--left', w + 'px'); });
  grip($('hgrip'), (e) => { const r = $('wleft').getBoundingClientRect(); const h = Math.max(120, Math.min(r.height - 160, e.clientY - r.top)); $('wleft').style.setProperty('--top', h + 'px'); });
  // H hides the selected geometry (shortcut); Esc closes menus
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input,select,textarea,#dialog:not([hidden]),.tk')) return;
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && W.ticked.size) { e.preventDefault(); hideIds([...W.ticked]); }
    if (e.key === 'Escape') closeMenu();
  });
  window.addEventListener('message', (ev) => { if (ev.origin === location.origin) receive(ev.data); });
  const dark = (() => { try { return localStorage.getItem('dwfxTheme'); } catch { return null; } })();
  if (dark === 'dark' || dark === 'light') document.documentElement.dataset.theme = dark;
  V.setTheme();
  initTree({ W, V, send, host: HOST, paint, setIds, showOnly, hideIds, isolate, setGroupColors, openVersion,
    openDrawing: openDrawingCentre, openDrawingSide, focusMeasured, onTreeChange: () => STORE.emit('groups'), lastMeasure: () => W.measure });
  initPanel({ W, get V() { return V; }, askPane, send, setIds, isolate, hideIds, showAll, paint, loadTree });
}
start();
window.__win = { W, get V() { return V; }, setIds, STORE, TABS, openDrawingCentre, get PT() { return PT; } };       // used by the automated browser tests
const ready = MODE !== 'app' && typeof Office !== 'undefined' ? Office.onReady().catch(() => ({})) : Promise.resolve({});
ready.then(async () => {
  if (MODE === 'app') { if (!(await startLink())) return; }
  else {
    // In Excel on the web the dialog is a pop-up whose opener is Excel itself, not this pane, so a dialog always
    // talks through Office (messageParent / messageChild). A plain pop-up (add-in opened in a browser) uses the opener.
    const canOffice = typeof Office !== 'undefined' && Boolean(Office.context?.ui?.messageParent);
    office = canOffice && (MODE === 'dialog' || !window.opener);
    if (office) {
      try { Office.context.ui.addHandlerAsync(Office.EventType.DialogParentMessageReceived, (arg) => { try { receive(JSON.parse(arg.message)); } catch { /* ignore */ } }); } catch { /* DialogApi 1.2 missing */ }
    }
  }
  windowButtons();
  send({ type: 'ready' });
  if (MODE !== 'app' && !window.opener && !office) { $('vload').textContent = 'Open this window from the task pane (3D window button).'; }
});
/** Maximise / Restore re-open the Office dialog at the other size (Office has no resize call); "App window" moves to a
 * normal browser window that has minimise and maximise. The view is carried over. */
function windowButtons() {
  const box = $('wWin'); if (!box) return;
  const carry = () => ({ camera: V?.getViewState?.(), side: $('wside').hidden ? null : W.side, left: !$('wleft').hidden });
  const reopen = (mode) => { send({ type: 'reopen', mode, view: carry() }); };
  if (MODE === 'dialog') {
    const max = HASH.get('dlg') === 'max';
    box.innerHTML = `<button class="btn small" id="wMax" title="${max ? 'Back to the normal size' : 'Fill the screen'}">${max ? 'Restore' : 'Maximise'}</button>
      <button class="btn small" id="wApp" title="Open in a separate browser window that you can minimise, maximise and move to another screen">App window</button>`;
    $('wMax').onclick = () => reopen(max ? 'normal' : 'max');
    $('wApp').onclick = () => reopen('app');
  } else if (MODE === 'app') {
    box.innerHTML = `<button class="btn small" id="wFull" title="Full screen (Esc to leave)">Full screen</button>`;
    $('wFull').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); };
  }
}
/** Restore the view carried from the previous window. */
function applyCarry(v) {
  if (!v) return;
  if (v.camera) V.setViewState(v.camera);
  if (v.left === false && !$('wleft').hidden) $('wLeft').click();
  if (v.side) { W.side = v.side; showSidePanel(true); renderSide(); }
}
export { refreshTree };
