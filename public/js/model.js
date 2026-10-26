// DWFx Schedules window: the open model, its 3D view, element browser, selection (with undo), hide/isolate,
// colour by, zones, level plans, properties and saved views. Schedules are built from the selected elements' data.
import { $, esc, App, api, status } from './core.js';
import { Viewer, parseBin, fromLegacy } from './viewer.js';
import { Toolbar } from './vtools.js';
import { dimsOf, fmt, uLabel } from './engine.js';
import { loadVersion } from './localfiles.js';
import { S, PALETTE, STATUS_COLORS, REV_COLORS, idsOf, count, isVisible, snapshot, undo, redo } from './state.js';

let V = null, TB = null;

// ================================================================== setup
export function initModel() {
  V = new Viewer($('vstage'), {
    onPick: (id, add) => {
      snapshot();
      if (!add) S.ticked.clear();
      if (id != null) { if (add && S.ticked.has(id)) S.ticked.delete(id); else S.ticked.add(id); }
      showPick(id); if (id != null) revealInTree(id); update();
      if (id != null && S.inExcel) App.goToRows?.([...S.ticked]);
    },
    onContext: (id) => { if (id != null) showProps(id); },
    onBoxSelect: (ids, add) => {
      snapshot(); if (!add) S.ticked.clear(); ids.forEach(id => S.ticked.add(id)); update();
      status(`${ids.length} element${ids.length === 1 ? '' : 's'} selected by the box.`, 'ok');
    },
    onMeasure: (text) => { const m = $('mInfo'); m.hidden = !text; m.textContent = text || ''; },
    labelOf: (id) => { const e = S.byId.get(id); return e ? `${e.type} · ${e.level || ''} [${e.id}]` : ''; },
  });
  TB = new Toolbar($('vbar'), $('vstage'), V, HOST);
  window.__viewer = V;

  $('search').oninput = (e) => { S.search = e.target.value.trim().toLowerCase(); renderTree(); };
  $('level').onchange = (e) => { S.level = e.target.value; update(); };
  $('tickVisible').onclick = () => { snapshot(); S.E.forEach(e => matches(e.id) && S.ticked.add(e.id)); update(); };
  $('clear').onclick = () => { snapshot(); S.ticked.clear(); S.isolated = false; update(); };
  $('collapse').onclick = () => { S.open.clear(); renderTree(); };
  $('undoBtn').onclick = () => { if (undo()) update(); else status('Nothing to undo.'); };
  $('redoBtn').onclick = () => { if (redo()) update(); else status('Nothing to redo.'); };
  document.addEventListener('keydown', (e) => {
    if (!S.data || /input|textarea|select/i.test(document.activeElement?.tagName || '')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('undoBtn').click(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); $('redoBtn').click(); }
    if (e.key === 'Escape') $('props').hidden = true;
  });
  // resizable 3D view (height remembered on this computer)
  const vh = (() => { try { return Number(localStorage.getItem('dwfxViewerH')); } catch { return 0; } })();
  if (vh > 150) $('viewer').style.height = vh + 'px';
  const rz = $('vresize'); let start = null;
  rz.onpointerdown = (e) => { start = [e.clientY, $('viewer').offsetHeight]; rz.setPointerCapture(e.pointerId); };
  rz.onpointermove = (e) => { if (!start) return; $('viewer').style.height = Math.max(180, Math.min(window.innerHeight - 140, start[1] + e.clientY - start[0])) + 'px'; };
  rz.onpointerup = () => { start = null; try { localStorage.setItem('dwfxViewerH', $('viewer').offsetHeight); } catch { /* storage blocked */ } };
  rz.onkeydown = (e) => {
    const d = e.key === 'ArrowUp' ? -30 : e.key === 'ArrowDown' ? 30 : 0; if (!d) return;
    $('viewer').style.height = Math.max(180, $('viewer').offsetHeight + d) + 'px'; e.preventDefault();
  };
}
export const viewer = () => V;
export const toolbar = () => TB;

// ================================================================== host interface for the toolbar
const HOST = {
  selectedIds: () => [...S.ticked],
  isIsolated: () => S.isolated,
  toggleIsolate() {
    if (!S.isolated && !S.ticked.size) { status('Select elements first, then press Isolate.'); return; }
    snapshot(); S.isolated = !S.isolated; update(); V.fit();
  },
  hideSelected() {
    if (!S.ticked.size) return;
    snapshot(); S.ticked.forEach(id => S.hidden.add(id)); const n = S.ticked.size; S.ticked.clear(); update();
    status(`${n} element${n === 1 ? '' : 's'} hidden. Show all brings them back; Ctrl+Z undoes.`);
  },
  showAll() { snapshot(); S.isolated = false; S.hidden.clear(); S.level = ''; $('level').value = ''; update(); V.fit(); },
  levels: () => S.levelZ,
  colorModes,
  colorMode: () => S.colorBy,
  setColorMode,
  legend: () => S.legend,
  selectIds(ids) { snapshot(); S.ticked = new Set(ids); update(); V.fit(ids.filter(id => V.hasGeometry(id))); },
  canSaveViews: () => Boolean(S.versionId && App.currentProjectId?.()),
  async views() {
    const pid = App.currentProjectId?.(); if (!pid) return [];
    return (await api('GET', `/projects/${pid}/views`)).views;
  },
  async saveView(name) {
    const pid = App.currentProjectId?.(); if (!pid) return;
    const state = { camera: V.getViewState(), ticked: [...S.ticked].slice(0, 20000), hidden: [...S.hidden].slice(0, 50000), isolated: S.isolated,
      level: S.level, colorBy: S.colorBy, xray: Boolean(V.state.xray), plan: TB.inPlan || null };
    try { await api('POST', `/projects/${pid}/views`, { name, state, versionId: S.versionId }); status(`View "${name}" saved for the team.`, 'ok'); }
    catch (err) { status(err.message, 'bad'); }
  },
  async applyView(v) {
    const s = v.state || {};
    snapshot();
    S.ticked = new Set((s.ticked || []).filter(id => S.byId.has(id)));
    S.hidden = new Set((s.hidden || []).filter(id => S.byId.has(id)));
    S.isolated = Boolean(s.isolated); S.level = s.level || ''; $('level').value = S.level;
    if (s.colorBy && s.colorBy !== S.colorBy) await setColorMode(s.colorBy);
    V.state.xray = Boolean(s.xray);
    TB.inPlan = s.plan || null;
    update(); V.setViewState(s.camera);
    status(`View "${v.name}" opened.`, 'ok');
  },
  async deleteView(v) { try { await api('DELETE', `/views/${v.id}`); status('View deleted.', 'ok'); } catch (err) { status(err.message, 'bad'); } },
  status,
  async insertPicture(dataUrl) {
    if (!App.insertPicture) throw new Error('not in Excel');
    await App.insertPicture(dataUrl);
    status('Picture of the 3D view added to the active sheet.', 'ok');
  },
};

// ================================================================== loading
export async function loadModelData(data, { versionId = null, label = '', geometry = null } = {}) {
  S.data = data; S.E = data.elements; S.byId = new Map(S.E.map(e => [e.id, e]));
  S.versionId = versionId; S.label = label || data.fileName;
  S.ticked.clear(); S.hidden.clear(); S.isolated = false; S.search = ''; S.level = ''; S.open.clear();
  S.rowsById = null; S.catColor.clear(); S.history = []; S.future = []; S.measured = null; S.compare = null;
  S.colorBy = 'category'; S.colorMap = null;
  $('search').value = ''; if ($('aiOut')) $('aiOut').innerHTML = ''; $('props').hidden = true; $('pickInfo').hidden = true;
  buildTree();
  App.computeDerived?.();                                    // openings, etc. (measure module)
  $('ctxModel').textContent = S.label;
  const levels = [...new Set(S.E.map(e => e.level).filter(Boolean))];
  $('level').innerHTML = '<option value="">All levels</option>' + levels.map(l => `<option>${esc(l)}</option>`).join('');
  App.selectTab('elements');
  let g = null;
  if (geometry instanceof ArrayBuffer) g = parseBin(geometry);
  else if (data.geometry?.meshes) g = fromLegacy(data.geometry);
  if (g) V.load(g); else V.clear();
  computeLevels(g);
  await loadZones();
  legendFor();
  update();
  const shown = S.E.filter(e => V.hasGeometry(e.id)).length;
  status(`${S.E.length} elements in ${S.tree.size} categories, ${shown} shown in 3D.` + (data.geoNote ? ' ' + data.geoNote : ''), data.geoNote ? 'warn' : 'ok');
  App.onModelLoaded?.();
}
export function closeModel() {
  S.data = null; S.E = []; S.byId = new Map(); S.versionId = null; S.ticked.clear(); S.hidden.clear();
  V?.clear(); $('ctxModel').textContent = 'No model open'; App.selectTab?.(App.currentTab?.() || 'elements');
}
async function withViewerBusy(msg, fn) {
  $('viewer').hidden = false; V.resize();
  const v = $('vload'); v.hidden = false; v.textContent = msg; status(msg);
  try { return await fn(); } finally { v.hidden = true; }
}
export async function openVersion(vid, label = '') {
  try {
    const [data, geometry] = await withViewerBusy(`Opening ${label || 'model'}…`, async () => {
      const r = await loadVersion(vid, { onUpdate: (st) => { $('vload').textContent = `${st.step}${st.pct ? ` (${Math.round(st.pct)}%)` : ''}`; } });
      return [r.data, r.geometry];
    });
    await loadModelData(data, { versionId: vid, label, geometry });
    try { localStorage.setItem('dwfxLastVersion', vid); } catch { /* storage blocked */ }
  } catch (err) { status('Could not open the model: ' + err.message, 'bad'); if (!S.data) App.selectTab('project'); }
}
/** Elevation of each level (world metres) from the elements on it, for level plans. */
function computeLevels(g) {
  S.levelZ = [];
  if (!g) return;
  const up = { x: 0, y: 1, z: 2 }[g.header.up || 'y'];
  const by = new Map();
  for (const e of S.E) {
    if (!e.level || !e.bb) continue;
    if (!by.has(e.level)) by.set(e.level, []);
    by.get(e.level).push(e.bb[up]);
  }
  for (const [name, zs] of by) {
    zs.sort((a, b) => a - b);
    const z = zs[Math.floor(zs.length * 0.5)];          // median bottom of the elements on the level
    S.levelZ.push({ name, z });
  }
  S.levelZ.sort((a, b) => a.z - b.z);
}

// ================================================================== painting and colours
export function paint() {
  if (!V?.loaded) return;
  V.paint({ selected: S.ticked, isVisible, colorOf, xray: V.state.xray });
  TB.sync();
  $('selCount').textContent = S.ticked.size ? `(${S.ticked.size})` : '';
}
export function update() {
  paint(); renderTree();
  if ($('tab-measure').classList.contains('on')) App.renderMeasure?.();
}
function colorOf(id) {
  if (S.colorMap) return S.colorMap.get(id) || '#c8ccd0';
  return S.catColor.get(S.byId.get(id)?.cat) || '#8a9aa6';
}
function colorModes() {
  const m = [{ id: 'category', label: 'Category' }, { id: 'level', label: 'Level' }, { id: 'type', label: 'Type' }, { id: 'family', label: 'Family' },
    { id: 'material', label: 'Material' }, { id: 'zone', label: 'Zone' }, { id: 'measured', label: 'Measured status (Take-off sheet)' }];
  if (S.compare) m.push({ id: 'revision', label: `Revision changes (${S.compare.from.label} → ${S.compare.to.label})` });
  // frequent properties with a few distinct values, e.g. Structural Material, Fire Rating
  const freq = new Map();
  S.E.slice(0, 3000).forEach(e => Object.keys(e.props || {}).forEach(k => freq.set(k, (freq.get(k) || 0) + 1)));
  [...freq].filter(([k, n]) => n > Math.min(30, S.E.length / 4) && /material|rating|grade|class|finish|function|phase|mark|comments|system|size|zone|work/i.test(k))
    .sort((a, b) => b[1] - a[1]).slice(0, 14).forEach(([k]) => m.push({ id: 'prop:' + k, label: 'Property: ' + k }));
  ['Volume', 'Area', 'Length', 'Geo volume'].forEach(q => { if (S.E.some(e => e.q?.[q])) m.push({ id: 'num:' + q, label: 'Value: ' + q + ' (low to high)' }); });
  return m;
}
export async function setColorMode(mode) {
  S.colorBy = mode;
  if (mode === 'measured') { try { await App.loadMeasured?.(); } catch (err) { status(err.message, 'bad'); } }
  legendFor(); paint();
}
function legendFor() {
  const mode = S.colorBy;
  S.legend = []; S.colorMap = null;
  const groups = new Map();
  const put = (key, id) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(id); };
  if (mode === 'category') {
    for (const [cat, fams] of S.tree || []) S.legend.push({ label: cat, color: S.catColor.get(cat), ids: idsOf(fams), count: count(fams) });
    S.legend.sort((a, b) => b.count - a.count); return;
  }
  if (mode === 'measured') {
    const m = S.measured || new Map();
    S.E.forEach(e => put((m.get(e.id) || 0) === 0 ? 'Not measured' : m.get(e.id) === 1 ? 'Measured once' : 'Measured twice or more', e.id));
    const col = { 'Not measured': STATUS_COLORS.none, 'Measured once': STATUS_COLORS.once, 'Measured twice or more': STATUS_COLORS.twice };
    return finish(groups, (k) => col[k]);
  }
  if (mode === 'revision' && S.compare) {
    const add = new Set(S.compare.added.map(x => x.id)), chg = new Set(S.compare.changed.map(x => x.id)), rem = new Set(S.compare.removed.map(x => x.id));
    const openIsTo = S.versionId === S.compare.to.id;
    S.E.forEach(e => put(add.has(e.id) && openIsTo ? 'Added' : chg.has(e.id) ? 'Changed' : rem.has(e.id) && !openIsTo ? 'Removed' : 'Unchanged', e.id));
    const col = { Added: REV_COLORS.added, Changed: REV_COLORS.changed, Removed: REV_COLORS.removed, Unchanged: REV_COLORS.same };
    return finish(groups, (k) => col[k]);
  }
  if (mode.startsWith('num:')) {
    const qn = mode.slice(4), vals = S.E.map(e => e.q?.[qn]?.[0]).filter(v => v != null).sort((a, b) => a - b);
    if (!vals.length) return;
    const lo = vals[Math.floor(vals.length * 0.02)], hi = vals[Math.floor(vals.length * 0.98)] || lo;
    const bins = 6, step = (hi - lo) / bins || 1, ramp = ['#2b83ba', '#80bfab', '#c7e8ad', '#ffffbf', '#fdc980', '#f07c4a', '#d7191c'];
    S.E.forEach(e => {
      const v = e.q?.[qn]?.[0];
      if (v == null) return put('No value', e.id);
      const b = Math.min(bins, Math.max(0, Math.floor((v - lo) / step)));
      put(`${(lo + b * step).toFixed(2)} – ${(lo + (b + 1) * step).toFixed(2)} ${e.q[qn][1]}${b === bins ? '+' : ''}`, e.id);
    });
    const keys = [...groups.keys()].filter(k => k !== 'No value').sort((a, b) => parseFloat(a) - parseFloat(b));
    const col = new Map(keys.map((k, i) => [k, ramp[Math.round(i * (ramp.length - 1) / Math.max(keys.length - 1, 1))]])); col.set('No value', '#d0d4d8');
    return finish(groups, (k) => col.get(k), (a, b) => (a === 'No value') - (b === 'No value') || parseFloat(a) - parseFloat(b));
  }
  const valueOf = {
    level: (e) => e.level || '(no level)', type: (e) => e.type, family: (e) => e.fam,
    material: (e) => e.material || e.props?.['Structural Material'] || e.props?.['Material'] || '(no material)',
    zone: (e) => S.zoneOf.get(e.id) || '(no zone)',
  }[mode] || ((e) => e.props?.[mode.slice(5)] || '(empty)');
  S.E.forEach(e => put(valueOf(e), e.id));
  const zcol = new Map(S.zones.map(z => [z.name, z.color]));
  const keys = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
  const extra = ['#e3008c', '#00b7c3', '#ca5010', '#498205', '#8764b8', '#0078d4', '#986f0b', '#c239b3'];
  const col = new Map(keys.map((k, i) => [k, mode === 'zone' && zcol.get(k) ? zcol.get(k) : /^\(/.test(k) ? '#d0d4d8' : [...PALETTE, ...extra][i % (PALETTE.length + extra.length)]]));
  finish(groups, (k) => col.get(k));
}
function finish(groups, colorFor, sort) {
  S.colorMap = new Map();
  for (const [k, ids] of groups) { const c = colorFor(k); ids.forEach(id => S.colorMap.set(id, c)); }
  S.legend = [...groups].map(([label, ids]) => ({ label, ids, count: ids.length, color: colorFor(label) }))
    .sort(sort ? (a, b) => sort(a.label, b.label) : (a, b) => b.count - a.count).slice(0, 40);
}

// ================================================================== element browser (Category > Family > Type > Element)
function buildTree() {
  const t = new Map();
  for (const e of S.E) {
    if (!t.has(e.cat)) t.set(e.cat, new Map());
    const f = t.get(e.cat); if (!f.has(e.fam)) f.set(e.fam, new Map());
    const ty = f.get(e.fam); if (!ty.has(e.type)) ty.set(e.type, []);
    ty.get(e.type).push(e.id);
  }
  S.tree = t;
  [...t.keys()].sort((a, b) => count(t.get(b)) - count(t.get(a))).forEach((c, i) => S.catColor.set(c, PALETTE[i % PALETTE.length]));
}
export function matches(id) {
  const e = S.byId.get(id);
  if (S.level && e.level !== S.level) return false;
  if (!S.search) return true;
  const q = S.search;
  return String(e.id).includes(q) || `${e.cat} ${e.fam} ${e.type} ${e.name} ${e.mark}`.toLowerCase().includes(q);
}
export function renderTree() {
  const box = $('tree'); if (!S.tree) { box.innerHTML = ''; return; }
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const [cat, fams] of [...S.tree].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ids = idsOf(fams).filter(matches); if (!ids.length) continue;
    frag.append(nodeEl(cat, cat, ids, 0, () => {
      const k = document.createElement('div'); k.className = 'kids'; k.setAttribute('role', 'group');
      for (const [fam, types] of [...fams].sort((a, b) => a[0].localeCompare(b[0]))) {
        const fid = idsOf(types).filter(matches); if (!fid.length) continue;
        k.append(nodeEl(cat + '|' + fam, fam, fid, 1, () => {
          const k2 = document.createElement('div'); k2.className = 'kids'; k2.setAttribute('role', 'group');
          for (const [typ, list] of [...types].sort((a, b) => a[0].localeCompare(b[0]))) {
            const tid = list.filter(matches); if (!tid.length) continue;
            k2.append(nodeEl(cat + '|' + fam + '|' + typ, typ, tid, 2, () => {
              const k3 = document.createElement('div'); k3.className = 'kids'; k3.setAttribute('role', 'group');
              tid.slice(0, 400).forEach(id => {
                const e = S.byId.get(id);
                k3.append(nodeEl('#' + id, `${e.id}  ${e.level || ''}${e.mark ? '  ' + e.mark : ''}${S.hidden.has(id) ? '  (hidden)' : ''}`, [id], 3, null));
              });
              if (tid.length > 400) k3.insertAdjacentHTML('beforeend', `<div class="more">${tid.length - 400} more. Use the search to narrow down.</div>`);
              return k3;
            }));
          }
          return k2;
        }));
      }
      return k;
    }, S.catColor.get(cat)));
  }
  box.append(frag);
  if (!box.children.length) box.innerHTML = '<div class="empty">No elements match. Clear the search or choose all levels.</div>';
}
function nodeEl(key, label, ids, depth, kids, color) {
  const wrap = document.createElement('div');
  const row = document.createElement('div'); row.className = 'node'; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', depth + 1);
  const n = ids.filter(id => S.ticked.has(id)).length;
  if (depth === 3 && n) row.classList.add('hl');
  const open = S.open.has(key) || (S.search && depth < 2);
  if (kids) row.setAttribute('aria-expanded', String(Boolean(open)));
  row.innerHTML = `<span class="tw">${kids ? (open ? '▾' : '▸') : ''}</span><input type="checkbox" aria-label="Select ${esc(label)}">` +
    (color ? `<span class="sw" style="background:${color}"></span>` : '') +
    `<span class="lbl" title="${esc(label)}" tabindex="0">${esc(label)}</span>${depth < 3 ? `<span class="n">${ids.length}</span>` : ''}`;
  const cb = row.querySelector('input');
  cb.checked = n === ids.length; cb.indeterminate = n > 0 && n < ids.length;
  cb.onchange = () => { snapshot(); ids.forEach(id => cb.checked ? S.ticked.add(id) : S.ticked.delete(id)); update(); };
  const lbl = row.querySelector('.lbl');
  lbl.onclick = () => { if (depth === 3) showPick(ids[0]); V.fit(ids.filter(id => V.hasGeometry(id))); };
  lbl.onkeydown = (ev) => {
    if (ev.key === 'Enter') lbl.click();
    if (ev.key === ' ') { ev.preventDefault(); cb.click(); }
    if (ev.key === 'ArrowRight' && kids && !open) { S.open.add(key); renderTree(); }
    if (ev.key === 'ArrowLeft' && kids && open) { S.open.delete(key); renderTree(); }
    if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) { ev.preventDefault(); showProps(ids[0]); }
  };
  if (depth === 3) row.oncontextmenu = (ev) => { ev.preventDefault(); showProps(ids[0]); };
  if (kids) row.querySelector('.tw').onclick = () => { S.open.has(key) ? S.open.delete(key) : S.open.add(key); renderTree(); };
  wrap.append(row);
  if (kids && open) wrap.append(kids());
  return wrap;
}
export function revealInTree(id) {
  const e = S.byId.get(id); if (!e) return;
  S.open.add(e.cat); S.open.add(e.cat + '|' + e.fam); S.open.add(e.cat + '|' + e.fam + '|' + e.type);
  renderTree();
  setTimeout(() => $('tree').querySelector('.node.hl')?.scrollIntoView({ block: 'nearest' }), 0);
}
export function showPick(id) {
  const e = S.byId.get(id), el = $('pickInfo');
  if (!e) { el.hidden = true; return; }
  el.hidden = false; el.textContent = `${e.type}  [${e.id}]  ${e.level || ''}`;
}
export function selectIds(ids, { fit = true } = {}) {
  snapshot(); S.ticked = new Set(ids); update();
  if (fit) V.fit(ids.filter(id => V.hasGeometry(id)));
}

// ================================================================== properties (right-click)
export function showProps(id) {
  const e = S.byId.get(id); if (!e) return;
  const p = $('props'); p.hidden = false;
  const qs = Object.entries(e.q || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const qRows = (list) => list.map(([k, [v, u]]) => `<tr><td>${esc(k)}</td><td class="v">${fmt(v, u)} ${esc(uLabel(u))}</td></tr>`).join('');
  const all = Object.entries(e.props || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const measured = S.measured?.get(id);
  p.innerHTML = `<div class="ph"><div style="min-width:0"><strong>${esc(e.type)}</strong><div class="hint">${esc(e.cat)} › ${esc(e.fam)}</div></div>
      <button id="pClose" aria-label="Close properties">Close</button></div>
    <div class="row"><button id="pTick">${S.ticked.has(id) ? 'Deselect' : 'Select'}</button><button id="pZoom" ${V.hasGeometry(id) ? '' : 'disabled'}>Zoom to</button><button id="pHide">Hide</button>${S.inExcel ? '<button id="pRows">Find in Take-off</button>' : ''}</div>
    <table class="q"><tbody>
      <tr><td>Revit ID</td><td class="v">${e.id}</td></tr><tr><td>Level</td><td class="v">${esc(e.level || '-')}</td></tr>
      ${e.mark ? `<tr><td>Mark</td><td class="v">${esc(e.mark)}</td></tr>` : ''}
      ${S.zoneOf.get(id) ? `<tr><td>Zone</td><td class="v">${esc(S.zoneOf.get(id))}</td></tr>` : ''}
      ${measured != null ? `<tr><td>Take-off rows</td><td class="v">${measured}</td></tr>` : ''}
      ${dimsOf(e.type).length ? `<tr><td>Size from type name</td><td class="v">${dimsOf(e.type).map(d => d.toFixed(3)).join(' x ')} m</td></tr>` : ''}
      ${V.hasGeometry(id) ? '' : '<tr><td>3D</td><td class="v">No geometry in the DWFx</td></tr>'}
    </tbody></table>
    <h4>Quantities from Revit (metres)</h4><table class="q"><tbody>${qRows(qs.filter(([k]) => !/^Geo |^Openings/.test(k))) || '<tr><td class="hint">None</td></tr>'}</tbody></table>
    ${qs.some(([k]) => /^Geo |^Openings/.test(k)) ? `<h4>Measured from the 3D geometry</h4><table class="q"><tbody>${qRows(qs.filter(([k]) => /^Geo |^Openings/.test(k)))}</tbody></table>
      <p class="hint">Geo values are exact from the model faces. Volume shows only when the element is a closed solid.</p>` : ''}
    <h4>All properties</h4><input type="search" id="pFind" placeholder="Filter properties" style="width:100%;margin-bottom:4px" aria-label="Filter properties">
    <table class="q" id="pAll"><tbody>${all.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="v" style="white-space:normal">${esc(v)}</td></tr>`).join('')}</tbody></table>
    <div class="row"><button id="pOnly">Show only this element</button><button id="pAllVisible">Show all</button><button id="pFitAll">Fit view</button></div>`;
  $('pClose').onclick = () => { p.hidden = true; };
  $('pTick').onclick = () => { snapshot(); S.ticked.has(id) ? S.ticked.delete(id) : S.ticked.add(id); update(); showProps(id); };
  $('pZoom').onclick = () => V.fit([id]);
  $('pHide').onclick = () => { snapshot(); S.hidden.add(id); S.ticked.delete(id); update(); p.hidden = true; };
  $('pOnly').onclick = () => { selectIds([id]); S.isolated = true; update(); p.hidden = true; };
  $('pAllVisible').onclick = () => { HOST.showAll(); p.hidden = true; };
  $('pFitAll').onclick = () => V.fit();
  $('pRows') && ($('pRows').onclick = () => App.goToRows?.([id]));
  $('pFind').oninput = (ev) => { const q = ev.target.value.toLowerCase(); $('pAll').querySelectorAll('tr').forEach(tr => { tr.hidden = !tr.textContent.toLowerCase().includes(q); }); };
  $('pClose').focus();
}

// ================================================================== zones
export async function loadZones() {
  S.zones = []; S.zoneOf = new Map();
  const pid = App.currentProjectId?.();
  if (pid && S.versionId) { try { S.zones = (await api('GET', `/projects/${pid}/zones`)).zones; } catch { /* zones are optional */ } }
  S.zones.forEach(z => (z.ids || []).forEach(id => { if (!S.zoneOf.has(id)) S.zoneOf.set(id, z.name); }));
  S.E.forEach(e => { e.zone = S.zoneOf.get(e.id) || ''; });
  renderZones();
}
const ZONE_COLORS = ['#0078d4', '#e3008c', '#00b7c3', '#ca5010', '#498205', '#8764b8', '#986f0b', '#c239b3', '#038387', '#bf0077'];
export function renderZones() {
  const box = $('zonesBody'); if (!box) return;
  const pid = App.currentProjectId?.();
  $('zoneCount').textContent = S.zones.length ? `(${S.zones.length})` : '';
  if (!pid || !S.versionId) { box.innerHTML = '<p class="hint">Open a model from a project to use zones (for example Villa, Annex, Parking, Block A).</p>'; return; }
  box.innerHTML = `<p class="hint">A zone is a named set of elements, used to split take-offs (sub-totals by zone) and to colour the model.</p>
    ${S.zones.map((z, i) => `<div class="zone-row"><span class="sw" style="background:${z.color || '#888'}"></span><span class="grow">${esc(z.name)}</span><span class="muted small">${(z.ids || []).length}</span>
      <button class="btn small" data-zs="${i}">Select</button><button class="btn small" data-zu="${i}" title="Replace with the current selection">Update</button><button class="btn small subtle danger-text" data-zd="${i}">Delete</button></div>`).join('')}
    <form class="inline-form" id="zoneForm"><input class="input" id="zoneName" placeholder="New zone name" maxlength="80" required aria-label="New zone name">
      <button class="btn">Create from selection</button></form>`;
  box.querySelectorAll('[data-zs]').forEach(b => b.onclick = () => selectIds(S.zones[+b.dataset.zs].ids.filter(id => S.byId.has(id))));
  box.querySelectorAll('[data-zu]').forEach(b => b.onclick = () => saveZone(S.zones[+b.dataset.zu].name, S.zones[+b.dataset.zu].color));
  box.querySelectorAll('[data-zd]').forEach(b => b.onclick = async () => {
    try { await api('DELETE', `/zones/${S.zones[+b.dataset.zd].id}`); await loadZones(); if (S.colorBy === 'zone') setColorMode('zone'); status('Zone deleted.', 'ok'); } catch (err) { status(err.message, 'bad'); }
  });
  $('zoneForm').onsubmit = (e) => { e.preventDefault(); saveZone($('zoneName').value, ZONE_COLORS[S.zones.length % ZONE_COLORS.length]); };
}
async function saveZone(name, color) {
  if (!S.ticked.size) { status('Select the elements of the zone first (box select works well on a level plan).', 'bad'); return; }
  try {
    await api('POST', `/projects/${App.currentProjectId()}/zones`, { name, color, ids: [...S.ticked] });
    await loadZones(); if (S.colorBy === 'zone') setColorMode('zone');
    status(`Zone "${name}" saved with ${S.ticked.size} elements.`, 'ok');
  } catch (err) { status(err.message, 'bad'); }
}
