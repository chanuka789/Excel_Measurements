// Measurement window, left pane (CostX): Drawings / Layers / Model / Views on top, Dimension Groups / Dimensions /
// Auto Count below.
// Folders can be created by the user for drawings and models, and for dimension groups. "Import Objects In" adds
// BIM dimensions to the current dimension group. Groups go to Excel as schedules (through the task pane).
import { $, esc, api, status, fmtDate } from './core.js';
import { fmt, keyOf, evaluate } from './engine.js';
import { menu, dialog, ask, confirmIt } from './wui.js';
import { MTYPES, UNIT, DETAILS, DISPLAYS, DISPLAYS_FOR, groupTotal, dimensions, groupToSpec, displayUnit, conversion, baseValue, quantityNames } from './dims.js';
import { canView } from './drawings.js';
import { canMeasure } from './takeoff2d.js';
import { addDrawings } from './localfiles.js';
import { drawingKey } from './tkstore.js';

let C;                                   // context from window.js: { W, V, paint, send, openDrawing, openProps, openVersion, setIds, ... }
const T = { folders: [], groups: [], standard: [], open: new Set(['std']), shut: new Set(), cur: null, sel: null, filter: '', dimSel: new Set(), top: 'drawings', bottom: 'groups', zones: [], waiting: null,
  selFolder: null, show: new Set() };    // show: the groups whose dimensions are drawn (the group or folder clicked in the tree)
const canEdit = () => ['owner', 'editor'].includes(C.W.project?.my_role);
const G = (id) => T.groups.find(g => g.id === id) || T.standard.find(g => g.id === id);
const folderPath = (id) => { const out = []; for (let f = T.folders.find(x => x.id === id); f; f = T.folders.find(x => x.id === f.parent_id)) out.unshift(f.name); return out.join('\\'); };
const ids = (g) => (g?.items || []).map(i => i.element_id);
const nice = (v, u) => (v == null ? '' : fmt(v, u === 'nr' ? '' : u));

// ================================================================== data
export async function loadTree() {
  if (!C.W.projectId) return;
  try {
    const [t, s] = await Promise.all([api('GET', `/projects/${C.W.projectId}/tree`), api('GET', '/dimgroups/standard')]);
    T.folders = t.folders; T.groups = t.groups; T.standard = s.groups;
    if (T.cur && !G(T.cur)) T.cur = null;
    if (T.sel && !G(T.sel)) T.sel = null;
    if (T.selFolder && !T.folders.some(f => f.id === T.selFolder)) T.selFolder = null;
  } catch (err) { status('Could not load the project tree: ' + err.message, 'bad'); }
  render();
}
async function reloadProject() { try { C.W.project = await api('GET', `/projects/${C.W.projectId}`); } catch { /* keep the old one */ } renderTop(); }
function replaceGroup(g) { const i = T.groups.findIndex(x => x.id === g.id); if (i >= 0) T.groups[i] = g; else T.groups.push(g); }
async function patchGroup(g, body, msg) {
  try { const r = await api('PATCH', `/dimgroups/${g.id}`, body); replaceGroup({ ...r.group, items: g.items }); if (msg) status(msg, 'ok'); render(); }
  catch (err) { status(err.message, 'bad'); }
}

// ================================================================== generic tree
/** nodes: [{ key, label, cols:[], icon, children, open, sel, cur, strong, swatch, onClick, onOpen, onMenu, drag:{type,id}, drop:fn(data) }]
 * columns: headings after Name ("Unit" and "UOM" are narrow); swatch: add the colour column (dimension groups). */
function tree(host, nodes, columns, { swatch = false } = {}) {
  const rows = [];
  const walk = (list, depth) => list.forEach(n => { rows.push([n, depth]); if (n.children?.length && n.open) walk(n.children, depth + 1); });
  walk(nodes, 0);
  const cc = (c) => `tr-c${/^(Unit|UOM)$/.test(c) ? ' u' : ''}`;
  host.innerHTML = `<div class="tr-head"><span>Name</span>${columns.map(c => `<span class="${cc(c)}">${esc(c)}</span>`).join('')}${swatch ? '<span class="tr-sw none"></span>' : ''}</div>
    <div class="tr-body" role="tree">${rows.map(([n, d], i) => `<div class="tr-row ${n.sel ? 'sel' : ''} ${n.cur ? 'cur' : ''} ${n.muted ? 'muted' : ''} ${n.linked ? 'linked' : ''} ${n.strong ? 'strong' : ''} ${n.icon === 'folder' ? 'fold' : ''} ${n.icon === 'folder' && !d ? 'top' : ''}" role="treeitem" tabindex="${i === 0 ? 0 : -1}" data-i="${i}"
      ${n.children?.length ? `aria-expanded="${Boolean(n.open)}"` : ''} ${n.sel ? 'aria-selected="true"' : ''} ${n.drag ? 'draggable="true"' : ''} style="--d:${d}">
      <span class="tr-tw">${n.children?.length ? (n.open ? '▾' : '▸') : ''}</span>${n.check != null ? `<input type="checkbox" class="tr-chk" ${n.check ? 'checked' : ''} aria-label="Show ${esc(n.label)}">` : ''}<span class="tr-ic tr-${n.icon || 'item'}" aria-hidden="true"></span>
      <span class="tr-l" title="${esc(n.title || n.label)}">${esc(n.label)}</span>${columns.map((c, k) => `<span class="${cc(c)}">${esc(n.cols?.[k] ?? '')}</span>`).join('')}${swatch ? `<span class="tr-sw ${n.swatch ? '' : 'none'}" ${n.swatch ? `style="background:${esc(n.swatch)}"` : ''} aria-hidden="true"></span>` : ''}</div>`).join('') || '<div class="hint tr-empty">Nothing here yet. Right-click for options.</div>'}</div>`;
  const body = host.querySelector('.tr-body');
  const rowOf = (el) => rows[+el.closest('.tr-row').dataset.i][0];
  body.querySelectorAll('.tr-row').forEach(el => {
    const n = rowOf(el);
    el.onclick = (e) => {
      if (e.target.classList.contains('tr-tw') && n.children?.length) { n.toggle?.(); return; }
      if (e.target.classList.contains('tr-chk')) { n.onCheck?.(e.target.checked); return; }
      n.onClick?.(e);
    };
    el.ondblclick = () => (n.onOpen ? n.onOpen() : n.toggle?.());
    el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); n.onClick?.(e, true); n.onMenu?.(e.clientX, e.clientY); };
    el.onkeydown = (e) => {
      const all = [...body.querySelectorAll('.tr-row')], i = all.indexOf(el);
      if (e.key === 'ArrowDown') { e.preventDefault(); all[i + 1]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); all[i - 1]?.focus(); }
      else if (e.key === 'ArrowRight' && n.children?.length && !n.open) { e.preventDefault(); n.toggle?.(); }
      else if (e.key === 'ArrowLeft' && n.open) { e.preventDefault(); n.toggle?.(); }
      else if (e.key === 'Enter') { e.preventDefault(); n.onOpen ? n.onOpen() : n.onClick?.(e); }
      else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); const r = el.getBoundingClientRect(); n.onMenu?.(r.left + 40, r.bottom); }
    };
    if (n.drag) {
      el.ondragstart = (e) => { e.dataTransfer.setData('text/plain', JSON.stringify(n.drag)); e.dataTransfer.effectAllowed = 'copyMove'; C.onDragStart?.(n.drag); };
      el.ondragend = () => C.onDragEnd?.();
    }
    if (n.drop) {
      el.ondragover = (e) => { e.preventDefault(); el.classList.add('drop'); };
      el.ondragleave = () => el.classList.remove('drop');
      el.ondrop = (e) => { e.preventDefault(); el.classList.remove('drop'); try { n.drop(JSON.parse(e.dataTransfer.getData('text/plain'))); } catch { /* not ours */ } };
    }
  });
  body.oncontextmenu = (e) => { if (!e.target.closest('.tr-row')) { e.preventDefault(); host.onEmptyMenu?.(e.clientX, e.clientY); } };
  if (host.onRootDrop) {
    body.ondragover = (e) => { if (!e.target.closest('.tr-row')) e.preventDefault(); };
    body.ondrop = (e) => { if (e.target.closest('.tr-row')) return; e.preventDefault(); try { host.onRootDrop(JSON.parse(e.dataTransfer.getData('text/plain'))); } catch { /* not ours */ } };
  }
}
const toggler = (key) => () => { T.open.has(key) ? T.open.delete(key) : T.open.add(key); render(); };

// ================================================================== top: drawings and models
function renderTop() {
  document.querySelectorAll('[data-lt]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.lt === T.top)));
  const host = $('topTree');
  if (T.top === 'model') return renderModelTab(host);
  if (T.top === 'views') return renderViewsTab(host);
  if (T.top === 'layers') return renderLayersTab(host);
  const p = C.W.project; if (!p) { host.innerHTML = '<p class="hint tr-empty">Open a project in the Excel task pane to see its drawings.</p>'; return; }
  const folders = T.folders.filter(f => f.kind === 'drawing');
  const measuredOn = new Set(T.groups.flatMap(g => (g.props.measured || []).map(m => m.src?.t === 'd' && m.src.key)).filter(Boolean));   // drawings with dimensions are bold
  const modelNode = (m) => ({ key: 'm' + m.id, label: m.name, icon: 'model', cols: ['3D'], open: T.open.has('m' + m.id), toggle: toggler('m' + m.id),
    drag: { type: 'model', id: m.id }, title: `${m.name} · ${m.versions.length} version(s)`,
    onMenu: (x, y) => menu([{ label: 'Open latest version', disabled: !m.versions.some(v => v.status === 'ready'), run: () => { const v = m.versions.find(x => x.status === 'ready'); C.openVersion(v.id, `${m.name} v${v.version}`); } },
      '-', { label: 'Change Folder...', disabled: !canEdit(), run: () => moveTo('model', m.id, m.folder_id) }, '-', { label: 'Close Menu' }], x, y),
    children: m.versions.map(v => ({ key: 'v' + v.id, label: `v${v.version} · ${v.file_name}`, icon: v.id === C.W.versionId ? 'open' : 'version', cols: [v.status === 'ready' ? 'm' : v.status],
      sel: v.id === C.W.versionId, muted: v.status !== 'ready', open: T.open.has('v' + v.id), toggle: toggler('v' + v.id),
      onOpen: () => v.status === 'ready' && C.openVersion(v.id, `${m.name} v${v.version}`),
      onMenu: (x, y) => menu([{ label: 'Open in 3D', disabled: v.status !== 'ready', run: () => C.openVersion(v.id, `${m.name} v${v.version}`) }, '-', { label: 'Close Menu' }], x, y),
      children: (v.stats?.sheets || []).map(sh => ({ key: `s${v.id}.${sh.index}`, label: 'Sheet: ' + sh.name, icon: 'sheet', cols: ['sheet'],
        onOpen: () => C.openDrawing({ kind: 'sheet', versionId: v.id, index: sh.index, name: sh.name }),
        onClick: () => C.openDrawing({ kind: 'sheet', versionId: v.id, index: sh.index, name: sh.name }) })) })) });
  const drawingNode = (d) => ({ key: 'd' + d.id, label: d.name, icon: canMeasure(d.name) ? 'drawing' : 'file', cols: [C.uomOf?.(d) ?? (d.name.split('.').pop() || '').toUpperCase()],
    drag: { type: 'drawing', id: d.id }, muted: !canMeasure(d.name), strong: measuredOn.has(drawingKey(d)),
    onClick: () => canMeasure(d.name) && C.openDrawing(d), onOpen: () => (canMeasure(d.name) ? C.openDrawing(d) : status('This file type opens outside the add-in. Download it from the task pane.')),
    onMenu: (x, y) => menu([{ label: 'Open and Measure', disabled: !canMeasure(d.name), run: () => C.openDrawing(d) },
      { label: 'Open Side by Side', disabled: !canView(d.name), run: () => C.openDrawingSide?.(d) }, '-',
      { label: 'Change Folder...', disabled: !canEdit(), run: () => moveTo('drawing', d.id, d.folder_id) }, '-', { label: 'Close Menu' }], x, y) });
  const folderNode = (f) => {
    const key = 'f' + f.id;
    return { key, label: f.name, icon: 'folder', cols: [''], open: T.open.has(key), toggle: toggler(key), drag: { type: 'folder', id: f.id },
      drop: (d) => dropOn(f.id, d, 'drawing'),
      onMenu: (x, y) => menu([
        { label: 'New Folder...', disabled: !canEdit(), run: () => newFolder('drawing', f.id) },
        { label: 'Rename Folder...', disabled: !canEdit(), run: () => renameFolder(f) },
        { label: 'Delete Folder', disabled: !canEdit(), run: () => deleteFolder(f) }, '-',
        { label: 'Add Drawings Here...', disabled: !canEdit(), run: () => uploadTo(f.id) }, '-',
        { label: 'Expand All', run: () => expandAll('drawing', true) }, { label: 'Collapse All', run: () => expandAll('drawing', false) }, '-', { label: 'Close Menu' }], x, y),
      children: [...folders.filter(x => x.parent_id === f.id).map(folderNode), ...p.models.filter(m => m.folder_id === f.id).map(modelNode), ...p.drawings.filter(d => d.folder_id === f.id).map(drawingNode)] };
  };
  const nodes = [...folders.filter(f => !f.parent_id).map(folderNode), ...p.models.filter(m => !m.folder_id).map(modelNode), ...p.drawings.filter(d => !d.folder_id).map(drawingNode)];
  host.onEmptyMenu = (x, y) => menu([{ label: 'New Folder...', disabled: !canEdit(), run: () => newFolder('drawing', null) },
    { label: 'Add Drawings...', disabled: !canEdit(), run: () => uploadTo(null) }, '-',
    { label: 'Expand All', run: () => expandAll('drawing', true) }, { label: 'Collapse All', run: () => expandAll('drawing', false) }, '-', { label: 'Close Menu' }], x, y);
  host.onRootDrop = (d) => dropOn(null, d, 'drawing');
  tree(host, nodes, ['UOM']);
}
/** Layers of the open drawing (CAD layers, PDF layers), or the categories of the 3D model. */
function renderLayersTab(host) {
  const src = C.layerSource?.();
  host.onEmptyMenu = null; host.onRootDrop = null;
  if (!src || !src.list.length) { host.innerHTML = `<p class="hint tr-empty">${esc(src?.empty || 'Open a drawing or the 3D model to see its layers.')}</p>`; return; }
  tree(host, src.list.map(l => ({ key: 'L' + l.id, label: l.name, icon: 'layer', check: l.on, cols: [l.count != null ? String(l.count) : ''],
    onCheck: (on) => { src.set(l.id, on); renderLayersTab(host); },
    onOpen: () => { src.only?.(l.id); renderLayersTab(host); },
    onMenu: (x, y) => menu([{ label: 'Show Only This Layer', run: () => { src.only?.(l.id); renderLayersTab(host); } },
      { label: 'Show All Layers', run: () => { src.all(true); renderLayersTab(host); } }, { label: 'Hide All Layers', run: () => { src.all(false); renderLayersTab(host); } },
      { label: 'Invert Layers', run: () => { src.invert(); renderLayersTab(host); } }, '-', { label: 'Close Menu' }], x, y) })), [src.countLabel || '']);
}
function renderModelTab(host) {
  const W = C.W;
  if (!W.E.length) { host.innerHTML = '<p class="hint tr-empty">No model open.</p>'; return; }
  const by = new Map();
  W.E.forEach(e => { if (!by.has(e.cat)) by.set(e.cat, new Map()); const f = by.get(e.cat); if (!f.has(e.fam)) f.set(e.fam, new Map()); const t = f.get(e.fam); if (!t.has(e.type)) t.set(e.type, []); t.get(e.type).push(e.id); });
  const all = (m) => [...m.values()].flatMap(v => (Array.isArray(v) ? v : all(v)));
  const set = (key, label, list, icon) => ({ key, label, icon, cols: [String(list.length)], onClick: () => C.setIds(list),
    onMenu: (x, y) => menu(objectActions(list, label), x, y) });
  const nodes = [...by].sort((a, b) => a[0].localeCompare(b[0])).map(([cat, fams]) => ({ ...set('c' + cat, cat, all(fams), 'cat'), open: T.open.has('c' + cat), toggle: toggler('c' + cat),
    children: [...fams].sort((a, b) => a[0].localeCompare(b[0])).map(([fam, types]) => ({ ...set(`f${cat}|${fam}`, fam, all(types), 'fam'), open: T.open.has(`f${cat}|${fam}`), toggle: toggler(`f${cat}|${fam}`),
      children: [...types].sort((a, b) => a[0].localeCompare(b[0])).map(([type, list]) => set(`t${cat}|${fam}|${type}`, type, list, 'type')) })) }));
  host.onEmptyMenu = null; host.onRootDrop = null;
  tree(host, nodes, ['Objects']);
}
async function renderViewsTab(host) {
  const v2 = C.views2d?.();
  host.onEmptyMenu = null; host.onRootDrop = null;
  if (v2) {                // a drawing is on screen: its saved zoom positions (on this computer)
    tree(host, v2.list.map(v => ({ key: 'z' + v.name, label: v.name, icon: 'view', cols: [`page ${v.page}`], onOpen: () => v2.apply(v), onClick: () => v2.apply(v),
      onMenu: (x, y) => menu([{ label: 'Apply View', run: () => v2.apply(v) }, { label: 'Delete View', run: () => { v2.remove(v); renderViewsTab(host); } }, '-', { label: 'Close Menu' }], x, y) })), ['Page']);
    if (!v2.list.length) host.querySelector('.tr-body').innerHTML = '<div class="hint tr-empty">No saved views of this drawing yet. Drawings ribbon > Save View keeps the zoom and position.</div>';
    return;
  }
  host.innerHTML = '<p class="hint tr-empty">Loading saved views…</p>';
  try {
    const views = await C.host.views();
    tree(host, views.map(v => ({ key: 'w' + v.id, label: v.name, icon: 'view', cols: [v.created_by || ''], onOpen: () => C.host.applyView(v), onClick: () => C.host.applyView(v),
      onMenu: (x, y) => menu([{ label: 'Apply View', run: () => C.host.applyView(v) }, '-', { label: 'Close Menu' }], x, y) })), ['By']);
  } catch (err) { host.innerHTML = `<p class="msg bad">${esc(err.message)}</p>`; }
}

// ================================================================== bottom: dimension groups
/** Totals of a group's custom quantities (formwork, reinforcement, waterproofing...) on the open model, cached. */
const subCache = new Map();
function customTotals(g) {
  if (!(g.props?.custom || []).length || !g.items.length) return [];
  const key = `${g.id}|${g.updated_at}|${g.items.length}|${C.W.versionId}|${JSON.stringify(g.props.custom).length}|${JSON.stringify(g.props.variables || []).length}`;
  if (subCache.has(key)) return subCache.get(key);
  let out = [];
  try {
    const spec = groupToSpec(g, C.W.byId);
    const ev = evaluate(spec, C.W.byId);
    out = spec.formulas.filter(f => /^C\d+$/.test(f.key)).map(f => ({ label: f.label, unit: f.unit, total: ev.tot[f.key] ?? 0, rule: f.rule?.ref || '' }));
  } catch (err) { out = [{ label: 'Custom quantities: ' + err.message, unit: '', total: null }]; }
  subCache.set(key, out);
  return out;
}
function groupNode(g) {
  const t = groupTotal(g, C.W.byId);
  const subs = customTotals(g), qk = 'q' + g.id;
  return { key: 'g' + g.id, label: g.name, icon: 'dg-' + g.mtype.toLowerCase(), cols: [nice(t.total, t.unit), t.unit], swatch: g.props.posColor || '#107c10',
    sel: T.sel === g.id && !T.selFolder, cur: T.cur === g.id,
    open: subs.length && !T.shut.has(qk), toggle: () => { T.shut.has(qk) ? T.shut.delete(qk) : T.shut.add(qk); render(); },
    children: subs.map((c, i) => ({ key: qk + '-' + i, label: c.label, icon: 'qty', muted: true, title: `${c.label}${c.rule ? ' · ' + c.rule : ''} (custom quantity of "${g.name}")`, cols: [nice(c.total, c.unit), c.unit],
      onClick: () => selectGroup(g.id), onOpen: () => editGroup(g, undefined, 'custom'), onMenu: (x, y) => groupMenu(g, x, y) })),
    title: `${g.name} · ${g.mtype}${t.absent ? ` · ${t.absent} not in this model` : ''}${t.missing ? ` · ${t.missing} without a ${g.mtype.toLowerCase()}` : ''}`,
    drag: { type: 'group', id: g.id }, linked: C.isLinked?.(g.id), onClick: () => selectGroup(g.id), onOpen: () => editGroup(g), onMenu: (x, y) => groupMenu(g, x, y) };
}
function renderBottom() {
  document.querySelectorAll('[data-bt]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.bt === T.bottom)));
  $('curGroup').innerHTML = `<option value="">&lt;none&gt;</option>${T.groups.map(g => `<option value="${g.id}" ${g.id === T.cur ? 'selected' : ''}>${esc([folderPath(g.folder_id), g.name].filter(Boolean).join('\\'))}</option>`).join('')}`;
  if (T.bottom === 'dims') return renderDims();
  if (T.bottom === 'auto') { const h = $('dgTree'); if (!C.autoCount?.(h)) h.innerHTML = '<div class="dock-body"><p class="hint">Auto Count finds every copy of a symbol on a drawing. Open a drawing, make a Count group current, then press <strong>Auto Count</strong> on the Dimensions ribbon.</p></div>'; return; }
  const host = $('dgTree'), q = T.filter.toLowerCase();
  const folders = T.folders.filter(f => f.kind === 'dim');
  const match = (g) => !q || g.name.toLowerCase().includes(q);
  const has = (fid) => T.groups.some(g => g.folder_id === fid && match(g)) || folders.some(f => f.parent_id === fid && has(f.id));
  const folderNode = (f) => {
    const key = 'f' + f.id;
    return { key, label: f.name, icon: 'folder', cols: ['', ''], open: T.open.has(key) || Boolean(q), toggle: toggler(key), drag: { type: 'folder', id: f.id },
      sel: T.selFolder === f.id, title: `${folderPath(f.id)} · click to show the dimensions of every group in it`,
      onClick: () => selectFolder(f.id), drop: (d) => dropOn(f.id, d, 'dim'), onMenu: (x, y) => folderMenu(f, x, y),
      children: [...folders.filter(x => x.parent_id === f.id && (!q || has(x.id))).map(folderNode), ...T.groups.filter(g => g.folder_id === f.id && match(g)).map(groupNode)] };
  };
  const std = { key: 'std', label: 'Standard', icon: 'std', cols: ['', ''], open: T.open.has('std'), toggle: toggler('std'), title: 'Standard dimension groups: the company library',
    onMenu: (x, y) => menu([{ label: 'Add Dimension Group from Standard...', disabled: !canEdit() || !T.standard.length, run: () => fromStandard() }, '-', { label: 'Close Menu' }], x, y),
    children: T.standard.filter(match).map(g => ({ key: 's' + g.id, label: g.name, icon: 'dg-' + g.mtype.toLowerCase(), cols: [g.mtype, UNIT[g.mtype]],
      onOpen: () => fromStandard(g), onMenu: (x, y) => menu([{ label: 'Add to This Project...', disabled: !canEdit(), run: () => fromStandard(g) },
        { label: 'Delete from Standard', run: async () => { if (await confirmIt('Delete standard group', `Remove "${g.name}" from the standard dimension groups?`)) { try { await api('DELETE', `/dimgroups/${g.id}`); loadTree(); } catch (err) { status(err.message, 'bad'); } } } },
        '-', { label: 'Exit Menu' }], x, y) })) };
  const nodes = [...folders.filter(f => !f.parent_id && (!q || has(f.id))).map(folderNode), ...T.groups.filter(g => !g.folder_id && match(g)).map(groupNode), std];
  host.onEmptyMenu = (x, y) => menu([{ label: 'Add Dimension Group...', disabled: !canEdit(), run: () => editGroup(null, null) },
    { label: 'New Folder...', disabled: !canEdit(), run: () => newFolder('dim', null) },
    { label: 'Add Dimension Group from Standard...', disabled: !canEdit() || !T.standard.length, run: () => fromStandard() }, '-',
    { label: 'Expand All', run: () => expandAll('dim', true) }, { label: 'Collapse All', run: () => expandAll('dim', false) }, '-', { label: 'Exit Menu' }], x, y);
  host.onRootDrop = (d) => dropOn(null, d, 'dim');
  tree(host, nodes, ['Quantity', 'Unit'], { swatch: true });
}
function folderMenu(f, x, y) {
  const inside = groupsIn(f.id);
  menu([{ label: 'Expand All', run: () => expandAll('dim', true) }, { label: 'Collapse All', run: () => expandAll('dim', false) }, '-',
    { label: 'Add Dimension Group...', disabled: !canEdit(), run: () => editGroup(null, f.id) },
    { label: 'New Folder...', disabled: !canEdit(), run: () => newFolder('dim', f.id) },
    { label: 'Rename Folder...', disabled: !canEdit(), run: () => renameFolder(f) },
    { label: 'Change Folder...', disabled: !canEdit(), run: () => moveTo('folder', f.id, f.parent_id, 'dim') },
    { label: 'Delete Folder', disabled: !canEdit(), run: () => deleteFolder(f) }, '-',
    { label: 'Isolate Dimension Groups', disabled: !inside.length, run: () => C.isolate(inside.flatMap(ids)) },
    { label: 'Add Folder to Excel as Schedules...', disabled: !inside.length, run: () => scheduleDialog(inside.map(g => g.id)) }, '-',
    { label: 'Exit Menu' }], x, y);
}
const groupsIn = (fid) => { const sub = new Set([fid]); let grew = true; while (grew) { grew = false; T.folders.forEach(f => { if (f.parent_id && sub.has(f.parent_id) && !sub.has(f.id)) { sub.add(f.id); grew = true; } }); } return T.groups.filter(g => sub.has(g.folder_id)); };
function groupMenu(g, x, y) {
  const ed = !canEdit();
  menu([{ label: 'Expand All', run: () => expandAll('dim', true) }, { label: 'Collapse All', run: () => expandAll('dim', false) }, '-',
    { label: 'Add Dimension Group...', disabled: ed, run: () => editGroup(null, g.folder_id) },
    { label: 'Copy Dimension Group...', disabled: ed, run: () => copyGroup(g) },
    { label: 'Edit Dimension Group Properties...', run: () => editGroup(g) }, '-',
    { label: 'Edit Variable Properties...', run: () => editGroup(g, undefined, 'vars') }, '-',
    { label: 'Change Folder...', disabled: ed, run: () => moveTo('group', g.id, g.folder_id, 'dim') },
    { label: 'Change Multiplier...', disabled: ed, run: () => changeProp(g, 'multiplier', 'Multiplier', 'Every dimension in the group is multiplied by this.') },
    { label: 'Change Width...', disabled: ed, run: () => changeProp(g, 'width', 'Width (m)', 'Used when a length is shown as a volume.') },
    { label: 'Change Height...', disabled: ed, run: () => changeProp(g, 'height', 'Height (m)', 'Used when a length is shown as an area, or an area as a volume.') },
    { label: 'Change Zone...', disabled: ed || !T.zones.length, title: T.zones.length ? '' : 'Create zones in the task pane first (Elements > Zones).', run: () => changeZone(g) },
    { label: 'Change Offset...', disabled: ed || g.mtype !== 'Length', title: g.mtype === 'Length' ? '' : 'Offset applies to length groups.', run: () => changeProp(g, 'offset', 'Offset (m)', 'Added to every length dimension (for example a lap or an extension).') },
    { label: 'Isolate Dimension Group', disabled: !g.items.length, run: () => C.isolate(ids(g)) }, '-',
    { label: 'Delete Dimension Group', disabled: ed, run: () => deleteGroup(g) }, '-',
    { label: 'Add to Standard Dimension Groups...', disabled: ed, run: () => toStandard(g) },
    { label: 'Add to Excel as Schedule...', disabled: !g.items.length && !(g.props.measured || []).length, run: () => scheduleDialog([g.id]) },
    { label: 'Link to Selected Excel Cell', title: 'Select a cell in Excel first. The cell gets a live formula with this group\'s total.', run: () => C.linkCell?.({ type: 'group', id: g.id }) },
    { label: 'Show Linked Cells in Excel', disabled: !C.isLinked?.(g.id), run: () => C.showLinks?.(g.id) }, '-',
    { label: 'Exit Menu' }], x, y);
}
export function selectGroup(id, { current = true } = {}) {
  T.sel = id; if (current) T.cur = id; T.dimSel.clear();
  T.selFolder = null;                     // only the clicked group's dimensions are drawn
  if (id) C.onGroupSelected?.(id);
  const g = G(id);
  for (let f = T.folders.find(x => x.id === g?.folder_id); f; f = T.folders.find(x => x.id === f.parent_id)) T.open.add('f' + f.id);   // show it in the tree
  if (g && g.items.length) C.setGroupColors(g); else C.setGroupColors(null);
  render();
}
/** Click on a dimension group folder: the dimensions of every group in it (and its sub-folders) are drawn. */
function selectFolder(fid) {
  T.selFolder = fid; T.sel = null; T.dimSel.clear();
  render();
}
function render() {
  T.show = new Set(T.selFolder ? groupsIn(T.selFolder).map(g => g.id) : T.sel ? [T.sel] : []);
  renderTop(); renderBottom(); renderStatusBar(); C.onTreeChange?.();
}
export function refresh() { render(); }

// ================================================================== dimensions tab
function renderDims() {
  const host = $('dgTree'), g = G(T.cur);
  if (!g) { host.innerHTML = '<p class="hint tr-empty">Choose the current dimension group (above) to see its dimensions.</p>'; return; }
  const dims = dimensions(g, C.W.byId), u = displayUnit(g);
  const q = T.filter.toLowerCase();
  const rows = dims.map((d, i) => ({ d, i, key: d.kind === 'bim' ? 'b' + d.item.element_id : 'm' + d.item.id,
    label: d.kind === 'bim' ? (d.e ? `${d.e.type} [${d.e.id}]` : `[${d.item.element_id}]`) : d.item.label, level: d.e?.level || (d.kind === 'measured' ? (d.item.src?.name || d.item.kind) : '') }))
    .filter(r => !q || r.label.toLowerCase().includes(q));
  host.innerHTML = `<div class="dims-bar"><strong>${esc(g.name)}</strong> <span class="hint">${dims.length} dimension(s)</span>
      <button class="btn small" id="dimAddM" ${canEdit() ? '' : 'disabled'} title="Add the last distance or face area measured in 3D, or type a value">Add measured…</button></div>
    <table class="q dims"><thead><tr><th>#</th><th>Dimension</th><th>Level / kind</th><th style="text-align:right">${esc(g.mtype)}</th><th style="text-align:right">Qty (${esc(u)})</th></tr></thead>
    <tbody>${rows.slice(0, 2000).map(r => `<tr data-k="${esc(r.key)}" draggable="true" class="${T.dimSel.has(r.key) ? 'sel' : ''} ${r.d.qty != null && r.d.qty < 0 ? 'neg' : ''} ${r.d.missing ? 'muted' : ''}" tabindex="-1">
      <td>${r.i + 1}</td><td title="${esc(r.label)}">${esc(r.label)}${r.d.item.multiplier !== 1 && r.d.item.multiplier != null ? ` <span class="hint">×${r.d.item.multiplier}</span>` : ''}</td><td title="${esc(r.level || '')}">${esc(r.level || '')}</td>
      <td class="v">${r.d.missing ? `<span class="hint">${esc(r.d.missing)}</span>` : esc(nice(r.d.base, UNIT[g.mtype]))}</td><td class="v">${esc(nice(r.d.qty, u))}</td></tr>`).join('')}</tbody></table>
    ${rows.length > 2000 ? `<p class="hint">Showing 2,000 of ${rows.length}.</p>` : ''}`;
  const byKey = new Map(rows.map(r => [r.key, r]));
  host.querySelectorAll('tr[data-k]').forEach(tr => {
    const r = byKey.get(tr.dataset.k);
    tr.onclick = (e) => {
      if (!(e.ctrlKey || e.metaKey)) T.dimSel.clear();
      T.dimSel.has(r.key) && (e.ctrlKey || e.metaKey) ? T.dimSel.delete(r.key) : T.dimSel.add(r.key);
      const sel = [...T.dimSel].filter(k => k.startsWith('b')).map(k => Number(k.slice(1))).filter(id => C.W.byId.has(id));
      if (sel.length) C.setIds(sel, true);
      if (r.d.kind === 'measured' && r.d.item.src && !(e.ctrlKey || e.metaKey)) C.focusMeasured?.(r.d.item);   // show it on its drawing or in 3D
      renderDims();
    };
    tr.oncontextmenu = (e) => { e.preventDefault(); if (!T.dimSel.has(r.key)) { T.dimSel.clear(); T.dimSel.add(r.key); renderDims(); } dimMenu(g, e.clientX, e.clientY); };
    const drag = r.d.kind === 'measured' ? { type: 'dim', gid: g.id, mid: r.d.item.id } : { type: 'dim', gid: g.id, eid: r.d.item.element_id };
    tr.ondragstart = (e) => { e.dataTransfer.setData('text/plain', JSON.stringify(drag)); e.dataTransfer.effectAllowed = 'copy'; C.onDragStart?.(drag); };
    tr.ondragend = () => C.onDragEnd?.();
    tr.ondblclick = () => C.linkCell?.(drag);
  });
  $('dimAddM').onclick = () => addMeasured(g);
}
function dimMenu(g, x, y) {
  const keys = [...T.dimSel], bim = keys.filter(k => k.startsWith('b')).map(k => Number(k.slice(1))), man = keys.filter(k => k.startsWith('m')).map(k => k.slice(1));
  const ed = !canEdit();
  const setItems = async (body) => {
    try {
      if (bim.length) { const r = await api('PATCH', `/dimgroups/${g.id}/items`, { ids: bim, ...body }); replaceGroup(r.group); }
      if (man.length) {
        const measured = (G(g.id).props.measured || []).map(m => (man.includes(m.id) ? { ...m, ...(body.sign != null ? { sign: body.sign } : {}), ...(body.multiplier != null ? { multiplier: body.multiplier } : {}) } : m));
        await patchGroup(G(g.id), { props: { measured } });
      }
      render(); C.setGroupColors(G(g.id));
    } catch (err) { status(err.message, 'bad'); }
  };
  const one = keys.length === 1 ? (man[0] ? { type: 'dim', gid: g.id, mid: man[0] } : { type: 'dim', gid: g.id, eid: bim[0] }) : null;
  menu([{ label: `Select in 3D (${bim.length})`, disabled: !bim.length, run: () => C.setIds(bim, true) },
    { label: 'Link to Selected Excel Cell', disabled: !one, title: 'Select a cell in Excel first: it gets a live formula with this dimension\'s quantity.', run: () => C.linkCell?.(one) },
    { label: 'Delete Dimension' + (keys.length > 1 ? 's' : ''), disabled: ed, run: async () => {
      try {
        if (bim.length) { const r = await api('POST', `/dimgroups/${g.id}/items/remove`, { ids: bim }); replaceGroup(r.group); }
        if (man.length) await patchGroup(G(g.id), { props: { measured: (G(g.id).props.measured || []).filter(m => !man.includes(m.id)) } });
        T.dimSel.clear(); status(`${keys.length} dimension(s) deleted.`, 'ok'); render(); C.setGroupColors(G(g.id));
      } catch (err) { status(err.message, 'bad'); }
    } },
    '-', { label: 'Change Multiplier...', disabled: ed, run: async () => { const v = await ask('Change multiplier', 'Multiplier for the chosen dimensions', '1', { type: 'number' }); if (v != null) setItems({ multiplier: v }); } },
    { label: 'Make Negative (Deduction)', disabled: ed, run: () => setItems({ sign: -1 }) },
    { label: 'Make Positive', disabled: ed, run: () => setItems({ sign: 1 }) }, '-', { label: 'Exit Menu' }], x, y);
}
async function addMeasured(g) {
  const last = C.lastMeasure();
  const unit = UNIT[g.mtype];
  const r = await dialog({ title: 'Add measured dimension', body: `
    ${last ? `<p class="hint">Last 3D measurement: <strong>${esc(last.text)}</strong></p>` : '<p class="hint">Tip: measure a distance or a face area in 3D first (Measure tool), then come back here.</p>'}
    <label class="field">Description<input class="input" id="mmL" value="${esc(last ? last.text : '')}"></label>
    <div class="two"><label class="field">Value (${esc(unit)})<input class="input" id="mmV" type="number" step="any" value="${last && last.unit === unit ? last.value.toFixed(3) : ''}"></label>
    <label class="field">Type<select class="input" id="mmS"><option value="1">Positive</option><option value="-1">Negative (deduction)</option></select></label></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add', value: 'ok', primary: true }],
    validate: (d) => (Number.isFinite(Number(d.querySelector('#mmV').value)) && d.querySelector('#mmV').value !== '' ? '' : 'Enter the value.'),
    onOpen: (d) => { r0 = d; } });
  if (!r) return;
  const m = { label: r0.querySelector('#mmL').value || 'Measured dimension', value: Number(r0.querySelector('#mmV').value), unit, kind: last ? last.kind : 'manual', sign: Number(r0.querySelector('#mmS').value), multiplier: 1 };
  await patchGroup(g, { props: { measured: [...(g.props.measured || []), m] } }, 'Measured dimension added.');
}
let r0 = null;

// ================================================================== status bar (current group, GFA)
function renderStatusBar() {
  const el = $('stMain') || $('wstat'); if (!el) return;
  const g = G(T.cur), parts = [];
  if (g) { const t = groupTotal(g, C.W.byId); parts.push(`${g.mtype === 'Count' ? 'Count' : conversionName(g)} = ${nice(t.total, t.unit)} ${t.unit}  (${esc(g.name)})`); }
  const gfa = T.groups.filter(x => x.props.gfa).map(x => groupTotal(x, C.W.byId)).filter(t => t.unit === 'm2').reduce((s, t) => s + t.total, 0);
  if (T.groups.some(x => x.props.gfa)) parts.push(`GFA = ${nice(gfa, 'm2')} m2`);
  el.textContent = parts.join('     ');
}
const conversionName = (g) => conversion(g).display;

// ================================================================== folders, moving
async function newFolder(kind, parentId) {
  const name = await ask('New folder', 'Folder name', '', { okLabel: 'Create', hint: 'Type a path such as 2026-09-25 SD 50%\\Hardscape\\Paving to create the folders inside each other.' }); if (!name) return;
  try { const id = await folderFromPath(kind, name, parentId); openTo(id); render(); status(`Folder "${folderPath(id)}" created.`, 'ok'); }
  catch (err) { status(err.message, 'bad'); }
}
const splitPath = (path) => String(path || '').split('\\').map(x => x.trim()).filter(Boolean);
/** The folder at a path such as "2026-09-25 SD 50%\Hardscape\Paving" (null: top level). Folders that do not exist yet are created. */
async function folderFromPath(kind, path, parentId = null) {
  let parent = parentId;
  for (const name of splitPath(path)) {
    let f = T.folders.find(x => x.kind === kind && (x.parent_id || null) === parent && x.name.toLowerCase() === name.toLowerCase());
    if (!f) { f = (await api('POST', `/projects/${C.W.projectId}/folders`, { kind, name, parentId: parent })).folder; T.folders.push(f); }
    parent = f.id;
  }
  return parent;
}
/** Is there a folder at this path already? */
const folderAt = (kind, path) => {
  let parent = null;
  for (const name of splitPath(path)) {
    const f = T.folders.find(x => x.kind === kind && (x.parent_id || null) === parent && x.name.toLowerCase() === name.toLowerCase());
    if (!f) return undefined;
    parent = f.id;
  }
  return parent;
};
const openTo = (fid) => { for (let f = T.folders.find(x => x.id === fid); f; f = T.folders.find(x => x.id === f.parent_id)) T.open.add('f' + f.id); };
async function renameFolder(f) {
  const name = await ask('Rename folder', 'Folder name', f.name, { okLabel: 'Rename' }); if (!name) return;
  try { await api('PATCH', `/folders/${f.id}`, { name }); f.name = name; render(); } catch (err) { status(err.message, 'bad'); }
}
async function deleteFolder(f) {
  if (!await confirmIt('Delete folder', `Delete the folder "${f.name}"? Everything inside it moves up one level; nothing else is deleted.`)) return;
  try { await api('DELETE', `/folders/${f.id}`); await Promise.all([loadTree(), reloadProject()]); status('Folder deleted.', 'ok'); } catch (err) { status(err.message, 'bad'); }
}
function folderOptions(kind, current, exclude) {
  const list = T.folders.filter(f => f.kind === kind && f.id !== exclude).map(f => [f.id, folderPath(f.id)]).sort((a, b) => a[1].localeCompare(b[1]));
  return `<option value="">(top level)</option>${list.map(([id, p]) => `<option value="${id}" ${id === current ? 'selected' : ''}>${esc(p)}</option>`).join('')}`;
}
async function moveTo(type, id, current, kind = 'drawing') {
  let pick = null;
  const r = await dialog({ title: 'Change folder', body: `<label class="field">Folder<select class="input" id="mvF">${folderOptions(kind, current, type === 'folder' ? id : null)}</select></label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Move', value: 'ok', primary: true }], validate: (d) => { pick = d.querySelector('#mvF').value || null; return ''; } });
  if (r) await dropOn(pick, { type, id }, kind);
}
async function dropOn(folderId, d, kind) {
  if (!canEdit() || !d?.type) return;
  try {
    if (d.type === 'folder') { if (d.id === folderId) return; await api('PATCH', `/folders/${d.id}`, { parentId: folderId }); await loadTree(); }
    else if (d.type === 'group' && kind === 'dim') { const g = G(d.id); await patchGroup(g, { folderId }); }
    else if (d.type === 'model' && kind === 'drawing') { await api('PATCH', `/models/${d.id}/folder`, { folderId }); await reloadProject(); }
    else if (d.type === 'drawing' && kind === 'drawing') { await api('PATCH', `/drawings/${d.id}/folder`, { folderId }); await reloadProject(); }
    else return;
    if (folderId) T.open.add('f' + folderId);
    render(); status('Moved.', 'ok');
  } catch (err) { status(err.message, 'bad'); }
}
function expandAll(kind, on) {
  T.folders.filter(f => f.kind === kind).forEach(f => (on ? T.open.add('f' + f.id) : T.open.delete('f' + f.id)));
  if (kind === 'drawing') (C.W.project?.models || []).forEach(m => (on ? T.open.add('m' + m.id) : T.open.delete('m' + m.id)));
  if (kind === 'dim') on ? T.open.add('std') : T.open.delete('std');
  render();
}
function uploadTo(folderId) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true;
  inp.accept = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.svg,.dwfx,.dwf,.dwg,.dxf,.xlsx,.docx';
  inp.onchange = async () => {
    if (!inp.files.length) return;
    try {
      status('Adding the files (they stay on this computer)…');
      await addDrawings(C.W.projectId, [...inp.files], { folderId });
      await reloadProject(); if (folderId) T.open.add('f' + folderId); render(); status(`${inp.files.length} file(s) added. They stay on this computer.`, 'ok');
    } catch (err) { status(err.message, 'bad'); }
  };
  inp.click();
}

// ================================================================== dimension group actions
async function changeProp(g, key, label, hint) {
  const v = await ask(`Change ${label.replace(/ \(.*/, '').toLowerCase()}`, label, String(g.props[key] ?? (key === 'multiplier' ? 1 : 0)), { type: 'number', hint });
  if (v != null) await patchGroup(g, { props: { [key]: v } }, `${label.replace(/ \(.*/, '')} changed for "${g.name}".`);
}
async function changeZone(g) {
  let pick = null;
  const r = await dialog({ title: 'Change zone', body: `<label class="field">Zone<select class="input" id="zn"><option value="">(none)</option>${T.zones.map(z => `<option ${z.name === g.props.zone ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}</select></label>`,
    validate: (d) => { pick = d.querySelector('#zn').value; return ''; } });
  if (r) await patchGroup(g, { props: { zone: pick || '' } }, 'Zone changed.');
}
async function deleteGroup(g) {
  if (!await confirmIt('Delete dimension group', `Delete "${g.name}" and its ${g.items.length + (g.props.measured || []).length} dimension(s)? Tables already in Excel stay.`)) return;
  try { await api('DELETE', `/dimgroups/${g.id}`); T.groups = T.groups.filter(x => x.id !== g.id); if (T.cur === g.id) { T.cur = null; C.setGroupColors(null); } render(); status('Dimension group deleted.', 'ok'); }
  catch (err) { status(err.message, 'bad'); }
}
async function copyGroup(g) {
  let v = null;
  const r = await dialog({ title: 'Copy dimension group', body: `<label class="field">New name<input class="input" id="cpN" value="${esc(g.name + ' (copy)')}"></label>
    <label class="field">Folder<select class="input" id="cpF">${folderOptions('dim', g.folder_id)}</select></label>
    <label class="check"><input type="checkbox" id="cpD"> Copy the dimensions too</label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Copy', value: 'ok', primary: true }],
    validate: (d) => { v = { name: d.querySelector('#cpN').value.trim(), folderId: d.querySelector('#cpF').value || null, withDimensions: d.querySelector('#cpD').checked }; return v.name ? '' : 'Give it a name.'; } });
  if (!r) return;
  try { const res = await api('POST', `/dimgroups/${g.id}/copy`, v); T.groups.push(res.group); selectGroup(res.group.id); status(`Copied to "${v.name}".`, 'ok'); } catch (err) { status(err.message, 'bad'); }
}
async function toStandard(g) {
  const name = await ask('Add to standard dimension groups', 'Name in the library', g.name, { okLabel: 'Add', hint: 'The method (type, display, multiplier, sizes, custom quantities, variables) is saved for every project. Dimensions are not copied.' });
  if (!name) return;
  try { const r = await api('POST', `/dimgroups/${g.id}/standard`, { name }); await loadTree(); status(r.replaced ? `Standard group "${name}" updated.` : `"${name}" added to the standard dimension groups.`, 'ok'); }
  catch (err) { status(err.message, 'bad'); }
}
async function fromStandard(s) {
  if (!canEdit()) return;
  let v = null;
  const r = await dialog({ title: 'Add dimension group from standard', body: `<label class="field">Standard group<select class="input" id="fsG">${T.standard.map(x => `<option value="${x.id}" ${x.id === s?.id ? 'selected' : ''}>${esc(x.name)} (${x.mtype})</option>`).join('')}</select></label>
    <label class="field">Name in this project<input class="input" id="fsN" value="${esc((s || T.standard[0])?.name || '')}"></label>
    <label class="field">Folder<select class="input" id="fsF">${folderOptions('dim', null)}</select></label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add', value: 'ok', primary: true }],
    onOpen: (d) => { d.querySelector('#fsG').onchange = (e) => { d.querySelector('#fsN').value = T.standard.find(x => x.id === e.target.value)?.name || ''; }; },
    validate: (d) => { v = { fromStandard: d.querySelector('#fsG').value, name: d.querySelector('#fsN').value.trim(), folderId: d.querySelector('#fsF').value || null }; return v.name ? '' : 'Give it a name.'; } });
  if (!r) return;
  try { const res = await api('POST', `/projects/${C.W.projectId}/dimgroups`, v); T.groups.push(res.group); selectGroup(res.group.id); status(`"${v.name}" added. It is now the current group: right-click objects > Import Objects In.`, 'ok'); }
  catch (err) { status(err.message, 'bad'); }
}

// Colours and fill patterns of the Properties tab (the CostX names)
const COLORS = [['Black', '#000000'], ['Maroon', '#800000'], ['Green', '#008000'], ['Olive', '#808000'], ['Navy', '#000080'], ['Purple', '#800080'], ['Teal', '#008080'],
  ['Gray', '#808080'], ['Silver', '#c0c0c0'], ['Red', '#ff0000'], ['Lime', '#00ff00'], ['Yellow', '#ffff00'], ['Blue', '#0000ff'], ['Fuchsia', '#ff00ff'], ['Aqua', '#00ffff'],
  ['White', '#ffffff'], ['Orange', '#ffa500'], ['Brown', '#a52a2a']];
const PATTERNS = ['Solid', 'Hatch', 'Cross Hatch', 'Outline'];
const randomNamed = (not = []) => { const list = COLORS.filter(c => !['#000000', '#ffffff', '#ff0000', ...not.map(x => String(x).toLowerCase())].includes(c[1])); return list[Math.floor(Math.random() * list.length)][1]; };
/** A number with at least n decimals ("1.000000"), never rounded. */
const fixed = (v, n) => { const t = String(Number(v) || 0); return (t.split('.')[1] || '').length > n ? t : (Number(v) || 0).toFixed(n); };
const nameTaken = (name, id) => T.groups.some(x => x.id !== id && x.name.trim().toLowerCase() === name.trim().toLowerCase());
/** The name, or the name with a number added when another group already has it. */
const freeName = (name) => { if (!nameTaken(name)) return name; let n = 2; while (nameTaken(`${name} ${n}`)) n++; return `${name} ${n}`; };

/** Properties dialog ("Dimension Group Properties"); g = null creates a new group. */
export async function editGroup(g, folderId, tab = 'props', { importIds = null, name = '', mtype = '' } = {}) {
  const isNew = !g;
  const W = C.W;
  const pos = randomNamed();
  const work = JSON.parse(JSON.stringify(g || { id: null, name: freeName(name), mtype: mtype || 'Area', folder_id: folderId ?? (T.selFolder || G(T.sel)?.folder_id || null), items: [], props: {} }));
  work.props = { multiplier: 1, width: 0, height: 0, offset: 0, posColor: pos, negColor: '#ff0000', posPattern: 'Solid', negPattern: 'Solid', custom: [], variables: [], measured: [], ...work.props };
  work.path = folderPath(work.folder_id);
  const locked = () => Boolean(work.items.length || work.props.measured.length);      // the type stays once a group has dimensions
  const removed = new Set();
  const qNames = () => {
    const unit = UNIT[work.mtype], seen = new Map();
    const els = (importIds || ids(work)).map(id => W.byId.get(id)).filter(Boolean);
    (els.length ? els : W.E).slice(0, 5000).forEach(e => Object.entries(e.q || {}).forEach(([n, [, u]]) => { if (u === unit) seen.set(n, (seen.get(n) || 0) + 1); }));
    return [...seen].sort((a, b) => b[1] - a[1]).map(x => x[0]);
  };
  const ro = !canEdit() ? 'disabled' : '';
  const body = document.createElement('div');
  body.innerHTML = `<nav class="tabs dg-tabs" role="tablist">${[['props', 'Properties'], ['custom', 'Custom Quantities'], ['vars', 'Variables'], ['bim', 'BIM Dimensions'], ['meas', 'Measured Dimensions']]
    .map(([k, l]) => `<button role="tab" data-dt="${k}" aria-selected="${k === tab}">${l}</button>`).join('')}</nav><div class="dg-pane"></div>`;
  const pane = body.querySelector('.dg-pane');
  let cur = tab;
  const read = () => {     // copy form values into "work"
    const v = (id) => pane.querySelector('#' + id);
    if (cur === 'props') {
      work.name = v('dgN').value.trim(); work.path = splitPath(v('dgF').value).join('\\'); work.mtype = v('dgT').value;
      Object.assign(work.props, { display: v('dgD').value, multiplier: Number(v('dgM').value) || 0, width: Number(v('dgW').value) || 0,
        height: Number(v('dgH').value) || 0, offset: Number(v('dgO').value) || 0, gfa: v('dgG').checked, posColor: v('dgPC').value, negColor: v('dgNC').value,
        posPattern: v('dgPP').value, negPattern: v('dgNP').value, weightUom: v('dgU').value });
    } else if (cur === 'bim') {
      work.props.quantity = v('dgQ').value || undefined;
    } else if (cur === 'custom') {
      work.props.custom = [...pane.querySelectorAll('tr[data-r]')].map(tr => { const was = work.props.custom[+tr.dataset.r] || {}, expr = tr.querySelector('[data-f=expr]').value.trim();
        return { label: tr.querySelector('[data-f=label]').value.trim(), unit: tr.querySelector('[data-f=unit]').value.trim(), expr, ...(was.rule && was.expr === expr ? { rule: was.rule } : {}) }; }).filter(c => c.label || c.expr);
    } else if (cur === 'vars') {
      work.props.variables = [...pane.querySelectorAll('tr[data-r]')].map(tr => ({ name: tr.querySelector('[data-f=name]').value.trim(), value: Number(tr.querySelector('[data-f=value]').value) || 0, unit: tr.querySelector('[data-f=unit]').value.trim() })).filter(x => x.name);
    } else if (cur === 'meas') {
      work.props.measured = [...pane.querySelectorAll('tr[data-r]')].map(tr => ({ ...(work.props.measured[+tr.dataset.r] || { id: Math.random().toString(36).slice(2, 10), kind: 'manual', multiplier: 1 }),
        label: tr.querySelector('[data-f=label]').value.trim() || 'Measured dimension', value: Number(tr.querySelector('[data-f=value]').value) || 0, sign: Number(tr.querySelector('[data-f=sign]').value) })).filter(m => m.value || m.label !== 'Measured dimension');
    }
  };
  const preview = () => {
    const out = pane.querySelector('#dgPrev'); if (!out) return;
    try {
      const live = { ...work, items: work.items.filter(i => !removed.has(i.element_id)) };
      const spec = groupToSpec(live, W.byId, {}); const ev = evaluate(spec, W.byId);
      out.innerHTML = spec.formulas.filter(f => f.key.startsWith('C')).map(f => `<div>${esc(f.label)}: <strong>${esc(nice(ev.tot[f.key] ?? 0, f.unit))} ${esc(f.unit)}</strong> <span class="hint">(model objects only)</span></div>`).join('') || '<span class="hint">No custom quantities yet.</span>';
    } catch (err) { out.innerHTML = `<span class="msg bad">${esc(err.message)}</span>`; }
  };
  const draw = () => {
    body.querySelectorAll('[data-dt]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.dt === cur)));
    const p = work.props;
    if (cur === 'props') {
      const allowed = DISPLAYS_FOR[work.mtype] || [work.mtype];
      const display = allowed.includes(p.display) ? p.display : work.mtype;
      const num = (id, v, n, unit) => `<span class="dgp-num"><input class="input" id="${id}" type="number" step="any" value="${fixed(v, n)}" ${ro}>${unit ? `<span>${unit}</span>` : ''}</span>`;
      const colour = (k, label) => {
        const col = String(p[k + 'Color']).toLowerCase(), known = COLORS.some(c => c[1] === col), pat = p[k + 'Pattern'] || (k === 'neg' ? 'Hatch' : 'Solid');
        return `<label for="dg${k[0].toUpperCase()}C">${label}</label><span class="dgp-col">
          <span class="dgp-pick"><span class="dgp-sw" style="background:${esc(col)}" aria-hidden="true"></span><select class="input" id="dg${k[0].toUpperCase()}C" ${ro}>${COLORS.map(([n, c]) => `<option value="${c}" ${c === col ? 'selected' : ''}>${n}</option>`).join('')}${known ? '' : `<option value="${esc(col)}" selected>Custom</option>`}<option value="pick">More colours...</option></select></span>
          <span class="dgp-pick"><span class="dgp-sw pat-${pat.replace(' ', '-').toLowerCase()}" style="--c:${esc(col)}" aria-hidden="true"></span><select class="input" id="dg${k[0].toUpperCase()}P" aria-label="${label.replace(':', '')} pattern" ${ro}>${PATTERNS.map(x => `<option ${x === pat ? 'selected' : ''}>${x}</option>`).join('')}</select></span>
          <button type="button" class="btn small subtle dgp-rnd" data-rnd="${k}" title="Another colour" aria-label="Another colour for ${label.replace(':', '').toLowerCase()}" ${ro}>⟳</button>
          <input type="color" id="dg${k[0].toUpperCase()}X" value="${esc(col)}" hidden tabindex="-1"></span>`;
      };
      pane.innerHTML = `<div class="dgp-form">
        <label for="dgN">Name:</label><input class="input" id="dgN" value="${esc(work.name)}" ${ro} autofocus maxlength="200">
        <label for="dgF">Folder:</label><span class="dgp-combo"><input class="input" id="dgF" value="${esc(work.path)}" placeholder="(top level)" ${ro} autocomplete="off" title="Choose a folder, or type a path such as 2026-09-25 SD 50%\\Hardscape\\Paving (new folders are created)"><button type="button" class="dgp-dd" id="dgFB" aria-label="Choose a folder" ${ro}>▾</button></span>
        <label for="dgT">Measurement Type:</label><select class="input" id="dgT" ${locked() || ro ? 'disabled' : ''}>${[...MTYPES].sort().map(m => `<option ${m === work.mtype ? 'selected' : ''}>${m}</option>`).join('')}</select>
        <label for="dgD">Default Display:</label><select class="input" id="dgD" ${ro}>${DISPLAYS.map(m => `<option ${m === display ? 'selected' : ''} ${allowed.includes(m) ? '' : 'disabled'}>${m}</option>`).join('')}</select>
        <label for="dgM">Default Multiplier:</label>${num('dgM', p.multiplier, 6, '')}
        <label for="dgW">Default Width:</label>${num('dgW', p.width, 4, 'm')}
        <label for="dgH">Default Height:</label>${num('dgH', p.height, 4, 'm')}
        <label for="dgO">Default Offset:</label>${num('dgO', p.offset, 4, 'm')}
        <label for="dgG">Add To GFA:</label><span><input type="checkbox" id="dgG" ${p.gfa ? 'checked' : ''} ${ro}></span>
        ${colour('pos', 'Positive Dimensions:')}
        ${colour('neg', 'Negative Dimensions:')}
        <label for="dgU">Weight UOM:</label><select class="input dgp-short" id="dgU" ${ro}>${['', 'kg', 't'].map(u => `<option ${u === (p.weightUom || '') ? 'selected' : ''}>${u}</option>`).join('')}</select>
        <label>Date Added:</label><span>${g ? esc(fmtDate(g.created_at)) : ''}</span>
        <label>Date Modified:</label><span>${g ? esc(fmtDate(g.updated_at)) : ''}</span></div>`;
      pane.oninput = null;
      pane.querySelector('#dgT').onchange = () => {
        const oldType = work.mtype, oldDisplay = pane.querySelector('#dgD').value;
        read();
        if (oldDisplay === oldType || !(DISPLAYS_FOR[work.mtype] || []).includes(work.props.display)) work.props.display = work.mtype;     // the display follows the type unless it was changed on purpose
        if (work.mtype !== oldType) work.props.quantity = undefined;
        draw();
      };
      pane.querySelector('#dgFB').onclick = (e) => {
        const r = e.currentTarget.getBoundingClientRect(), inp = pane.querySelector('#dgF');
        const paths = T.folders.filter(f => f.kind === 'dim').map(f => folderPath(f.id)).sort((a, b) => a.localeCompare(b));
        menu([{ label: '(top level)', checked: !inp.value, run: () => { inp.value = ''; inp.focus(); } }, ...(paths.length ? ['-'] : []),
          ...paths.map(x => ({ label: x, checked: x === inp.value, run: () => { inp.value = x; inp.focus(); } }))], r.right - 320, r.bottom + 2);
      };
      for (const k of ['P', 'N']) {
        const sel = pane.querySelector(`#dg${k}C`), pick = pane.querySelector(`#dg${k}X`);
        const set = (c) => {
          if (!COLORS.some(x => x[1] === c)) { let o = [...sel.options].find(x => x.textContent === 'Custom'); if (!o) { o = new Option('Custom', c); sel.add(o, sel.options.length - 1); } o.value = c; }
          sel.value = c; pick.value = c; read(); draw();
        };
        let was = sel.value;
        sel.onfocus = () => { was = sel.value; };
        sel.onchange = () => { if (sel.value === 'pick') { sel.value = was; pick.click(); } else set(sel.value); };
        pick.onchange = () => set(pick.value.toLowerCase());
        pane.querySelector(`#dg${k}P`).onchange = () => { read(); draw(); };
      }
      pane.querySelectorAll('[data-rnd]').forEach(b => b.onclick = () => {
        read(); const k = b.dataset.rnd; work.props[k + 'Color'] = randomNamed([work.props.posColor, work.props.negColor]); draw();
      });
    } else if (cur === 'custom') {
      const keys = new Set(); ids(work).slice(0, 3000).forEach(id => Object.keys(W.byId.get(id)?.q || {}).forEach(n => keys.add(keyOf(n))));
      pane.innerHTML = `<p class="hint">Formulas for each dimension, written to Excel as live formulas. Use {Qty} (the dimension quantity), {Base}, {Width}, {Height}, {Multiplier}, your variables and the BIM quantities of the objects, e.g. <code>{Geo_side_area} + {Geo_bottom_area}</code>.</p>
        <table class="q edit"><thead><tr><th>Name</th><th>Unit</th><th>Formula</th><th></th></tr></thead><tbody>${p.custom.map((c, i) => `<tr data-r="${i}">
          <td><input class="input" data-f="label" value="${esc(c.label)}" ${ro}></td><td><input class="input" data-f="unit" value="${esc(c.unit)}" style="width:60px" ${ro}></td>
          <td><input class="input" data-f="expr" value="${esc(c.expr)}" ${ro}></td><td><button class="btn small subtle" data-del="${i}" aria-label="Remove" ${ro}>×</button></td></tr>`).join('')}</tbody></table>
        <button class="btn small" id="dgAddC" ${ro}>Add custom quantity</button>
        <div id="dgPrev" class="dg-prev"></div>
        <details><summary>Available names (${keys.size + 6})</summary><div class="chips">${['Qty', 'Base', 'Width', 'Height', 'Multiplier', 'Offset', ...p.variables.map(v => keyOf(v.name)), ...[...keys].sort()].map(k => `<code>{${esc(k)}}</code>`).join(' ')}</div></details>`;
      pane.querySelector('#dgAddC').onclick = () => { read(); work.props.custom.push({ label: '', unit: 'm2', expr: '' }); draw(); };
      pane.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { read(); work.props.custom.splice(+b.dataset.del, 1); draw(); });
      pane.oninput = () => { read(); preview(); };
      preview();
    } else if (cur === 'vars') {
      pane.innerHTML = `<p class="hint">Variables are assumptions (yellow cells in Excel) your custom quantities can use, e.g. Waste = 1.05.</p>
        <table class="q edit"><thead><tr><th>Name</th><th>Value</th><th>Unit</th><th></th></tr></thead><tbody>${p.variables.map((v, i) => `<tr data-r="${i}">
          <td><input class="input" data-f="name" value="${esc(v.name)}" ${ro}></td><td><input class="input" data-f="value" type="number" step="any" value="${v.value}" style="width:90px" ${ro}></td>
          <td><input class="input" data-f="unit" value="${esc(v.unit)}" style="width:70px" ${ro}></td><td><button class="btn small subtle" data-del="${i}" aria-label="Remove" ${ro}>×</button></td></tr>`).join('')}</tbody></table>
        <button class="btn small" id="dgAddV" ${ro}>Add variable</button>`;
      pane.querySelector('#dgAddV').onclick = () => { read(); work.props.variables.push({ name: '', value: 0, unit: '' }); draw(); };
      pane.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { read(); work.props.variables.splice(+b.dataset.del, 1); draw(); });
      pane.oninput = null;
    } else if (cur === 'bim') {
      const live = work.items.filter(i => !removed.has(i.element_id));
      const t = groupTotal({ ...work, items: live, props: { ...p, measured: [] } }, W.byId);
      const qs = qNames();
      pane.innerHTML = `<label class="field dgp-from">Measured from (BIM quantity)<select class="input" id="dgQ" ${ro || work.mtype === 'Count' ? 'disabled' : ''}><option value="">(automatic: ${esc(quantityNames({ mtype: work.mtype, props: {} }).slice(0, 2).join(', ') || 'one per object')})</option>${qs.map(n => `<option ${n === p.quantity ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        <p>${live.length} BIM dimension(s) · total ${esc(nice(t.total, t.unit))} ${esc(t.unit)}${t.absent ? ` · ${t.absent} not in this model` : ''}${t.missing ? ` · ${t.missing} without a value` : ''}${importIds ? ` · ${importIds.length} will be imported` : ''}</p>
        <div class="dg-list"><table class="q"><thead><tr><th></th><th>Object</th><th>Level</th><th style="text-align:right">${esc(work.mtype)}</th></tr></thead><tbody>
        ${work.items.slice(0, 1500).map(i => { const e = W.byId.get(i.element_id); return `<tr class="${removed.has(i.element_id) ? 'muted strike' : ''}"><td><input type="checkbox" data-rm="${i.element_id}" ${removed.has(i.element_id) ? '' : 'checked'} ${ro} aria-label="Keep"></td>
          <td>${esc(e ? `${e.type} [${e.id}]` : `[${i.element_id}] not in this model`)}${i.sign < 0 ? ' <span class="hint">(negative)</span>' : ''}</td><td>${esc(e?.level || '')}</td><td class="v">${esc(nice(baseValue(work, e), UNIT[work.mtype]))}</td></tr>`; }).join('')}
        </tbody></table></div><p class="hint">Untick to remove dimensions. Add objects with right-click in 3D > Import Objects In.</p>`;
      pane.querySelectorAll('[data-rm]').forEach(c => c.onchange = () => { read(); const id = Number(c.dataset.rm); c.checked ? removed.delete(id) : removed.add(id); draw(); });
      pane.querySelector('#dgQ').onchange = () => { read(); draw(); };
      pane.oninput = null;
    } else if (cur === 'meas') {
      pane.innerHTML = `<p class="hint">Dimensions measured by hand: a distance or face area from the 3D Measure tool, or a value you type. Unit: ${esc(UNIT[work.mtype])}.</p>
        <table class="q edit"><thead><tr><th>Description</th><th>Value</th><th>Type</th><th></th></tr></thead><tbody>${p.measured.map((m, i) => `<tr data-r="${i}">
          <td><input class="input" data-f="label" value="${esc(m.label)}" ${ro}></td><td><input class="input" data-f="value" type="number" step="any" value="${m.value}" style="width:100px" ${ro}></td>
          <td><select class="input" data-f="sign" ${ro}><option value="1">Positive</option><option value="-1" ${m.sign < 0 ? 'selected' : ''}>Negative</option></select></td>
          <td><button class="btn small subtle" data-del="${i}" aria-label="Remove" ${ro}>×</button></td></tr>`).join('')}</tbody></table>
        <button class="btn small" id="dgAddM" ${ro}>Add measured dimension</button>${C.lastMeasure() ? ` <button class="btn small" id="dgAddL" ${ro}>Add last 3D measurement (${esc(C.lastMeasure().text)})</button>` : ''}`;
      pane.querySelector('#dgAddM').onclick = () => { read(); work.props.measured.push({ label: '', value: 0, sign: 1 }); draw(); };
      pane.querySelector('#dgAddL') && (pane.querySelector('#dgAddL').onclick = () => { read(); const l = C.lastMeasure(); work.props.measured.push({ label: l.text, value: l.value, sign: 1, kind: l.kind }); draw(); });
      pane.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { read(); work.props.measured.splice(+b.dataset.del, 1); draw(); });
      pane.oninput = null;
    }
  };
  body.querySelectorAll('[data-dt]').forEach(b => b.onclick = () => { read(); cur = b.dataset.dt; draw(); });
  draw();
  const res = await dialog({ title: isNew ? 'Add Dimension Group' : 'Dimension Group Properties', body, wide: true, side: true, cls: 'dgp',
    buttons: canEdit() ? [{ label: isNew ? 'Add' : 'Update', value: 'ok', primary: true }, { label: 'Cancel', value: null }] : [{ label: 'Close', value: null }],
    validate: () => {
      read();
      if (!work.name) return 'Give the dimension group a name (Properties tab).';
      if (nameTaken(work.name, work.id)) return `A dimension group called "${work.name}" is already in this project. Give it a unique name.`;
      if (splitPath(work.path).some(x => x.length > 120)) return 'A folder name can have up to 120 characters.';
      const live = work.items.filter(i => !removed.has(i.element_id) && W.byId.has(i.element_id));
      if (live.length) { try { groupToSpec({ ...work, items: live }, W.byId, {}); } catch (err) { return err.message; } }
      else {      // no objects yet: check the formulas against every quantity in the model
        const ok = new Set(['Qty', 'Quantity', 'Base', 'Width', 'Height', 'Multiplier', 'Offset', 'Length', 'Area', 'Volume', 'Count',
          ...work.props.variables.map(v => keyOf(v.name)), ...work.props.custom.map((c, i) => 'C' + (i + 1))]);
        W.E.slice(0, 20000).forEach(e => Object.keys(e.q || {}).forEach(n => ok.add(keyOf(n))));
        for (const c of work.props.custom) {
          if (!c.label || !c.expr) return 'Each custom quantity needs a name and a formula.';
          const bad = [...c.expr.matchAll(/\{([A-Za-z_]\w*)\}/g)].map(m => m[1]).find(k => !ok.has(k));
          if (bad) return `Custom quantity "${c.label}" uses {${bad}}, which is not a variable or a quantity in this model.`;
        }
      }
      return '';
    } });
  if (res !== 'ok') return null;
  try {
    const isNewFolder = work.path && folderAt('dim', work.path) === undefined;
    work.folder_id = await folderFromPath('dim', work.path);
    openTo(work.folder_id);
    const payload = { name: work.name, mtype: work.mtype, folderId: work.folder_id, props: work.props };
    let saved;
    if (isNew) saved = (await api('POST', `/projects/${W.projectId}/dimgroups`, payload)).group;
    else {
      saved = (await api('PATCH', `/dimgroups/${g.id}`, payload)).group;
      if (removed.size) saved = (await api('POST', `/dimgroups/${g.id}/items/remove`, { ids: [...removed] })).group;
      else saved.items = g.items;
    }
    if (importIds?.length) saved = (await api('POST', `/dimgroups/${saved.id}/items`, { ids: importIds, versionId: W.versionId })).group;
    replaceGroup(saved); selectGroup(saved.id);
    status((isNew ? `Dimension group "${saved.name}" created${importIds?.length ? ` with ${importIds.length} object(s)` : ''}. It is the current group.` : `"${saved.name}" updated.`)
      + (isNewFolder ? ` Folder "${work.path}" created.` : ''), 'ok');
    return saved;
  } catch (err) { status(err.message, 'bad'); return null; }
}

// ================================================================== import objects, sets of objects
export async function importObjects(list) {
  if (!canEdit()) { status('You need editor access to this project to measure.', 'bad'); return; }
  const idsIn = [...new Set(list)].filter(id => C.W.byId.has(id));
  if (!idsIn.length) { status('No objects to import.', 'bad'); return; }
  let g = G(T.cur);
  if (!g) {   // a group is needed first
    const e = C.W.byId.get(idsIn[0]);
    g = await editGroup(null, null, 'props', { importIds: idsIn, name: commonName(idsIn), mtype: guessType(e?.cat) });
    return;
  }
  try {
    const r = await api('POST', `/dimgroups/${g.id}/items`, { ids: idsIn, versionId: C.W.versionId });
    replaceGroup(r.group); selectGroup(g.id);
    const t = groupTotal(G(g.id), C.W.byId);
    status(`${r.added} object(s) imported into "${g.name}"${r.skipped ? ` (${r.skipped} already in it)` : ''}. Total ${nice(t.total, t.unit)} ${t.unit}.`, 'ok');
  } catch (err) { status(err.message, 'bad'); }
}
export async function createGroupFor(list) {
  if (!canEdit()) { status('You need editor access to this project.', 'bad'); return; }
  const e = C.W.byId.get(list[0]);
  return editGroup(null, null, 'props', { importIds: list, name: commonName(list), mtype: guessType(e?.cat) });
}
function commonName(list) {
  const els = list.map(id => C.W.byId.get(id)).filter(Boolean);
  const types = new Set(els.map(e => e.type)), cats = new Set(els.map(e => e.cat));
  return types.size === 1 ? [...types][0] : cats.size === 1 ? [...cats][0] : 'New dimension group';
}
export function guessType(cat = '') {
  if (/pipe|duct|cable|conduit|railing|framing|curtain wall mullion|gutter|fascia/i.test(cat)) return 'Length';
  if (/floor|roof|ceiling|wall|panel|ramp|site|topograph|landscape/i.test(cat)) return 'Area';
  if (/column|foundation|mass/i.test(cat)) return 'Volume';
  return 'Count';
}
/** "Show Only / Hide / Import Objects In" and the other actions on a set of objects (Model tab and 3D menu). */
export function objectActions(list, label) {
  return [{ label: `Select (${list.length})`, run: () => C.setIds(list, true) },
    { label: 'Show Only These Objects', run: () => C.showOnly(list) },
    { label: 'Hide These Objects', run: () => C.hideIds(list) },
    { label: `Import Objects In${T.cur ? ` "${G(T.cur)?.name}"` : '...'}`, disabled: !canEdit(), run: () => importObjects(list) },
    { label: 'Create Dimension Group...', disabled: !canEdit(), run: () => createGroupFor(list) }, '-', { label: 'Close Menu' }];
}
export const currentGroup = () => G(T.cur);
export const groupById = (id) => G(id);
export const allGroups = () => T.groups;
export const selectedDims = () => [...T.dimSel];
/** For the ribbon: the same actions as the right-click menus. */
export const treeActions = {
  addDrawings: (folderId = null) => uploadTo(folderId), newFolder: (kind) => newFolder(kind, null),
  addGroup: () => editGroup(null, null), groupProps: (g = G(T.cur)) => g && editGroup(g), copyGroup: (g = G(T.cur)) => g && copyGroup(g),
  exportGroups: (list = T.sel ? [T.sel] : T.cur ? [T.cur] : []) => list.length && scheduleDialog(list), fromStandard: () => fromStandard(),
  addMeasured: (g = G(T.cur)) => g && addMeasured(g), deleteGroup: (g = G(T.cur)) => g && deleteGroup(g),
  setTop: (t) => { T.top = t; renderTop(); }, setBottom: (b) => { T.bottom = b; renderBottom(); }, top: () => T.top, bottom: () => T.bottom,
  canEdit: () => canEdit(), changeProp: (key, label, hint, g = G(T.cur)) => g && changeProp(g, key, label, hint),
};
/** The tree's dimension groups as the source of the on-screen take-off store (one copy of the data). */
export const tkSource = {
  groups: () => T.groups, current: () => T.cur, setCurrent: (id) => selectGroup(id),
  replace: (g) => { replaceGroup(g); subCache.clear(); render(); }, reload: () => loadTree(), shown: () => T.show,
};

// ================================================================== Excel schedules
export async function scheduleDialog(groupIds) {
  const W = C.W;
  const groups = groupIds.map(G).filter(Boolean);
  const all = [...new Set(groups.flatMap(ids))].map(id => W.byId.get(id)).filter(Boolean);
  const props = new Map(), qs = new Map();
  all.slice(0, 5000).forEach(e => { Object.keys(e.props || {}).forEach(k => props.set(k, (props.get(k) || 0) + 1)); Object.keys(e.q || {}).forEach(k => qs.set(k, (qs.get(k) || 0) + 1)); });
  const topProps = [...props].filter(([k]) => !['Category', 'Family', 'Type', 'Level', 'Mark'].includes(k)).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const topQs = [...qs].sort((a, b) => b[1] - a[1]).slice(0, 40);
  let opts = null;
  const r = await dialog({ title: groups.length > 1 ? `Add ${groups.length} dimension groups to Excel` : `Add "${groups[0]?.name}" to Excel`, wide: true,
    body: `<p class="hint">Each group becomes a schedule on the Take-off sheet with live formulas: one row per dimension, sub-totals and a named total for the BOQ. Groups that measure exactly the same objects (concrete, formwork, reinforcement… of the same beams) are written as <strong>one table</strong>.</p>
      <div class="sch-grid">
        <fieldset><legend>Details for each row</legend>${DETAILS.map(([k, l]) => `<label class="check"><input type="checkbox" data-det="${k}" ${['cat', 'type', 'level'].includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}
          ${topProps.length ? `<details><summary>More object properties (${topProps.length})</summary>${topProps.map(([k]) => `<label class="check"><input type="checkbox" data-det="p:${esc(k)}"> ${esc(k)}</label>`).join('')}</details>` : ''}</fieldset>
        <fieldset><legend>Quantities</legend><label class="check"><input type="checkbox" id="schCount" checked> Count</label>
          <p class="hint">The group quantity and its custom quantities are always included.</p>
          ${topQs.length ? `<details><summary>More BIM quantities (${topQs.length})</summary>${topQs.map(([k]) => `<label class="check"><input type="checkbox" data-q="${esc(k)}"> ${esc(k)}</label>`).join('')}</details>` : ''}
          <label class="field">Sub-totals by<select class="input" id="schBy"><option value="type">Type</option><option value="level">Level</option><option value="zone">Zone</option><option value="category">Category</option><option value="">None</option></select></label>
          <label class="check"><input type="checkbox" id="schMeas" checked> Include measured (manual) dimensions</label></fieldset>
      </div>
      <div class="sch-groups">${groups.map(g => { const t = groupTotal(g, W.byId); return `<div>${esc(g.name)} <span class="hint">· ${g.items.length + (g.props.measured || []).length} dimension(s) · ${esc(nice(t.total, t.unit))} ${esc(t.unit)}</span></div>`; }).join('')}</div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add to Excel', value: 'ok', primary: true }],
    validate: (d) => {
      opts = { details: [...d.querySelectorAll('[data-det]:checked')].map(c => c.dataset.det), extra: [...d.querySelectorAll('[data-q]:checked')].map(c => c.dataset.q),
        count: d.querySelector('#schCount').checked, by: d.querySelector('#schBy').value, measured: d.querySelector('#schMeas').checked };
      try { groups.forEach(g => groupToSpec(g, W.byId, opts)); } catch (err) { return err.message; }
      return '';
    } });
  if (!r) return;
  status('Writing the schedule to Excel…');
  T.waiting = groupIds;
  C.send({ type: 'addSchedule', groupIds, versionId: W.versionId, label: $('wTitle').textContent, opts });
  setTimeout(() => { if (T.waiting === groupIds) { T.waiting = null; status('The task pane did not answer. Keep the DWFx Measure task pane open in Excel and try again.', 'bad'); } }, 60000);
}
export function onScheduleDone(m) { T.waiting = null; status(m.message || (m.ok ? 'Added to Excel.' : 'Could not add to Excel.'), m.ok ? 'ok' : 'bad'); }

// ================================================================== start
export function initTree(ctx) {
  C = ctx;
  document.querySelectorAll('[data-lt]').forEach(b => b.onclick = () => { T.top = b.dataset.lt; renderTop(); });
  document.querySelectorAll('[data-bt]').forEach(b => b.onclick = () => { T.bottom = b.dataset.bt; renderBottom(); });
  $('curGroup').onchange = (e) => selectGroup(e.target.value || null);
  $('dgFilter').oninput = (e) => { T.filter = e.target.value; renderBottom(); };
  $('dgFilterX').onclick = () => { $('dgFilter').value = ''; T.filter = ''; renderBottom(); };
}
export async function onProjectLoaded() {
  if (C.W.projectId) { try { T.zones = (await api('GET', `/projects/${C.W.projectId}/zones`)).zones || []; } catch { T.zones = []; } }
  await loadTree();
}
