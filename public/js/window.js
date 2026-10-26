// The measurement window: works like RIB CostX. Ribbon on top; on the left the Drawings / Layers / Model / Views tree
// and the Dimension Groups / Dimensions / Auto Count lists; drawings and the 3D model as tabs in the middle; a
// status bar. It opens from the Excel task pane and stays linked with it: groups and dimensions are linked to Excel
// cells with live formulas, and clicking a linked cell shows where it was measured (Follow Excel).
// Only the task pane can write to the workbook, so Excel work is asked of it (askPane).
import { $, esc, api, session, status } from './core.js';
import { Viewer, parseBin, fromLegacy } from './viewer.js';
import { Toolbar } from './vtools.js';
import { fmt, dimsOf, uLabel } from './engine.js';
import { dimensions } from './dims.js';
import { openDrawing, canView } from './drawings.js';
import { menu, closeMenu, dialog, ask } from './wui.js';
import { initTree, onProjectLoaded, refresh as refreshTree, loadTree, importObjects, createGroupFor, currentGroup, onScheduleDone, tkSource,
  selectGroup, groupById, allGroups, treeActions } from './wtree.js';
import { TakeoffStore, drawingKey } from './tkstore.js';
import { DrawingTakeoff, measurableDrawings, canMeasure } from './takeoff2d.js';
import { PointTakeoff } from './takeoff3d.js';
import { initPanel, renderPanel, loadZones } from './wpanel.js';
import { loadVersion, compareVersions } from './localfiles.js';
import { library } from './localstore.js';
import { REV_COLORS } from './state.js';
import { Ribbon } from './ribbon.js';
import { buildCommands, RIBBON_TABS, fileMenu } from './commands.js';
import { createWinLink, MODE, windowButtons } from './winlink.js';

const W = { zones: [], zoneOf: new Map(), inExcel: true, ticked: new Set(), hidden: new Set(), isolated: false, level: '', byId: new Map(), E: [], colorMap: null, catColor: new Map(),
  projectId: null, versionId: null, levels: [], side: 'drawings', project: null, mode: 'pane', groupColor: null, drawing: null, measure: null, label: '', data: null,
  links: [], objectMode: false, compare: null };
const PALETTE = ['#8a9aa6', '#c98a2b', '#2f6fa3', '#b5473a', '#6b5b8c', '#7a8a5a', '#3f8f8a', '#a8794f', '#5d6f8f', '#9a5d7a', '#6f8f3f', '#4f7fa8', '#b0905a', '#7d7d7d'];
let V, TB, PT, RB, started = false;
const canEdit = () => ['owner', 'editor'].includes(W.project?.my_role);
/** Dimension groups (from the project tree) and drawing settings for on-screen take-off. */
const STORE = new TakeoffStore({ projectId: () => W.projectId, canEdit, source: tkSource });
const pref = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1'; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* storage blocked */ } };
let follow = pref('dwfxFollowExcel', true);             // Follow Excel: a click on a linked cell shows the measurement

// ------------------------------------------------------------------ the link with the task pane
const L = createWinLink({
  onMessage: (m) => receive(m),
  onPeer: (online) => { $('wSub').textContent = online ? 'Linked with Excel.' : 'Excel task pane is closed or offline. Waiting…'; },
  onEnded: (text) => ended(text),
});
const send = (m) => L.send(m);
export const askPane = (cmd, data, timeout) => L.askPane(cmd, data, timeout);
function receive(m) {
  if (m.type === 'init') init(m);
  else if (m.type === 'state' && V?.loaded) { W.ticked = new Set(m.ticked || []); W.hidden = new Set(m.hidden || []); W.isolated = Boolean(m.isolated); W.level = m.level || ''; paint(); }
  else if (m.type === 'colors') { W.colorMap = m.map ? new Map(m.map) : null; W.mode = m.mode || 'category'; paint(); }
  else if (m.type === 'model' && m.versionId && m.versionId !== W.versionId) openVersion(m.versionId, m.label || '');
  else if (m.type === 'scheduleDone') onScheduleDone(m);
  else if (m.type === 'focusDim') focusLink(m);
  else if (m.type === 'links') { W.links = m.list || []; refreshTree(); if (curTab === 'book') renderWorkbook(); setLinkStatus(); }
  else if (m.type === 'paneEvent') {
    if (m.what === 'tree') loadTree().catch(() => {});
    else if (m.what === 'zones') loadZones();
    else if (m.what === 'project' && W.projectId) reloadProject();
    else if (m.what === 'follow') { follow = Boolean(m.on); setPref('dwfxFollowExcel', follow); setLinkStatus(); }
    else if (m.what === 'noLinks') status('Not linked to any Excel cell yet. Select a cell in Excel, then use Link to Cell.');
  }
  else if (m.type === 'closed') ended('The task pane closed this window. You can close it.');
  RB?.refresh();
}
function ended(text) {
  $('vload').hidden = false; $('vload').textContent = text;
  $('wSub').textContent = 'Not linked to Excel.';
}
async function reloadProject() {
  try { W.project = await api('GET', `/projects/${W.projectId}`); } catch { return; }
  setTitle(); refreshTree();
}
function setTitle() {
  const p = W.project?.project?.name || 'DWFx Measure';
  $('wTitle').textContent = p; document.title = `${p} · DWFx Measure`;
  $('wSub').textContent = W.label ? `3D model: ${W.label}` : 'Linked with Excel.';
}

/** First message from the task pane: the project (and the model version, if one is chosen). */
async function init(m) {
  if (m.token && !L.link) session.set({ ...(session.get() || {}), token: m.token });
  const newProject = m.projectId && m.projectId !== W.projectId;
  W.projectId = m.projectId || W.projectId; W.inExcel = m.inExcel !== false; W.winMode = m.mode || MODE;
  if (typeof m.follow === 'boolean') { follow = m.follow; setPref('dwfxFollowExcel', follow); }
  if (W.projectId && (newProject || !W.project)) { try { W.project = await api('GET', `/projects/${W.projectId}`); } catch { W.project = null; } }
  setTitle();
  await onProjectLoaded();
  await STORE.load().catch(() => {});
  send({ type: 'linksPlease' });
  const vid = m.versionId || null;
  if (vid) await openVersion(vid, m.label || '', { quiet: true, ...m });
  else if (!V.loaded) noModel();
  if (m.view) applyCarry(m.view);
  if (m.drawing) openDrawingCentre(m.drawing);
  RB.refresh();
}
function noModel() {
  V.clear(); W.E = []; W.byId = new Map(); W.versionId = null; W.label = ''; W.data = null;
  $('vload').hidden = false;
  $('vload').textContent = (W.project?.models || []).some(x => x.versions.some(v => v.status === 'ready'))
    ? 'No 3D model open. Double-click a model version in the Drawings tree to open it, or open a drawing to measure.'
    : 'No 3D model in this project. Open a drawing from the Drawings tree to measure, or add a DWFx in the Excel task pane.';
  setTitle();
}
/** Open a model version in the 3D tab (processed on this computer, kept in the library). */
async function openVersion(vid, label = '', opts = {}) {
  if (vid === W.versionId && V.loaded) { showCTab('3d'); return; }
  if (!opts.quiet) send({ type: 'openVersion', versionId: vid, label });
  W.versionId = vid; W.label = label || 'Model';
  W.ticked = new Set(opts.ticked || []); W.hidden = new Set(opts.hidden || []); W.isolated = Boolean(opts.isolated); W.level = opts.level || '';
  W.colorMap = opts.colorMap ? new Map(opts.colorMap) : null; W.compare = null;
  showCTab('3d');
  $('vload').hidden = false; $('vload').textContent = 'Loading the model…';
  try {
    const r = await loadVersion(vid, { onUpdate: (st) => { $('vload').textContent = `${st.step}${st.pct ? ` (${Math.round(st.pct)}%)` : ''}`; } });
    const data = r.data;
    if (!W.label || W.label === 'Model') W.label = `${r.meta?.model_name || 'Model'} v${r.meta?.version || ''}`;
    let g = null;
    if (data.geometryFormat === 'bin2' && r.geometry) g = parseBin(r.geometry);
    else if (data.geometry?.meshes) g = fromLegacy(data.geometry);
    W.data = data; W.E = data.elements; W.byId = new Map(W.E.map(e => [e.id, e]));
    const cats = new Map(); W.E.forEach(e => cats.set(e.cat, (cats.get(e.cat) || 0) + 1));
    W.catColor.clear(); [...cats].sort((a, b) => b[1] - a[1]).forEach(([c], i) => W.catColor.set(c, PALETTE[i % PALETTE.length]));
    if (g) V.load(g); else V.clear();
    levels(g);
    paint(); V.fit();
    $('vload').hidden = true;
    await loadZones();
    PT?.refresh();
    setTitle(); refreshTree(); renderSide();
  } catch (err) { $('vload').textContent = 'Could not load the model: ' + err.message; }
  RB.refresh();
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
  TB.sync(); RB?.refresh();
  if (W.side === 'props') renderSide();
}

// ------------------------------------------------------------------ actions shared by the menus, the tree and the ribbon
function setIds(ids, fit = false) {
  W.ticked = new Set(ids.filter(id => W.byId.has(id))); paint();
  if (fit) V.fit([...W.ticked].filter(id => V.hasGeometry(id)));
  send({ type: 'pick', ids: [...W.ticked], add: false, versionId: W.versionId });
}
function showOnly(ids) {
  const keep = new Set(ids); W.isolated = false; W.level = '';
  W.hidden = new Set(W.E.map(e => e.id).filter(id => !keep.has(id)));
  paint(); V.fit(ids.filter(id => V.hasGeometry(id))); syncPane();
  status(`Showing only ${keep.size} object(s). Show All Objects brings the rest back.`);
}
function hideIds(ids) {
  ids.forEach(id => { W.hidden.add(id); W.ticked.delete(id); });
  paint(); syncPane(); status(`${ids.length} object(s) hidden. Show All Objects shows them again.`);
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
function openDrawingSide(d) {
  W.drawing = d; W.side = 'drawings';
  showSidePanel(true); renderSide();
}
function syncPane() { send({ type: 'windowState', ticked: [...W.ticked], hidden: [...W.hidden], isolated: W.isolated, level: W.level, versionId: W.versionId }); }

// ------------------------------------------------------------------ centre: the 3D model, drawings and the Workbook View as tabs (CostX)
const TABS = []; let curTab = '3d';
function renderCTabs() {
  const bar = $('ctabs');
  bar.innerHTML = TABS.map(t => `<span class="ct" role="tab" data-ct="${esc(t.key)}" aria-selected="${curTab === t.key}" tabindex="0" title="${esc(t.d.name)}"><span class="nm">${esc(t.d.kind === 'sheet' ? 'Sheet: ' + t.d.name : t.d.name)}</span><button class="x" data-cx="${esc(t.key)}" aria-label="Close ${esc(t.d.name)}">×</button></span>`).join('') +
    `<button class="ct" role="tab" data-ct="3d" aria-selected="${curTab === '3d'}" title="${esc(W.label || '3D model')}"><span class="nm">${esc(W.label ? '3D: ' + W.label : '3D model')}</span></button>` +
    `<button class="ct" role="tab" data-ct="book" aria-selected="${curTab === 'book'}" title="Dimensions linked to Excel cells"><span class="nm">Workbook View</span></button>`;
  bar.querySelectorAll('[data-ct]').forEach(b => { b.onclick = (e) => { if (!e.target.closest('[data-cx]')) showCTab(b.dataset.ct); }; b.onkeydown = (e) => { if (e.key === 'Enter') showCTab(b.dataset.ct); }; });
  bar.querySelectorAll('[data-cx]').forEach(b => b.onclick = () => closeCTab(b.dataset.cx));
}
function showCTab(key) {
  curTab = key === 'book' || TABS.some(t => t.key === key) ? key : '3d';
  const in3d = curTab === '3d', book = curTab === 'book';
  $('vstage').hidden = !in3d; $('w2d').hidden = in3d || book; $('wbook').hidden = !book;
  TABS.forEach(t => { t.host.hidden = t.key !== curTab; });
  if (in3d) V.resize(); else { PT?.stop(); TABS.find(t => t.key === curTab)?.tk.fit(); }
  if (book) renderWorkbook();
  renderCTabs(); refreshTree(); updateStatus(); RB?.refresh();
}
function closeCTab(key) {
  const i = TABS.findIndex(t => t.key === key); if (i < 0) return;
  TABS[i].tk.destroy(); TABS[i].host.remove(); TABS.splice(i, 1);
  if (curTab === key) curTab = TABS[i - 1]?.key || TABS[i]?.key || '3d';
  showCTab(curTab);
}
/** The drawing on screen (DrawingTakeoff), or null when the 3D model or the Workbook View is shown. */
const activeTk = () => TABS.find(t => t.key === curTab)?.tk || null;
/** Open a drawing in the centre to measure on it (or switch to it when it is already open). */
async function openDrawingCentre(d) {
  if (!W.projectId) return openDrawingSide(d);
  const key = drawingKey(d);
  let t = TABS.find(x => x.key === key);
  if (!t) {
    const host = document.createElement('div'); $('w2d').append(host);
    const tk = new DrawingTakeoff(host, STORE, {
      onDimSelect: (list) => { if (list.length === 1 && follow) send({ type: 'showLinks', gid: list[0].gid, mid: list[0].mid }); },
      drawings: () => measurableDrawings(W.project),
      onState: () => { if (activeTk() === tk) { RB?.refresh(); updateStatus(); } },
      onCursor: (p) => { if (activeTk() === tk) showCursor(tk, p); },
      acHost: () => (treeActions.bottom() === 'auto' ? $('dgTree') : null),
      propsOnAdd: () => pref('dwfxPropsOnAdd', false),
    });
    t = { key, d, host, tk, ready: null }; TABS.push(t);
    showCTab(key);
    t.ready = tk.open(d).then(() => { if (curTab === key) { updateStatus(); RB.refresh(); } });
  } else showCTab(key);
  await t.ready;
  return t;
}
/** A measured dimension (from the Dimensions list or an Excel cell): show it on its drawing, or highlight it in 3D. */
async function focusMeasured(m) {
  const s = m.src; if (!s) return;
  if (s.t === '3d') {
    if (s.key !== W.versionId) await openVersion(s.key);
    showCTab('3d'); if (PT) { PT.sel = new Set([m.id]); PT.refresh(); } return;
  }
  const d = drawingOfSrc(s);
  if (!d) return status('The drawing of this dimension is no longer in the project.', 'warn');
  const t = await openDrawingCentre(d);
  if (t && !(await t.tk.focusDim(m.id))) status('Could not find this dimension on its drawing.', 'warn');
}
function drawingOfSrc(s) {
  if (s.t === 'd') { const id = s.key.slice(2); return (W.project?.drawings || []).find(x => x.id === id) || null; }
  const [, vid, idx] = s.key.split(':');
  const sh = (W.project?.models || []).flatMap(x => x.versions).find(v => v.id === vid)?.stats?.sheets?.find(x => String(x.index) === idx);
  return { kind: 'sheet', versionId: vid, index: Number(idx), name: sh?.name || s.name || 'Sheet' };
}

// ------------------------------------------------------------------ Excel links (live formulas) and Follow Excel
/** Tell the task pane the measurements changed, so linked cells update. Model-object quantities need the model, which
 * only this window has open, so their totals go with the message. */
let totalsTimer = null;
function totalsSoon() { clearTimeout(totalsTimer); totalsTimer = setTimeout(sendTotals, 1200); }
function sendTotals() {
  let totals = null;
  if (W.byId.size) {
    totals = {};
    for (const g of allGroups()) {
      if (!(g.items || []).length) continue;
      const dims = {}; let total = 0, n = 0;
      for (const d of dimensions(g, W.byId)) if (d.kind === 'bim' && d.qty != null) { dims[d.item.element_id] = Math.round(d.qty * 1e6) / 1e6; total += d.qty; n++; }
      totals[g.id] = { total, n, dims: n <= 5000 ? dims : {} };
    }
  }
  send({ type: 'treeChanged', totals, versionId: W.versionId });
}
/** Link a group or a dimension to the selected Excel cell: the task pane writes a live formula there. */
async function linkCell(item) {
  const g = item ? groupById(item.gid || item.id) : currentGroup();
  if (!g) return status('Choose a dimension group (or a dimension) first.', 'warn');
  if (!W.inExcel) return status('Open the add-in in Excel to link cells.', 'bad');
  try {
    const r = await askPane('linkCell', { gid: g.id, mid: item?.mid || null, eid: item?.eid ?? null, quantity: item?.q || null }, 30000);
    status(`Linked to ${r.address}: ${r.text}. The cell updates when the measurement changes.`, 'ok');
  } catch (err) { status(err.message, 'bad'); }
}
const isLinked = (gid) => W.links.some(l => l.gid === gid);
function showLinks(gid, mid = null) { send({ type: 'showLinks', gid, mid, force: true }); }
/** A linked cell was clicked in Excel: show where it was measured. */
async function focusLink(m) {
  if (!follow && !m.force) return;
  const g = groupById(m.gid); if (!g) return;
  selectGroup(g.id);
  if (m.mid) { const d = (g.props.measured || []).find(x => x.id === m.mid); if (d) return focusMeasured(d); }
  if (m.eid != null) { if (!V.loaded) return status('Open the 3D model to see this object.', 'warn'); showCTab('3d'); return setIds([m.eid], true); }
  return focusGroup(g);
}
/** Show a whole group: its dimensions on the drawing where most of them are, or its objects in 3D. */
async function focusGroup(g) {
  const ms = (g.props.measured || []).filter(x => x.src);
  const by = new Map(); ms.forEach(x => { const k = x.src.t === '3d' ? '3d:' + x.src.key : x.src.key; by.set(k, (by.get(k) || 0) + 1); });
  const best = [...by].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best && !best.startsWith('3d:')) {
    const first = ms.find(x => x.src.key === best); const d = drawingOfSrc(first.src);
    if (d) { const t = await openDrawingCentre(d); await t.tk.focusDims?.(ms.filter(x => x.src.key === best).map(x => x.id)); return; }
  }
  if (g.items.length && V.loaded) { showCTab('3d'); return setIds(g.items.map(i => i.element_id), true); }
  if (best?.startsWith('3d:')) { const d = ms.find(x => x.src.t === '3d'); return focusMeasured(d); }
  status(`"${g.name}" has no dimensions to show yet.`);
}
function setFollow(on) { follow = on; setPref('dwfxFollowExcel', on); send({ type: 'follow', on }); setLinkStatus(); RB.refresh(); status(on ? 'Follow Excel is on: click a linked cell to see where it was measured.' : 'Follow Excel is off. The links stay; the window no longer jumps to them.'); }
function setLinkStatus() { $('stLink').textContent = `${W.links.length} linked cell${W.links.length === 1 ? '' : 's'} · Follow Excel ${follow ? 'on' : 'off'}`; }
/** Workbook View: every cell linked to a measurement. */
function renderWorkbook() {
  const box = $('wbook');
  const rows = W.links.map((l, i) => { const g = groupById(l.gid); const m = l.mid ? (g?.props.measured || []).find(x => x.id === l.mid) : null;
    return `<tr><td>${esc(l.sheet)}</td><td>${esc(l.address)}</td><td>${esc(g?.name || '(deleted group)')}</td><td>${esc(m?.label || (l.eid != null ? `Object [${l.eid}]` : 'Whole group'))}</td><td>${esc(l.quantity || '')}</td><td class="v">${esc(l.value ?? '')}</td>
      <td><button class="btn small" data-go="${i}">Go to cell</button> <button class="btn small" data-show="${i}" ${g ? '' : 'disabled'}>Show</button> <button class="btn small subtle danger-text" data-rm="${i}">Remove link</button></td></tr>`; }).join('');
  box.innerHTML = `<div class="row"><strong class="grow">Cells linked to measurements</strong><button class="btn small" id="wbRef">Refresh</button></div>
    <p class="hint">Link a group or a dimension: select a cell in Excel, then drag the group or dimension from the left onto the drop bar, double-click a dimension, or press Link to Cell. The cell gets a live formula (=CX.QTY) that updates when you measure.</p>
    ${rows ? `<table class="links"><thead><tr><th>Sheet</th><th>Cell</th><th>Dimension group</th><th>Dimension</th><th>Quantity</th><th>Value</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="hint">No linked cells yet.</p>'}`;
  box.querySelector('#wbRef').onclick = () => send({ type: 'linksPlease' });
  box.querySelectorAll('[data-go]').forEach(b => b.onclick = () => askPane('selectCell', W.links[+b.dataset.go]).catch(err => status(err.message, 'bad')));
  box.querySelectorAll('[data-show]').forEach(b => b.onclick = () => { const l = W.links[+b.dataset.show]; focusLink({ ...l, force: true }); });
  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => askPane('unlinkCell', W.links[+b.dataset.rm]).then(() => status('Link removed (the cell keeps its last value).', 'ok')).catch(err => status(err.message, 'bad')));
}
/** The drop bar shown while a group or a dimension is dragged: drop links it to the selected Excel cell. */
function initLinkBar() {
  const bar = $('linkbar');
  bar.ondragover = (e) => { e.preventDefault(); bar.classList.add('over'); };
  bar.ondragleave = () => bar.classList.remove('over');
  bar.ondrop = (e) => { e.preventDefault(); bar.classList.remove('over'); bar.hidden = true; try { const d = JSON.parse(e.dataTransfer.getData('text/plain')); linkCell(d.type === 'group' ? { gid: d.id } : d); } catch { /* not ours */ } };
}
const onDragStart = (d) => { if ((d.type === 'group' || d.type === 'dim') && W.inExcel) $('linkbar').hidden = false; };
const onDragEnd = () => { setTimeout(() => { $('linkbar').hidden = true; }, 50); };

// ------------------------------------------------------------------ status bar
function updateStatus() {
  const tk = activeTk();
  if (tk) {
    const sc = tk.scale, r = tk.settings?.pages?.[tk.page]?.ratio;
    $('stScale').textContent = !sc ? 'Scale: not set' : tk.cadUnit && !STORE.scaleOf(tk.dkey, tk.page) ? 'Scale 1:1 (CAD units)' : r ? `Scale 1:${r}${tk.ky !== 1 ? ' (X/Y calibrated)' : ''}` : 'Scale: calibrated';
    $('stSnap').textContent = `Snap ${tk.snapOn ? 'on' : 'off'}${tk.angle ? ' · angle 15°' : ''}${tk.pages > 1 ? ` · page ${tk.page}/${tk.pages}` : ''}`;
  } else { $('stScale').textContent = curTab === '3d' && V?.loaded ? `${W.E.length.toLocaleString()} objects` : ''; $('stSnap').textContent = ''; $('stCursor').textContent = ''; }
  setLinkStatus();
}
function showCursor(tk, p) {
  if (!p) { $('stCursor').textContent = ''; return; }
  const s = tk.scale;
  $('stCursor').textContent = s ? `X ${(p[0] * s).toFixed(3)}  Y ${(p[1] * s * tk.ky).toFixed(3)} m` : `X ${p[0].toFixed(1)}  Y ${p[1].toFixed(1)}`;
}

// ------------------------------------------------------------------ layers (left pane Layers tab)
function layerSource() {
  const tk = activeTk();
  if (tk) {
    const list = tk.layerList();
    const redraw = async () => { if (tk.kind === 'cad') tk.svgVectors(tk.svgEl); else await tk.rerender(); };
    return { list, empty: tk.kind === 'pdf' ? 'This PDF has no layers.' : 'This drawing has no layers (CAD drawings and some PDFs have them).',
      set: (id, on) => { tk.setLayer(id, on); redraw(); }, all: (on) => { list.forEach(l => tk.setLayer(l.id, on)); redraw(); },
      invert: () => { list.forEach(l => tk.setLayer(l.id, !l.on)); redraw(); }, only: (id) => { list.forEach(l => tk.setLayer(l.id, l.id === id)); redraw(); } };
  }
  if (!V?.loaded) return null;
  const cats = new Map(); W.E.forEach(e => { if (!cats.has(e.cat)) cats.set(e.cat, []); cats.get(e.cat).push(e.id); });
  const list = [...cats].sort((a, b) => a[0].localeCompare(b[0])).map(([c, ids]) => ({ id: c, name: c, on: ids.some(id => !W.hidden.has(id)), count: ids.length }));
  const setCat = (c, on) => { cats.get(c).forEach(id => (on ? W.hidden.delete(id) : W.hidden.add(id))); };
  const done = () => { paint(); syncPane(); };
  return { list, countLabel: 'Objects', set: (id, on) => { setCat(id, on); done(); }, all: (on) => { list.forEach(l => setCat(l.id, on)); done(); },
    invert: () => { list.forEach(l => setCat(l.id, !l.on)); done(); }, only: (id) => { list.forEach(l => setCat(l.id, l.id === id)); done(); } };
}
/** Auto Count tab (left pane): the panel of the drawing on screen. */
function autoCount(host) {
  const tk = activeTk(); if (!tk) return false;
  if (tk.ac) { tk.acPanel(); return true; }
  host.innerHTML = `<div class="dock-body"><p class="hint">Auto Count finds every copy of a symbol (a door, a light fitting…) on this drawing, rotated and mirrored copies too.</p>
    <button class="btn primary" id="acGo">Start Auto Count</button><p class="hint">It counts into the current group, which must be a Count group.</p></div>`;
  host.querySelector('#acGo').onclick = () => { tk.acStart(); };
  return true;
}
const uomOf = (d) => { const p = STORE.drawing(drawingKey(d)).pages?.[1]; return /\.(dwg|dxf)$/i.test(d.name) ? 'CAD' : p?.ratio ? `1:${p.ratio}` : p?.scale ? 'cal.' : ''; };

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
const VIEWS = [['Top', 'top'], ['Bottom', 'bottom'], ['Front', 'front'], ['Back', 'back'], ['Left', 'left'], ['Right', 'right'], ['Isometric', 'iso']];
function viewMenu(x, y) {
  const sel = [...W.ticked], cur = currentGroup();
  menu([
    { label: `Object Properties${sel.length ? '' : ' (select an object)'}`, disabled: !sel.length, run: () => { W.side = 'props'; showSidePanel(true); renderSide(); } },
    { label: 'Create Dimension Group from Selection', disabled: !canEdit() || !sel.length, run: () => createGroupFor(sel) },
    { label: `Import Selection${cur ? ` into "${cur.name}"` : ''}`, disabled: !canEdit() || !sel.length, run: () => importObjects(sel) }, '-',
    { label: 'Show Only Selection', disabled: !sel.length, run: () => showOnly(sel) },
    { label: 'Hide Selection', key: 'H', disabled: !sel.length, run: () => hideIds(sel) },
    { label: 'Clear Selection', disabled: !sel.length, run: () => setIds([]) },
    { label: 'Show Objects In', items: [{ label: 'Custom...', run: () => customSet(showOnly) }, { label: 'Area', run: () => { status('Drag a rectangle over the objects. Esc cancels.'); V.pickArea((ids) => showOnly(ids)); } }] },
    { label: 'Select Objects In', items: [{ label: 'Custom...', run: () => customSet((ids) => setIds(ids, true)) }, { label: 'Area', run: () => { status('Drag a rectangle over the objects. Esc cancels.'); V.pickArea((ids) => setIds(ids)); } }] },
    { label: 'Show All Objects', run: showAll }, '-',
    { label: 'Zoom Area', run: zoomArea3d }, { label: 'Zoom Extents', run: () => V.fit() },
    { label: 'Zoom to Selection', disabled: !sel.length, run: () => V.fit(sel.filter(i => V.hasGeometry(i))) },
    { label: 'Reset View', run: () => V.setView('iso', false) },
    { label: 'Default Views', items: VIEWS.map(([l, v]) => ({ label: l, run: () => V.setView(v) })) }, '-',
    { label: V.imagesHidden ? 'Show Images' : 'Hide Images', title: 'Faded objects and edge lines', run: () => V.setImagesHidden(!V.imagesHidden) }, '-',
    { label: 'Close Menu' },
  ], x, y);
}
function objectMenu(id, x, y) {
  const e = W.byId.get(id); if (!e) return viewMenu(x, y);
  menu([
    { label: 'Object Properties', run: () => { W.ticked = new Set([id]); W.side = 'props'; showSidePanel(true); paint(); renderSide(); send({ type: 'pick', ids: [id], add: false }); } },
    { label: 'Create Dimension Group', disabled: !canEdit(), run: () => createGroupFor(W.ticked.has(id) ? [...W.ticked] : [id]) }, '-',
    { label: 'Show Only Objects In', items: objectSub(id, showOnly) },
    { label: 'Hide Objects In', items: objectSub(id, hideIds) },
    { label: 'Import Objects In', disabled: !canEdit(), title: currentGroup() ? `Adds to "${currentGroup().name}"` : 'Creates a dimension group first', items: objectSub(id, importObjects) }, '-',
    { label: 'Hide Geometry', key: 'H', run: () => hideIds(W.ticked.has(id) ? [...W.ticked] : [id]) },
    { label: 'Show All Objects', run: showAll }, '-',
    { label: 'Zoom Area', run: zoomArea3d }, { label: 'Zoom Extents', run: () => V.fit() },
    { label: 'Reset View', run: () => V.setView('iso', false) },
    { label: 'Default Views', items: VIEWS.map(([l, v]) => ({ label: l, run: () => V.setView(v) })) }, '-',
    { label: V.imagesHidden ? 'Show Images' : 'Hide Images', title: 'Faded objects and edge lines', run: () => V.setImagesHidden(!V.imagesHidden) }, '-',
    { label: 'Close Menu' },
  ], x, y);
}
function zoomArea3d() { status('Drag a rectangle to zoom to. Esc cancels.'); V.pickArea((ids) => { if (ids.length) V.fit(ids); else status('Nothing inside that area.'); }, { crossing: true }); }
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

// ------------------------------------------------------------------ 3D colours: revisions, measured status, overlaps, model maps
async function compareModel() {
  const versions = (W.project?.models || []).flatMap(m => m.versions.filter(v => v.status === 'ready').map(v => ({ id: v.id, label: `${m.name} v${v.version}`, model: m.id, n: v.version })));
  const cur = versions.find(v => v.id === W.versionId);
  if (!cur || versions.length < 2) return status('Open a model version that has another version to compare with.', 'warn');
  const prev = versions.filter(v => v.model === cur.model && v.n < cur.n).sort((a, b) => b.n - a.n)[0] || versions.find(v => v.id !== cur.id);
  let from = null;
  const r = await dialog({ title: 'Compare model versions', body: `<label class="field">Compare the open version (${esc(cur.label)}) with<select class="input" id="cmF">${versions.filter(v => v.id !== cur.id).map(v => `<option value="${v.id}" ${v.id === prev?.id ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
    <p class="hint">Objects are matched by their Revit ID. Added objects are green, changed orange, unchanged grey. It runs on this computer.</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Compare', value: 'ok', primary: true }], validate: (d) => { from = d.querySelector('#cmF').value; return ''; } });
  if (!r) return;
  status('Comparing on this computer…');
  try {
    const c = await compareVersions(from, cur.id);
    const add = new Set(c.added.map(x => x.id)), chg = new Set(c.changed.map(x => x.id));
    W.compare = c;
    W.colorMap = new Map(W.E.map(e => [e.id, add.has(e.id) ? REV_COLORS.added : chg.has(e.id) ? REV_COLORS.changed : REV_COLORS.same]));
    paint();
    status(`${c.summary.added} added, ${c.summary.changed} changed, ${c.summary.removed} removed since ${c.from.label}.`, 'ok');
  } catch (err) { status(err.message, 'bad'); }
}
/** Colour the model by how many dimension groups measure each object: not measured, once, twice or more (overlaps). */
function colourMeasured(kind) {
  if (!V.loaded) return status('Open the 3D model first.', 'warn');
  const n = new Map(); allGroups().forEach(g => g.items.forEach(i => n.set(i.element_id, (n.get(i.element_id) || 0) + 1)));
  if (kind === 'off') { W.colorMap = null; W.compare = null; paint(); return; }
  if (kind === 'maps') {                         // Model Maps: each object in its group's colour
    const col = new Map(); allGroups().forEach(g => g.items.forEach(i => { if (!col.has(i.element_id)) col.set(i.element_id, i.sign < 0 ? g.props.negColor || '#d13438' : g.props.posColor || '#107c10'); }));
    W.colorMap = new Map(W.E.map(e => [e.id, col.get(e.id) || '#d0d4d8'])); paint(); return status(`${col.size} object(s) in dimension groups, in each group's colour.`);
  }
  if (kind === 'overlaps') {
    const twice = W.E.filter(e => (n.get(e.id) || 0) > 1).map(e => e.id);
    W.colorMap = new Map(W.E.map(e => [e.id, (n.get(e.id) || 0) > 1 ? '#8764b8' : '#d0d4d8'])); paint();
    return status(twice.length ? `${twice.length} object(s) are in more than one dimension group (purple): check for double counting.` : 'No object is in more than one dimension group.', twice.length ? 'warn' : 'ok');
  }
  W.colorMap = new Map(W.E.map(e => [e.id, !n.get(e.id) ? '#d13438' : n.get(e.id) === 1 ? '#107c10' : '#8764b8'])); paint();
  status('Red: not measured · green: measured once · purple: measured more than once.');
}
/** Check BIM Objects: select the objects that are in no dimension group. */
function checkBim() {
  if (!V.loaded) return status('Open the 3D model first.', 'warn');
  const inGroups = new Set(allGroups().flatMap(g => g.items.map(i => i.element_id)));
  const out = W.E.filter(e => e.bb && !inGroups.has(e.id)).map(e => e.id);
  setIds(out, true);
  status(out.length ? `${out.length} object(s) with 3D geometry are not in any dimension group (selected).` : 'Every object with 3D geometry is in a dimension group.', out.length ? 'warn' : 'ok');
}

// ------------------------------------------------------------------ drawings: manager, sets, cache, saved 2D views
async function drawingManager() {
  const p = W.project; if (!p) return;
  const list = [...p.drawings.map(d => ({ d, name: d.name, type: (d.name.split('.').pop() || '').toUpperCase(), key: drawingKey(d) })),
    ...p.models.flatMap(m => m.versions.flatMap(v => (v.stats?.sheets || []).map(sh => { const d = { kind: 'sheet', versionId: v.id, index: sh.index, name: sh.name }; return { d, name: `${sh.name} (${m.name} v${v.version})`, type: 'DWFx sheet', key: drawingKey(d) }; })))];
  const here = new Set((await library.list().catch(() => [])).map(f => f.key));
  const rows = list.map((x, i) => { const s = STORE.drawing(x.key), n = (s.pages && Object.keys(s.pages).length) || 0, p1 = s.pages?.[1];
    const dims = STORE.groups().reduce((t, g) => t + (g.props.measured || []).filter(m => m.src?.key === x.key).length, 0);
    return `<tr><td>${esc(x.name)}</td><td>${esc(x.type)}</td><td>${p1?.ratio ? '1:' + p1.ratio : p1?.scale ? 'calibrated' : ''}${n > 1 ? ` (+${n - 1} pages)` : ''}</td><td>${s.multiplier !== 1 ? '×' + s.multiplier : ''}</td><td class="v">${dims}</td>
      <td>${x.d.kind === 'sheet' ? 'in the model' : x.d.location === 'local' ? (here.has(x.d.sha256) ? 'this computer' : 'not here yet') : 'server'}</td><td><button class="btn small" data-o="${i}" ${canMeasure(x.name) || x.d.kind === 'sheet' ? '' : 'disabled'}>Open</button></td></tr>`; }).join('');
  await dialog({ title: 'Drawing Manager', wide: true, body: list.length ? `<div class="dg-list"><table class="links"><thead><tr><th>Drawing</th><th>Type</th><th>Scale</th><th>Multiplier</th><th>Dimensions</th><th>File</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="hint">No drawings in this project yet.</p>',
    buttons: [{ label: 'Close', value: null }],
    onOpen: (dlg) => dlg.querySelectorAll('[data-o]').forEach(b => b.onclick = () => { dlg.querySelector('.dlg-actions button')?.click(); openDrawingCentre(list[+b.dataset.o].d); }) });
}
async function drawingSets() {
  const p = W.project; if (!p) return;
  const sets = p.project.settings?.drawingSets || [];
  const all = [...p.drawings.filter(d => canMeasure(d.name)).map(d => ({ key: drawingKey(d), name: d.name, d })),
    ...p.models.flatMap(m => m.versions.flatMap(v => (v.stats?.sheets || []).map(sh => { const d = { kind: 'sheet', versionId: v.id, index: sh.index, name: sh.name }; return { key: drawingKey(d), name: `${sh.name} (${m.name} v${v.version})`, d }; })))];
  let action = null;
  const r = await dialog({ title: 'Drawing Sets', wide: true, body: `<p class="hint">A drawing set is a named list of drawings (for example "Level 1 plans" or "Tender set"). Open a set to open all its drawings as tabs.</p>
    ${sets.map((s, i) => `<div class="zone-row"><span class="grow"><strong>${esc(s.name)}</strong> <span class="hint">${s.keys.length} drawing(s)</span></span><button class="btn small" data-os="${i}">Open</button>${canEdit() ? ` <button class="btn small subtle danger-text" data-ds="${i}">Delete</button>` : ''}</div>`).join('') || '<p class="hint">No drawing sets yet.</p>'}
    ${canEdit() ? `<h4>New set</h4><label class="field">Name<input class="input" id="dsN" maxlength="80"></label><div class="dg-list">${all.map((x, i) => `<label class="check"><input type="checkbox" data-k="${i}"> ${esc(x.name)}</label>`).join('')}</div>` : ''}`,
    buttons: canEdit() ? [{ label: 'Close', value: null }, { label: 'Save new set', value: 'save', primary: true }] : [{ label: 'Close', value: null }],
    onOpen: (dlg) => {
      dlg.querySelectorAll('[data-os]').forEach(b => b.onclick = () => { action = { open: +b.dataset.os }; dlg.querySelector('.dlg-actions button')?.click(); });
      dlg.querySelectorAll('[data-ds]').forEach(b => b.onclick = () => { action = { del: +b.dataset.ds }; dlg.querySelector('.dlg-actions button')?.click(); });
    },
    validate: (dlg) => { const name = dlg.querySelector('#dsN').value.trim(), keys = [...dlg.querySelectorAll('[data-k]:checked')].map(c => all[+c.dataset.k].key);
      if (!name || !keys.length) return 'Give the set a name and tick its drawings.'; action = { save: { name, keys } }; return ''; } });
  if (action?.open != null) { for (const k of sets[action.open].keys) { const x = all.find(y => y.key === k); if (x) await openDrawingCentre(x.d); } return; }
  const next = action?.del != null ? sets.filter((_, i) => i !== action.del) : r === 'save' && action?.save ? [...sets.filter(s => s.name !== action.save.name), action.save] : null;
  if (!next) return;
  try { const res = await api('PUT', `/projects/${W.projectId}/drawing-sets`, { sets: next }); W.project.project.settings = { ...(W.project.project.settings || {}), drawingSets: res.sets }; status('Drawing sets saved.', 'ok'); }
  catch (err) { status(err.message, 'bad'); }
}
async function drawingCache() {
  const tk = activeTk(), use = await library.usage();
  const d = tk?.d;
  const r = await dialog({ title: 'Drawing Cache', body: `<p>Drawings and models are kept on this computer and read from there; converted CAD drawings and processed models are kept too, so they open quickly.</p>
    <p class="hint">This computer's library: ${(use.used / 1048576).toFixed(1)} MB used${use.quota ? ` of ${(use.quota / 1073741824).toFixed(1)} GB` : ''}.</p>
    ${d && d.kind !== 'sheet' ? `<p>Open drawing: <strong>${esc(d.name)}</strong></p>` : ''}`,
    buttons: [{ label: 'Close', value: null }, ...(d && d.kind !== 'sheet' && /\.(dwg|dxf)$/i.test(d.name) ? [{ label: 'Read this CAD drawing again', value: 'redo' }] : [])] });
  if (r === 'redo') { await library.removeDerived(d.location === 'local' ? d.sha256 : `cloud:d:${d.id}`); closeCTab(drawingKey(d)); openDrawingCentre(d); }
}
const v2key = (tk) => 'dwfxView2d:' + tk.dkey;
function saveView2d(tk) {
  return ask('Save view', 'View name', '').then(name => {
    if (!name) return;
    let list = []; try { list = JSON.parse(localStorage.getItem(v2key(tk)) || '[]'); } catch { /* storage blocked */ }
    list = [...list.filter(v => v.name !== name), { name, page: tk.page, z: tk.z, tx: tk.tx, ty: tk.ty, rot: tk.rot }];
    try { localStorage.setItem(v2key(tk), JSON.stringify(list)); } catch { /* storage blocked */ }
    status(`View "${name}" saved for this drawing on this computer (Views tab).`, 'ok'); treeActions.setTop('views');
  });
}
export function views2d() {
  const tk = activeTk(); if (!tk) return null;
  let list = []; try { list = JSON.parse(localStorage.getItem(v2key(tk)) || '[]'); } catch { /* storage blocked */ }
  return { list, apply: async (v) => { if (v.page !== tk.page) await tk.showPage(v.page); Object.assign(tk, { z: v.z, tx: v.tx, ty: v.ty, rot: v.rot }); tk.userMoved = true; tk.apply(); },
    remove: (v) => { try { localStorage.setItem(v2key(tk), JSON.stringify(list.filter(x => x.name !== v.name))); } catch { /* storage blocked */ } } };
}

// ------------------------------------------------------------------ toolbar host (3D tools, used by the ribbon's 3D View tab)
const HOST = {
  selectedIds: () => [...W.ticked], isIsolated: () => W.isolated,
  toggleIsolate() { if (!W.isolated && !W.ticked.size) return status('Select objects first.'); W.isolated = !W.isolated; paint(); V.fit(); syncPane(); },
  hideSelected() { hideIds([...W.ticked]); },
  showAll,
  levels: () => W.levels,
  colorModes: () => [{ id: 'category', label: 'Category' }, { id: 'measured', label: 'Measured status' }, { id: 'maps', label: 'Dimension group colours (Model Maps)' }, { id: 'overlaps', label: 'Overlaps (in more than one group)' }],
  colorMode: () => W.colorMode || 'category',
  async setColorMode(id) { W.colorMode = id; if (id === 'category') colourMeasured('off'); else colourMeasured(id); },
  legend() {
    const groups = new Map();
    W.E.forEach(e => { const c = W.colorMap?.get(e.id) || W.catColor.get(e.cat); const k = W.colorMap ? c : e.cat; if (!groups.has(k)) groups.set(k, { label: W.colorMap ? c : e.cat, color: c, ids: [] }); groups.get(k).ids.push(e.id); });
    return [...groups.values()].map(g => ({ ...g, count: g.ids.length })).sort((a, b) => b.count - a.count).slice(0, 30);
  },
  selectIds(ids) { setIds(ids, true); },
  canSaveViews: () => Boolean(W.projectId),
  async views() { return W.projectId ? (await api('GET', `/projects/${W.projectId}/views`)).views : []; },
  async saveView(name) {
    try { await api('POST', `/projects/${W.projectId}/views`, { name, versionId: W.versionId, state: { camera: V.getViewState(), ticked: [...W.ticked], hidden: [...W.hidden], isolated: W.isolated, level: W.level, xray: Boolean(V.state.xray) } }); status(`View "${name}" saved.`, 'ok'); }
    catch (err) { status(err.message, 'bad'); }
  },
  applyView(v) { if (v.version_id && v.version_id !== W.versionId) status('This view was saved on another model version.', 'warn'); const s = v.state || {}; W.ticked = new Set(s.ticked || []); W.hidden = new Set(s.hidden || []); W.isolated = Boolean(s.isolated); W.level = s.level || ''; V.state.xray = Boolean(s.xray); paint(); V.setViewState(s.camera); syncPane(); showCTab('3d'); },
  async deleteView(v) { await api('DELETE', `/views/${v.id}`); },
  status,
  openWindow: null,
  takeoff: () => (W.projectId && PT ? { store: STORE, pt: PT, newGroup: () => treeActions.addGroup() } : null),
};

// ------------------------------------------------------------------ right pane: side-by-side drawing, properties, zones
function showSidePanel(on) {
  $('wside').hidden = !on; $('wgrip').hidden = !on; $('wmain').classList.toggle('split', on);
  V.resize(); RB?.refresh();
}
function renderSide() {
  const body = $('wbody'); if ($('wside').hidden) return;
  document.querySelectorAll('[data-st]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.st === W.side)));
  if (W.side === 'zones') { renderPanel(); return; }
  if (W.side === 'props') {
    const id = [...W.ticked][0], e = W.byId.get(id);
    if (!e) { body.innerHTML = '<p class="hint">Select an object in 3D to see its properties.</p>'; return; }
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
  if (!all.length) { body.innerHTML = '<p class="hint">No viewable drawings in this project yet. Add PDFs or images: right-click the Drawings tree > Add Drawings.</p>'; return; }
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
function toggleLeft(on = $('wleft').hidden) {
  $('wleft').hidden = !on; $('lgrip').hidden = !on; $('wmain').classList.toggle('left', on); V.resize(); RB?.refresh();
}
function start() {
  if (started) return; started = true;
  V = new Viewer($('vstage'), {
    onPick: (id, add) => {
      if (W.objectMode && id != null && canEdit()) { importObjects([id]); return; }       // Object mode: a click adds the object to the current group
      if (!add) W.ticked.clear();
      if (id != null) { if (add && W.ticked.has(id)) W.ticked.delete(id); else W.ticked.add(id); }
      const e = W.byId.get(id); $('pickInfo').hidden = !e; if (e) $('pickInfo').textContent = `${e.type}  [${e.id}]  ${e.level || ''}`;
      paint(); send({ type: 'pick', ids: [...W.ticked], add: false, versionId: W.versionId });
    },
    onContext: (id, x, y) => objectMenu(id, x, y),
    onBoxSelect: (ids, add) => { if (!add) W.ticked.clear(); ids.forEach(id => W.ticked.add(id)); paint(); send({ type: 'pick', ids: [...W.ticked], add: false, versionId: W.versionId }); },
    onMeasure: (t, info) => {
      $('mInfo').hidden = !t; $('mInfo').textContent = t || '';
      if (info?.distance != null) W.measure = { text: t.split(' · ')[0], value: info.distance, unit: 'm', kind: 'distance' };
      if (info?.area != null) W.measure = { text: t, value: info.area, unit: 'm2', kind: 'area' };
    },
    labelOf: (id) => { const e = W.byId.get(id); return e ? `${e.type} · ${e.level || ''} [${e.id}]` : ''; },
  });
  TB = new Toolbar($('vbar'), $('vstage'), V, HOST);
  PT = new PointTakeoff(V, STORE, { versionId: () => W.versionId, label: () => W.label, status });
  const A = { W, STORE, get V() { return V; }, get TB() { return TB; }, get PT() { return PT; }, tk: activeTk, curTab: () => curTab, canEdit, status, send, askPane,
    tree: treeActions, currentGroup, groupById, allGroups, importObjects, createGroupFor, setIds, showOnly, hideIds, showAll, isolate, paint, openVersion,
    openDrawingCentre, showCTab, closeCTab, linkCell, showLinks, follow: () => follow, setFollow, focusGroup, compareModel, colourMeasured, checkBim,
    drawingManager, drawingSets, drawingCache, saveView2d, showSidePanel: (tab) => { W.side = tab || W.side; showSidePanel(true); renderSide(); }, hideSidePanel: () => showSidePanel(false),
    toggleLeft, leftShown: () => !$('wleft').hidden, sideShown: () => !$('wside').hidden, zoomArea3d, customSet,
    propsOnAdd: () => pref('dwfxPropsOnAdd', false), setPropsOnAdd: (on) => setPref('dwfxPropsOnAdd', on),
    openSchedules: () => { send({ type: 'openSchedules', versionId: W.versionId }); status('Opening the DWFx Schedules window from Excel…'); } };
  RB = new Ribbon($('ribbon'), { tabs: RIBBON_TABS, cmds: buildCommands(A), file: () => fileMenu(A), storageKey: 'dwfxRibbonWin',
    onError: (err) => status(err.message, 'bad'), onResize: () => V.resize(), onTab: () => {} });
  renderCTabs();
  $('wPin').onclick = () => toggleLeft(false);
  $('wSideX').onclick = () => showSidePanel(false);
  document.querySelectorAll('[data-st]').forEach(b => b.onclick = () => { W.side = b.dataset.st; renderSide(); });
  grip($('wgrip'), (e) => { const w = Math.max(260, Math.min(window.innerWidth - 400, window.innerWidth - e.clientX)); $('wmain').style.setProperty('--side', w + 'px'); });
  grip($('lgrip'), (e) => { const w = Math.max(220, Math.min(window.innerWidth - 400, e.clientX)); $('wmain').style.setProperty('--left', w + 'px'); });
  grip($('hgrip'), (e) => { const r = $('wleft').getBoundingClientRect(); const h = Math.max(120, Math.min(r.height - 160, e.clientY - r.top)); $('wleft').style.setProperty('--top', h + 'px'); });
  // H hides the selected geometry (shortcut); Esc closes menus and stops Object mode
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input,select,textarea,#dialog:not([hidden]),.tk')) return;
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && W.ticked.size) { e.preventDefault(); hideIds([...W.ticked]); }
    if (e.key === 'Escape') { closeMenu(); if (W.objectMode) { W.objectMode = false; RB.refresh(); status('Object mode off.'); } }
  });
  initLinkBar();
  const dark = (() => { try { return localStorage.getItem('dwfxTheme'); } catch { return null; } })();
  if (dark === 'dark' || dark === 'light') document.documentElement.dataset.theme = dark;
  V.setTheme();
  initTree({ W, V, send, host: HOST, paint, setIds, showOnly, hideIds, isolate, setGroupColors, openVersion,
    openDrawing: openDrawingCentre, openDrawingSide, focusMeasured, lastMeasure: () => W.measure,
    onTreeChange: () => { STORE.emit('groups'); updateStatus(); RB?.refresh(); totalsSoon(); },
    onGroupSelected: (gid) => { if (follow) send({ type: 'showLinks', gid }); },
    layerSource, autoCount, uomOf, views2d, linkCell, showLinks: (gid) => showLinks(gid), isLinked, onDragStart, onDragEnd });
  initPanel({ W, send, setIds, paint });
  STORE.on(() => { RB?.refresh(); });
}
start();
window.__win = { W, get V() { return V; }, setIds, STORE, TABS, openDrawingCentre, get PT() { return PT; }, get RB() { return RB; }, focusLink, receive };       // used by the automated browser tests
L.start().then((ok) => {
  windowButtons($('wWin'), send, () => ({ camera: V?.getViewState?.(), side: $('wside').hidden ? null : W.side, left: !$('wleft').hidden }));
  if (!ok) $('vload').textContent = 'Open this window from the Excel task pane (Measure button).';
});
/** Restore the view carried from the previous window. */
function applyCarry(v) {
  if (!v) return;
  if (v.camera && V.loaded) V.setViewState(v.camera);
  if (v.left === false && !$('wleft').hidden) toggleLeft(false);
  if (v.side) { W.side = v.side; showSidePanel(true); renderSide(); }
}
export { refreshTree };
