import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { dimsOf, keyOf, evaluate as evaluateSpec, unitFmt, fmt } from './js/engine.js';
import { $, esc, App, api, session, status, confirmBox } from './js/core.js';
import { showProjects, openProject, refreshProject, currentProject, resetProjects } from './js/project.js';
import { showAdmin } from './js/admin.js';

// ================================================================== state
const S = {
  inExcel: false, data: null, E: [], byId: new Map(), meshes: [], meshById: new Map(),
  ticked: new Set(), isolated: false, search: '', level: '', open: new Set(),
  tree: null, catColor: new Map(), takeoff: [], rowsById: null, quiet: 0,
};

// muted, distinguishable colours for categories (assigned in order of size)
const PALETTE = ['#8a9aa6', '#c98a2b', '#2f6fa3', '#b5473a', '#6b5b8c', '#7a8a5a', '#3f8f8a', '#a8794f',
  '#5d6f8f', '#9a5d7a', '#6f8f3f', '#4f7fa8', '#b0905a', '#7d7d7d'];

// ================================================================== 3D viewer
const host = $('viewer');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
host.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--viewer').trim() || '#e8eaec');
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(1, 2, 1.5); scene.add(sun);
const root = new THREE.Group(); scene.add(root);
function resize() {
  const w = host.clientWidth, h = Math.max(host.clientHeight, 1);
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); invalidate();
}
new ResizeObserver(resize).observe(host);
// render only when something changed (saves battery and keeps Excel responsive)
let dirty = true;
const invalidate = () => { dirty = true; };
controls.addEventListener('change', invalidate);
(function loop() {
  const moving = controls.update();
  if ((dirty || moving) && !host.hidden) { renderer.render(scene, camera); dirty = false; }
  requestAnimationFrame(loop);
})();

const mats = new Map();
const matFor = (cat) => {
  if (!mats.has(cat)) mats.set(cat, new THREE.MeshLambertMaterial({ color: S.catColor.get(cat) || '#9aa3aa', polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  return mats.get(cat);
};
const pickMat = new THREE.MeshLambertMaterial({ color: '#f2a900', emissive: new THREE.Color('#5a3d00'), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const ghostMat = new THREE.MeshLambertMaterial({ color: '#b9bfc4', transparent: true, opacity: 0.12, depthWrite: false });
const edgeMat = new THREE.LineBasicMaterial({ color: '#3b444c', transparent: true, opacity: 0.35 });
const b64 = (s, T) => new T(Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer);

function buildScene(geo) {
  root.clear(); S.meshes = []; S.meshById = new Map();
  for (const m of geo.meshes || []) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b64(m.p, Float32Array), 3));
    g.setIndex(new THREE.BufferAttribute(b64(m.i, Uint32Array), 1));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, matFor(S.byId.get(m.id)?.cat));
    mesh.userData.id = m.id;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), edgeMat));
    root.add(mesh); S.meshes.push(mesh);
    if (m.id != null) { if (!S.meshById.has(m.id)) S.meshById.set(m.id, []); S.meshById.get(m.id).push(mesh); }
  }
  fit();
}
function fit(ids) {
  const box = new THREE.Box3();
  const list = ids ? ids.flatMap(id => S.meshById.get(id) || []) : S.meshes.filter(m => m.visible);
  list.forEach(m => box.expandByObject(m));
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5);
  const vf = THREE.MathUtils.degToRad(camera.fov / 2), hf = Math.atan(Math.tan(vf) * camera.aspect);
  const d = r / Math.sin(Math.min(vf, hf)) * 0.8;
  camera.position.copy(c).add(new THREE.Vector3(1, 0.75, 1.1).normalize().multiplyScalar(d));
  camera.near = d / 300; camera.far = d * 30; camera.updateProjectionMatrix();
  controls.target.copy(c); controls.update(); invalidate();
}
function paint() {
  const any = S.ticked.size > 0;
  for (const m of S.meshes) {
    const id = m.userData.id, on = S.ticked.has(id), e = S.byId.get(id);
    const passLevel = !S.level || e?.level === S.level;
    m.visible = S.isolated ? on : passLevel;
    m.material = on ? pickMat : (any ? ghostMat : matFor(e?.cat));
    m.children[0].visible = !any || on;
  }
  $('isolate').setAttribute('aria-pressed', String(S.isolated)); invalidate();
  $('selCount').textContent = S.ticked.size ? `(${S.ticked.size})` : '';
}

// click in 3D: tick that element (Ctrl/Shift adds)
const ray = new THREE.Raycaster(); let down = null;
renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
function pickAt(e) {
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  return ray.intersectObjects(S.meshes.filter(m => m.visible), false)[0]?.object.userData.id;
}
renderer.domElement.addEventListener('contextmenu', e => {     // right-click: element properties
  e.preventDefault();
  const id = pickAt(e); if (id != null && S.byId.has(id)) showProps(id);
});
renderer.domElement.addEventListener('pointerup', e => {
  if (e.button !== 0) return;
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const id = pickAt(e);
  const add = e.ctrlKey || e.metaKey || e.shiftKey;
  if (!add) S.ticked.clear();
  if (id != null) { if (add && S.ticked.has(id)) S.ticked.delete(id); else S.ticked.add(id); }
  showPick(id); revealInTree(id); update();
  if (id != null && S.inExcel) goToRows([...S.ticked]);
});
function showPick(id) {
  const e = S.byId.get(id), el = $('pickInfo');
  if (!e) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `${e.type}  [${e.id}]  ${e.level || ''}`;
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
const count = (m) => [...m.values()].reduce((s, v) => s + (Array.isArray(v) ? v.length : count(v)), 0);
function matches(id) {
  const e = S.byId.get(id);
  if (S.level && e.level !== S.level) return false;
  if (!S.search) return true;
  const q = S.search;
  return String(e.id).includes(q) || `${e.cat} ${e.fam} ${e.type} ${e.name} ${e.mark}`.toLowerCase().includes(q);
}
const idsOf = (v) => Array.isArray(v) ? v : [...v.values()].flatMap(idsOf);

function renderTree() {
  const box = $('tree'); box.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const [cat, fams] of [...S.tree].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ids = idsOf(fams).filter(matches); if (!ids.length) continue;
    frag.append(nodeEl(cat, cat, ids, 0, () => {
      const k = document.createElement('div'); k.className = 'kids';
      for (const [fam, types] of [...fams].sort((a, b) => a[0].localeCompare(b[0]))) {
        const fid = idsOf(types).filter(matches); if (!fid.length) continue;
        k.append(nodeEl(cat + '|' + fam, fam, fid, 1, () => {
          const k2 = document.createElement('div'); k2.className = 'kids';
          for (const [typ, list] of [...types].sort((a, b) => a[0].localeCompare(b[0]))) {
            const tid = list.filter(matches); if (!tid.length) continue;
            k2.append(nodeEl(cat + '|' + fam + '|' + typ, typ, tid, 2, () => {
              const k3 = document.createElement('div'); k3.className = 'kids';
              tid.slice(0, 400).forEach(id => {
                const e = S.byId.get(id);
                k3.append(nodeEl('#' + id, `${e.id}  ${e.level || ''}${e.mark ? '  ' + e.mark : ''}`, [id], 3, null));
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
  const row = document.createElement('div'); row.className = 'node'; row.setAttribute('role', 'treeitem');
  const n = ids.filter(id => S.ticked.has(id)).length;
  if (depth === 3 && n) row.classList.add('hl');
  const open = S.open.has(key) || (S.search && depth < 2);
  row.innerHTML = `<span class="tw">${kids ? (open ? '▾' : '▸') : ''}</span><input type="checkbox" aria-label="Tick ${esc(label)}">` +
    (color ? `<span class="sw" style="background:${color}"></span>` : '') +
    `<span class="lbl" title="${esc(label)}">${esc(label)}</span>${depth < 3 ? `<span class="n">${ids.length}</span>` : ''}`;
  const cb = row.querySelector('input');
  cb.checked = n === ids.length; cb.indeterminate = n > 0 && n < ids.length;
  cb.onchange = () => { ids.forEach(id => cb.checked ? S.ticked.add(id) : S.ticked.delete(id)); update(); };
  row.querySelector('.lbl').onclick = () => { if (depth === 3) { showPick(ids[0]); } fit(ids.filter(id => S.meshById.has(id))); };
  if (depth === 3) row.oncontextmenu = (ev) => { ev.preventDefault(); showProps(ids[0]); };
  if (kids) row.querySelector('.tw').onclick = () => { S.open.has(key) ? S.open.delete(key) : S.open.add(key); renderTree(); };
  wrap.append(row);
  if (kids && open) wrap.append(kids());
  return wrap;
}
function revealInTree(id) {
  const e = S.byId.get(id); if (!e) return;
  S.open.add(e.cat); S.open.add(e.cat + '|' + e.fam); S.open.add(e.cat + '|' + e.fam + '|' + e.type);
  renderTree();
  const hl = $('tree').querySelector('.node.hl'); hl?.scrollIntoView({ block: 'nearest' });
}

$('search').oninput = (e) => { S.search = e.target.value.trim().toLowerCase(); renderTree(); };
$('level').onchange = (e) => { S.level = e.target.value; renderTree(); paint(); };
$('tickVisible').onclick = () => { S.E.forEach(e => matches(e.id) && S.ticked.add(e.id)); update(); };
$('clear').onclick = () => { S.ticked.clear(); S.isolated = false; update(); };
$('collapse').onclick = () => { S.open.clear(); renderTree(); };
$('isolate').onclick = () => {
  if (!S.isolated && !S.ticked.size) { status('Tick elements first, then press Isolate.'); return; }
  S.isolated = !S.isolated; paint(); fit();
};
$('showAll').onclick = () => { S.isolated = false; S.level = ''; $('level').value = ''; renderTree(); paint(); fit(); };
$('fit').onclick = () => fit();
// ---------------------------------------------------------------- tabs
const MODEL_TABS = ['elements', 'measure', 'ai'];
let currentTab = 'project';
function selectTab(name) {
  if (name === 'admin' && session.get()?.user?.role !== 'admin') name = 'project';
  currentTab = name;
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + name));
  const showViewer = Boolean(S.data) && MODEL_TABS.includes(name);
  const was = !$('viewer').hidden;
  $('viewer').hidden = !showViewer;
  if (showViewer && !was) resize();
  document.querySelectorAll('.nomodel').forEach(el => { el.hidden = Boolean(S.data); });
  document.querySelectorAll('.withmodel').forEach(el => { el.hidden = !S.data; });
  if (name === 'measure' && S.data) renderMeasure();
  if (name === 'admin') showAdmin();
  if (name === 'project' && currentProject()) refreshProject();
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => selectTab(b.dataset.tab));

function update() { paint(); renderTree(); if ($('tab-measure').classList.contains('on')) renderMeasure(); }

// ================================================================== measurement engine
// A take-off group is a "spec":
//   { name, ids, by, note,
//     inputs:    [{ key, label, unit, source: 'count'|'property'|'type_dim'|'name_dim', name?, index?, sum? }],
//     constants: [{ key, label, value, unit }],          -> editable yellow assumption cells in Excel
//     formulas:  [{ key, label, unit, expr }] }          -> expr like "({b} + 2*({h} - {slab})) * {L}"
// The same spec gives the preview here and the live Excel formulas, so the two always agree.
const evaluate = (spec) => evaluateSpec(spec, S.byId);

// ---------------------------------------------------------------- manual measure tab
const DEFAULT_Q = /^(area|length|volume|perimeter|face area.*|count)$/i;
function quantitiesFor(ids) {
  const m = new Map();
  for (const id of ids) {
    const e = S.byId.get(id);
    for (const [k, [v, u]] of Object.entries(e.q)) {
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
  return [...m.values()].sort((a, b) => (DEFAULT_Q.test(b.name) - DEFAULT_Q.test(a.name)) || b.n - a.n || a.name.localeCompare(b.name));
}
function defaultName(ids) {
  const types = new Set(ids.map(id => S.byId.get(id).type)), cats = new Set(ids.map(id => S.byId.get(id).cat));
  const lv = new Set(ids.map(id => S.byId.get(id).level));
  const base = types.size === 1 ? [...types][0] : cats.size === 1 ? [...cats][0] : 'Selected elements';
  return base + (lv.size === 1 && [...lv][0] ? ' - ' + [...lv][0] : '');
}
S.customF = [];
function renderMeasure() {
  const box = $('measureBody'); const ids = [...S.ticked];
  if (!ids.length) { box.innerHTML = '<div class="empty">Tick elements in the Elements tab or click them in 3D, then choose what to measure here. For calculated items such as formwork, ask in the AI tab or add a formula column below.</div>'; return; }
  const qs = quantitiesFor(ids);
  box.innerHTML = `<div class="sum">${ids.length} element${ids.length > 1 ? 's' : ''} ticked</div>
    <label class="field">Take-off group name <input type="text" id="gName" value="${esc(defaultName(ids))}"></label>
    <table class="q"><thead><tr><th></th><th>Quantity</th><th>Use as</th><th style="text-align:right">Total</th></tr></thead><tbody>
    <tr><td><input type="checkbox" data-i="-1" checked aria-label="Count"></td><td>Count</td><td><code>{Count}</code></td><td class="v">${ids.length} nr</td></tr>
    ${qs.map((q, i) => `<tr><td><input type="checkbox" data-i="${i}" ${DEFAULT_Q.test(q.name) && q.n >= ids.length / 2 ? 'checked' : ''} aria-label="${esc(q.name)}"></td>
      <td>${esc(q.name)}${q.n < ids.length ? ` <span class="hint">(${q.n} of ${ids.length})</span>` : ''}</td><td><code>{${keyOf(q.name)}}</code></td>
      <td class="v">${q.source === 'type_dim' ? '' : fmt(q.sum, q.unit) + ' ' + esc(q.unit)}</td></tr>`).join('')}
    </tbody></table>
    <h4 style="margin:12px 0 4px">Formula columns</h4>
    <div id="cfList">${S.customF.map((f, i) => `<div class="row"><code>${esc(f.label)} (${esc(f.unit)}) = ${esc(f.expr)}</code> <button data-del="${i}">Remove</button></div>`).join('') || '<div class="hint">None. Example: formwork to beam sides = 2 * {Type_name_size_2} * {Cut_Length}</div>'}</div>
    <div class="row"><input type="text" id="cfLabel" placeholder="Column name" style="flex:1;min-width:110px"><input type="text" id="cfUnit" placeholder="Unit" value="m2" style="width:56px"></div>
    <div class="row"><input type="text" id="cfExpr" placeholder="Formula, e.g. {Length} * {Unconnected_Height} * 2" style="flex:1"><button id="cfAdd">Add column</button></div>
    <div class="row"><label>Sub-totals by <select id="gBy"><option value="type">Type</option><option value="level">Level</option><option value="">None</option></select></label></div>
    <div class="row">
      ${S.inExcel ? '<button class="primary" id="toExcel">Add to Excel take-off</button>' : '<button class="primary" id="toList">Add to take-off list</button>'}
      ${!S.inExcel ? `<button id="csv" ${S.takeoff.length ? '' : 'disabled'}>Download take-off (${S.takeoff.length} groups)</button>` : ''}
    </div>
    <div id="mErr" class="hint"></div>
    <div class="hint">Numbers come from the model properties, converted to metres. Formula columns are written to Excel as live formulas.</div>`;
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
    // inputs referenced by formula columns are added even if not ticked
    S.customF.forEach(f => all.forEach((a, i) => { if (f.expr.includes('{' + a.key + '}')) used.add(i); }));
    const inputs = [];
    if (picked.includes(-1) || S.customF.some(f => f.expr.includes('{Count}'))) inputs.push({ key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true });
    [...used].sort((a, b) => a - b).forEach(i => inputs.push(all[i]));
    const formulas = S.customF.map((f, i) => ({ key: 'F' + (i + 1), label: f.label, unit: f.unit, expr: f.expr }));
    return { name: $('gName').value.trim() || defaultName(ids), ids, by: $('gBy').value, note: '', inputs, constants: [], formulas };
  };
  const go = async (fnc) => { try { const s = build(); evaluate(s); await fnc(s); } catch (err) { $('mErr').textContent = err.message; } };
  if (S.inExcel) $('toExcel').onclick = () => go(addToExcel);
  else {
    $('toList').onclick = () => go(async (s) => { S.takeoff.push(s); status(`Added "${s.name}". ${S.takeoff.length} group(s) in the list.`); renderMeasure(); });
    $('csv') && ($('csv').onclick = downloadCsv);
  }
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
  const csv = lines.map(r => r.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = (S.data?.fileName || 'model').replace(/\.dwfx$/i, '') + '_takeoff.csv'; a.click();
}

// ================================================================== Excel take-off sheet
const SHEET = 'Take-off';
const colL = (n) => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };
async function addToExcel(spec, { save = true } = {}) {
  if (!S.inExcel) throw new Error('Open this add-in inside Excel to write the take-off sheet.');
  const { rows: evRows } = evaluate(spec);              // validates formulas before touching Excel
  try {
    await Excel.run(async (ctx) => {
      let sh = ctx.workbook.worksheets.getItemOrNullObject(SHEET); await ctx.sync();
      if (sh.isNullObject) {
        sh = ctx.workbook.worksheets.add(SHEET);
        sh.getRange('A1').values = [['TAKE-OFF']];
        sh.getRange('A1').format.font.set({ bold: true, size: 14, color: '#0a5082', name: 'Arial' });
        sh.getRange('A2').values = [[`Source: ${S.data.fileName} (${S.data.source}). Quantities in metres. Revit IDs in column B link rows to the 3D model. Yellow cells are assumptions you can change.`]];
        sh.getRange('A2').format.font.set({ italic: true, size: 9, name: 'Arial', color: '#5b6670' });
        ['A:A', 'B:B', 'C:C', 'D:D', 'E:E', 'F:F', 'G:G'].forEach((c, i) => sh.getRange(c).format.columnWidth = [42, 70, 90, 110, 200, 85, 50][i]);
      }
      const used = sh.getUsedRangeOrNullObject(true); used.load('rowCount,rowIndex');
      const colA = sh.getRange('A1:A30000'); colA.load('values');
      await ctx.sync();
      const groupNo = colA.values.filter(r => /^G\d+$/.test(String(r[0]))).length + 1;
      const top = (used.isNullObject ? 2 : used.rowIndex + used.rowCount) + 2;

      const cols = [...spec.inputs, ...spec.formulas];
      const colOf = {}; cols.forEach((c, i) => { colOf[c.key] = colL(7 + i); });
      const last = colL(Math.max(7 + cols.length - 1, 6));
      const width = 7 + cols.length;
      const blank = () => Array(width).fill('');
      const out = [], kinds = [];
      const push = (row, kind) => { const r = blank(); row.forEach((v, i) => { r[i] = v; }); out.push(r); kinds.push(kind); };
      const rowNo = () => top + out.length;

      push([`G${groupNo}`, spec.name], 'title');
      if (spec.note) push(['', 'Method: ' + spec.note], 'note');
      const constCell = {};
      spec.constants.forEach(c => { constCell[c.key] = `$C$${rowNo()}`; push(['', c.label, Number(c.value) || 0, c.unit || ''], 'const'); });
      push(['Ref', 'Revit ID', 'Category', 'Family', 'Type', 'Level', 'Mark', ...cols.map(c => `${c.label} (${c.unit})`)], 'head');
      const toXl = (expr, r) => '=' + String(expr).replace(/\{(\w+)\}/g, (m, k) => colOf[k] ? colOf[k] + r : (constCell[k] || '0'));
      const sumCols = cols.filter(c => c.sum !== false && (c.sum || spec.formulas.includes(c)));

      const key = (e) => spec.by === 'type' ? e.type : spec.by === 'level' ? (e.level || '(no level)') : '';
      const parts = new Map();
      evRows.forEach(x => { const k = key(x.e); if (!parts.has(k)) parts.set(k, []); parts.get(k).push(x); });
      const firstData = rowNo(); let n = 0;
      for (const [k, list] of [...parts].sort((a, b) => a[0].localeCompare(b[0]))) {
        const start = rowNo();
        list.sort((a, b) => (a.e.level || '').localeCompare(b.e.level || '') || a.e.id - b.e.id).forEach(({ e, v }) => {
          n++; const r = rowNo();
          push([`G${groupNo}.${n}`, e.id, e.cat, e.fam, e.type, e.level, e.mark,
            ...spec.inputs.map(i => v[i.key] ?? ''), ...spec.formulas.map(f => toXl(f.expr, r))], 'data');
        });
        if (spec.by && parts.size > 1) {
          const end = rowNo() - 1, r = blank();
          r[1] = `Sub-total ${k}`; sumCols.forEach(c => { r[7 + cols.indexOf(c)] = `=SUBTOTAL(9,${colOf[c.key]}${start}:${colOf[c.key]}${end})`; });
          out.push(r); kinds.push('sub');
        }
      }
      const lastData = rowNo() - 1, tr = blank();
      tr[1] = `Total ${spec.name}`; sumCols.forEach(c => { tr[7 + cols.indexOf(c)] = `=SUBTOTAL(9,${colOf[c.key]}${firstData}:${colOf[c.key]}${lastData})`; });
      out.push(tr); kinds.push('total');

      const end = top + out.length - 1;
      const rng = sh.getRange(`A${top}:${colL(width - 1)}${end}`);
      rng.formulas = out;
      rng.format.font.set({ name: 'Arial', size: 9, color: '#1d2730' });
      const headRow = top + kinds.indexOf('head');
      const B = Excel.BorderIndex;
      [B.edgeTop, B.edgeBottom, B.edgeLeft, B.edgeRight, B.insideHorizontal, B.insideVertical].forEach(ed => {
        const b = sh.getRange(`A${headRow}:${last}${end}`).format.borders.getItem(ed); b.style = 'Continuous'; b.color = '#BFBFBF'; });
      cols.forEach(c => { sh.getRange(`${colOf[c.key]}${headRow + 1}:${colOf[c.key]}${end}`).numberFormat = [[unitFmt(c.unit)]]; });
      spec.formulas.forEach(f => { sh.getRange(`${colOf[f.key]}${headRow}`).format.fill.color = '#E2EFDA'; });   // formula columns marked green
      kinds.forEach((k, i) => {
        const row = sh.getRange(`A${top + i}:${last}${top + i}`);
        if (k === 'title') { row.format.fill.color = '#0a5082'; row.format.font.set({ bold: true, color: '#FFFFFF', size: 10 }); }
        if (k === 'note') { row.format.font.set({ italic: true, color: '#5b6670' }); }
        if (k === 'const') { const c = sh.getRange(`C${top + i}`); c.format.fill.color = '#FFF2CC'; c.format.font.color = '#0000FF'; }
        if (k === 'head') { row.format.fill.color = '#D9E6F2'; row.format.font.bold = true; row.format.wrapText = true; }
        if (k === 'sub') { row.format.fill.color = '#F2F2F2'; row.format.font.bold = true; }
        if (k === 'total') { row.format.fill.color = '#E2E8EE'; row.format.font.bold = true; }
      });
      sh.getRange(`B${top}:B${end}`).format.horizontalAlignment = 'Left';
      sh.activate(); sh.getRange(`A${top}`).select();
      S.quiet = Date.now();
      await ctx.sync();
    });
    S.rowsById = null;
    status(`Added "${spec.name}" to the ${SHEET} sheet.`, 'ok');
  } catch (err) { status('Excel error: ' + err.message, 'bad'); throw err; }
  if (save) await saveTakeoff(spec);
}
// keep a server copy of every group added while a project model is open (editors and owners)
async function saveTakeoff(spec) {
  const p = currentProject();
  if (!p || !S.versionId || !['owner', 'editor'].includes(p.my_role)) return;
  try {
    await api('POST', `/projects/${p.project.id}/takeoffs`, { versionId: S.versionId, spec });
    status(`Added "${spec.name}" to the ${SHEET} sheet and saved it to ${p.project.name}.`, 'ok');
  } catch (err) { status(`Added to Excel, but saving to the project failed: ${err.message}`, 'bad'); }
}

async function rowsById() {
  if (S.rowsById) return S.rowsById;
  S.rowsById = new Map();
  await Excel.run(async (ctx) => {
    const sh = ctx.workbook.worksheets.getItemOrNullObject(SHEET); await ctx.sync();
    if (sh.isNullObject) return;
    const used = sh.getUsedRangeOrNullObject(true); used.load('rowCount'); await ctx.sync();
    if (used.isNullObject) return;
    const r = sh.getRange(`B1:B${used.rowCount + 5}`); r.load('values'); await ctx.sync();
    r.values.forEach(([v], i) => { if (typeof v === 'number' && S.byId.has(v)) { if (!S.rowsById.has(v)) S.rowsById.set(v, []); S.rowsById.get(v).push(i + 1); } });
  }).catch(() => {});
  return S.rowsById;
}
async function goToRows(ids) {
  const map = await rowsById();
  const rows = ids.flatMap(id => map.get(id) || []).slice(0, 80);
  if (!rows.length) return;
  S.quiet = Date.now();
  await Excel.run(async (ctx) => {
    const sh = ctx.workbook.worksheets.getItem(SHEET); sh.activate();
    sh.getRanges(rows.map(r => `A${r}:G${r}`).join(',')).select(); await ctx.sync();
  }).catch(() => {});
}
async function onExcelSelect(ev) {
  if (!S.data || Date.now() - S.quiet < 800) return;
  try {
    await Excel.run(async (ctx) => {
      const sh = ctx.workbook.worksheets.getItem(ev.worksheetId);
      const rng = sh.getRange(ev.address); rng.load('rowIndex,rowCount'); await ctx.sync();
      const first = rng.rowIndex + 1, last = Math.min(rng.rowIndex + rng.rowCount, first + 5000);
      const v = sh.getRange(`A${first}:B${last}`); v.load('values'); await ctx.sync();
      const ids = new Set();
      v.values.forEach(([, b]) => { if (typeof b === 'number' && S.byId.has(b)) ids.add(b); });
      if (!ids.size && /^G\d+$/.test(String(v.values[0][0]))) {
        const blk = sh.getRange(`A${first}:B${first + 5000}`); blk.load('values'); await ctx.sync();
        for (const [a, b] of blk.values.slice(1)) {
          if (/^G\d+$/.test(String(a))) break;
          if (typeof b === 'number' && S.byId.has(b)) ids.add(b);
        }
      }
      if (!ids.size) return;
      S.ticked = ids; update(); fit([...ids].filter(id => S.meshById.has(id)));
      status(`${ids.size} element${ids.size > 1 ? 's' : ''} highlighted from Excel.`);
    });
  } catch { /* other sheets are ignored */ }
}

// ================================================================== AI assistant
function modelSummary() {
  const items = [];
  for (const [cat, fams] of S.tree) for (const [fam, types] of fams) for (const [typ, ids] of types) {
    const qn = {};
    ids.slice(0, 50).forEach(id => Object.entries(S.byId.get(id).q).forEach(([k, [v, u]]) => { if (!(k in qn)) qn[k] = { unit: u, sample: +v.toFixed(3) }; }));
    items.push({ category: cat, family: fam, type: typ, count: ids.length,
      levels: [...new Set(ids.map(id => S.byId.get(id).level).filter(Boolean))],
      type_name_sizes_m: dimsOf(typ), quantities: qn });
  }
  return { file: S.data.fileName, units: 'metres (m, m2, m3)', levels: [...new Set(S.E.map(e => e.level).filter(Boolean))],
    ticked_now: S.ticked.size, items: items.slice(0, 2500) };
}
function applyFilter(f = {}) {
  if (f.use_ticked) return [...S.ticked];
  const lc = (a) => (a || []).map(s => String(s).toLowerCase());
  const [cat, fam, typ, inc, exc, lev] = [lc(f.category), lc(f.family), lc(f.type), lc(f.type_contains), lc(f.type_excludes), lc(f.level)];
  return S.E.filter(e => {
    const t = e.type.toLowerCase();
    return (!cat.length || cat.includes(e.cat.toLowerCase())) && (!fam.length || fam.includes(e.fam.toLowerCase())) &&
      (!typ.length || typ.includes(t)) && (!inc.length || inc.some(s => t.includes(s))) &&
      (!exc.length || !exc.some(s => t.includes(s))) && (!lev.length || lev.includes((e.level || '').toLowerCase()));
  }).map(e => e.id);
}
// turn an AI group into a spec (also accepts the simple {quantities:[...]} form)
function specFromAI(g) {
  const ids = applyFilter(g.filter);
  let inputs = (g.inputs || []).map(i => ({ key: keyOf(i.key || i.name || i.label), label: i.label || i.name || i.key, unit: i.unit || (i.source === 'count' ? 'nr' : 'm'),
    source: i.source || 'property', name: i.name, index: i.index, sum: i.sum ?? (i.source === 'count') }));
  if (!inputs.length && g.quantities) {
    inputs = g.quantities.map(q => /^count$/i.test(q) ? { key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true }
      : { key: keyOf(q), label: q, unit: (quantitiesFor(ids).find(x => x.name === q) || {}).unit || '', source: 'property', name: q, sum: true });
  }
  const constants = (g.constants || []).map(c => ({ key: keyOf(c.key || c.label), label: c.label || c.key, value: Number(c.value) || 0, unit: c.unit || '' }));
  const formulas = (g.formulas || []).map((f, i) => ({ key: keyOf(f.key || 'F' + (i + 1)), label: f.label || f.key, unit: f.unit || '', expr: f.expr }));
  return { name: g.name || defaultName(ids), ids, by: g.group_by ?? 'type', note: g.note || '', inputs, constants, formulas };
}
$('aiGo').onclick = async () => {
  const ask = $('aiAsk').value.trim(); if (!ask) return;
  const out = $('aiOut'); out.innerHTML = '<div class="hint">The AI is working out the measurement method…</div>';
  try {
    const data = await api('POST', '/ai', { request: ask, summary: modelSummary(), projectId: currentProject()?.project.id });
    renderPlan(data.plan || {}, data.model);
  } catch (err) { out.innerHTML = `<div class="aimsg" style="color:var(--danger)">${esc(err.message)}</div>`; }
};
function renderPlan(plan, model) {
  const out = $('aiOut'); out.innerHTML = '';
  if (plan.message) out.insertAdjacentHTML('beforeend', `<div class="aimsg">${esc(plan.message)}</div>`);
  (plan.groups || []).forEach((g) => {
    const spec = specFromAI(g);
    const card = document.createElement('div'); card.className = 'card ai-card'; out.append(card);
    const draw = () => {
      let ev, err = '';
      try { ev = evaluate(spec); } catch (e) { err = e.message; }
      const cols = [...spec.inputs, ...spec.formulas];
      const first = ev?.rows[0];
      card.innerHTML = `<h3>${esc(spec.name)}</h3>
        <div>${spec.ids.length} element${spec.ids.length === 1 ? '' : 's'} found</div>
        ${spec.note ? `<div class="note">Method: ${esc(spec.note)}</div>` : ''}
        ${spec.formulas.map(f => `<div><code>${esc(f.label)} (${esc(f.unit)}) = ${esc(f.expr)}</code></div>`).join('')}
        ${spec.constants.length ? `<div class="note">Assumptions (editable, also editable later in Excel):</div>` + spec.constants.map((c, i) =>
          `<div class="row"><label>${esc(c.label)} <input type="text" data-c="${i}" value="${c.value}" style="width:70px"> ${esc(c.unit)}</label></div>`).join('') : ''}
        ${err ? `<div style="color:var(--danger)">${esc(err)}</div>` : `<table class="q"><thead><tr><th>Column</th><th style="text-align:right">Total</th><th style="text-align:right">1st element</th></tr></thead><tbody>
          ${cols.map(c => `<tr><td>${esc(c.label)} <span class="hint">${esc(c.unit)}</span>${ev.missing[c.key] ? ` <span class="hint">(${ev.missing[c.key]} missing)</span>` : ''}</td>
            <td class="v">${ev.tot[c.key] != null ? fmt(ev.tot[c.key], c.unit === 'nr' ? '' : c.unit) : ''}</td>
            <td class="v">${first && first.v[c.key] != null ? fmt(first.v[c.key], c.unit === 'nr' ? '' : c.unit) : ''}</td></tr>`).join('')}
          </tbody></table>`}
        <div class="row"><button data-a="tick">Show in model</button>${spec.ids.length && !err ? `<button class="primary" data-a="add">${S.inExcel ? 'Add to Excel' : 'Add to list'}</button>` : ''}</div>`;
      card.querySelectorAll('input[data-c]').forEach(inp => inp.onchange = () => { spec.constants[+inp.dataset.c].value = Number(inp.value) || 0; draw(); });
      card.querySelector('[data-a=tick]').onclick = () => { S.ticked = new Set(spec.ids); update(); fit(spec.ids.filter(id => S.meshById.has(id))); };
      const add = card.querySelector('[data-a=add]');
      if (add) add.onclick = async () => {
        try {
          if (S.inExcel) await addToExcel(spec); else { S.takeoff.push(spec); status(`Added "${spec.name}" to the take-off list.`); }
          add.disabled = true; add.textContent = 'Added';
        } catch { /* status already shows the error */ }
      };
    };
    draw();
  });
  if (!(plan.groups || []).length && !plan.message) out.innerHTML = '<div class="aimsg">The AI did not return a plan. Describe the elements and what to measure more clearly.</div>';
  if (model) out.insertAdjacentHTML('beforeend', `<div class="hint">AI model: ${esc(model)}. The AI chose the elements and method; every number above is calculated by the add-in from the model.</div>`);
}

// ================================================================== element properties (right-click)
function showProps(id) {
  const e = S.byId.get(id); if (!e) return;
  const p = $('props'); p.hidden = false;
  const qRows = Object.entries(e.q).sort().map(([k, [v, u]]) => `<tr><td>${esc(k)}</td><td class="v">${fmt(v, u)} ${esc(u)}</td></tr>`).join('');
  const all = Object.entries(e.props).sort((a, b) => a[0].localeCompare(b[0]));
  p.innerHTML = `<div class="ph"><div style="min-width:0"><strong>${esc(e.type)}</strong><div class="hint">${esc(e.cat)} › ${esc(e.fam)}</div></div>
      <button id="pClose" aria-label="Close properties">Close</button></div>
    <div class="row"><button id="pTick">${S.ticked.has(id) ? 'Untick' : 'Tick'}</button><button id="pZoom">Zoom to</button></div>
    <table class="q"><tbody>
      <tr><td>Revit ID</td><td class="v">${e.id}</td></tr><tr><td>Level</td><td class="v">${esc(e.level || '-')}</td></tr>
      ${e.mark ? `<tr><td>Mark</td><td class="v">${esc(e.mark)}</td></tr>` : ''}
      ${dimsOf(e.type).length ? `<tr><td>Size from type name</td><td class="v">${dimsOf(e.type).map(d => d.toFixed(3)).join(' x ')} m</td></tr>` : ''}
    </tbody></table>
    <h4>Quantities (metres)</h4><table class="q"><tbody>${qRows || '<tr><td class="hint">None</td></tr>'}</tbody></table>
    <h4>All properties</h4><input type="text" id="pFind" placeholder="Filter properties" style="width:100%;margin-bottom:4px">
    <table class="q" id="pAll"><tbody>${all.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="v" style="white-space:normal">${esc(v)}</td></tr>`).join('')}</tbody></table>`;
  $('pClose').onclick = () => { p.hidden = true; };
  $('pTick').onclick = () => { S.ticked.has(id) ? S.ticked.delete(id) : S.ticked.add(id); update(); showProps(id); };
  $('pZoom').onclick = () => fit([id].filter(i => S.meshById.has(i)));
  $('pFind').oninput = (ev) => { const q = ev.target.value.toLowerCase(); $('pAll').querySelectorAll('tr').forEach(tr => { tr.hidden = !tr.textContent.toLowerCase().includes(q); }); };
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('props').hidden = true; });

// ================================================================== loading a model
function loadModelData(data, { versionId = null, label = '' } = {}) {
  S.data = data; S.E = data.elements; S.byId = new Map(S.E.map(e => [e.id, e]));
  S.versionId = versionId;
  S.ticked.clear(); S.isolated = false; S.search = ''; S.level = ''; S.open.clear(); S.rowsById = null; S.catColor.clear(); mats.clear();
  $('search').value = ''; $('aiOut').innerHTML = ''; $('props').hidden = true; $('pickInfo').hidden = true;
  buildTree();
  $('ctxModel').textContent = label || data.fileName;
  const levels = [...new Set(S.E.map(e => e.level).filter(Boolean))];
  $('level').innerHTML = '<option value="">All levels</option>' + levels.map(l => `<option>${esc(l)}</option>`).join('');
  selectTab('elements');
  buildScene(data.geometry);
  renderTree(); paint();
  const shown = S.E.filter(e => S.meshById.has(e.id)).length;
  status(`${S.E.length} elements in ${S.tree.size} categories, ${shown} shown in 3D.` + (data.geoNote ? ' ' + data.geoNote : ''), 'ok');
}
function closeModel() {
  S.data = null; S.E = []; S.byId = new Map(); S.versionId = null; S.ticked.clear(); root.clear(); S.meshes = []; S.meshById = new Map();
  $('ctxModel').textContent = 'No model open'; selectTab(currentTab); invalidate();
}
async function withViewerBusy(msg, fn) {
  $('viewer').hidden = false; resize();
  const v = $('vload'); v.hidden = false; v.textContent = msg; status(msg);
  try { return await fn(); } finally { v.hidden = true; }
}
async function openVersion(vid) {
  const p = currentProject();
  const m = p?.models.find(x => x.versions.some(v => v.id === vid));
  const v = m?.versions.find(x => x.id === vid);
  const label = m ? `${m.name} v${v.version} · ${v.file_name}` : '';
  try {
    const data = await withViewerBusy(`Opening ${label || 'model'}…`, async () => {
      const res = await api('GET', `/versions/${vid}/model`, null, { raw: true });
      return res.json();
    });
    loadModelData(data, { versionId: vid, label });
    try { localStorage.setItem('dwfxLastVersion', vid); } catch { /* storage blocked */ }
  } catch (err) { status('Could not open the model: ' + err.message, 'bad'); if (!S.data) selectTab('project'); }
}
async function quickOpen(file) {
  const fd = new FormData(); fd.append('model', file, file.name);
  try {
    const data = await withViewerBusy(`Reading ${file.name}. Large models can take a minute…`, () => api('POST', '/model', fd));
    loadModelData(data, { label: `${file.name} (not saved)` });
  } catch (err) { status('Could not open this file: ' + err.message, 'bad'); if (!S.data) selectTab('project'); }
}

// ================================================================== sign-in, header, theme
function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join(''); }
function showSignedIn(user) {
  $('signin').hidden = true; $('shell').hidden = false;
  $('userBtn').textContent = initials(user.name); $('userBtn').title = `${user.name} (${user.email})`;
  $('umName').textContent = user.name; $('umEmail').textContent = user.email;
  $('adminTab').hidden = user.role !== 'admin';
  resize();
}
function showSignIn(msg) {
  $('shell').hidden = true; $('signin').hidden = false; $('userMenu').hidden = true;
  $('siErr').hidden = !msg; $('siErr').textContent = msg || '';
  setTimeout(() => ($('siEmail').value ? $('siPw') : $('siEmail')).focus(), 0);
}
App.onSignedOut = () => { resetProjects(); closeModel(); showSignIn('Your session has ended. Please sign in again.'); };
$('signinForm').onsubmit = async (e) => {
  e.preventDefault();
  const email = $('siEmail').value.trim(), password = $('siPw').value;
  if (!email || !password) { $('siErr').hidden = false; $('siErr').textContent = 'Enter your email and password.'; return; }
  $('siGo').disabled = true; $('siGo').textContent = 'Signing in…';
  try {
    const r = await api('POST', '/auth/login', { email, password });
    session.set({ token: r.token, user: r.user }); $('siPw').value = '';
    try { localStorage.setItem('dwfxEmail', email); } catch { /* storage blocked */ }
    showSignedIn(r.user); await startProjects();
  } catch (err) { $('siErr').hidden = false; $('siErr').textContent = err.status === 401 ? 'The email or password is not correct.' : err.message; }
  finally { $('siGo').disabled = false; $('siGo').textContent = 'Sign in'; }
};
$('userBtn').onclick = (e) => { e.stopPropagation(); const m = $('userMenu'); m.hidden = !m.hidden; $('userBtn').setAttribute('aria-expanded', String(!m.hidden)); };
document.addEventListener('click', (e) => { if (!$('userMenu').contains(e.target)) { $('userMenu').hidden = true; $('userBtn').setAttribute('aria-expanded', 'false'); } });
$('umOut').onclick = async () => {
  if (!await confirmBox({ title: 'Sign out?', body: '<p>Your projects stay saved on the server. Your workbook is not changed.</p>', confirmLabel: 'Sign out' })) return;
  try { await api('POST', '/auth/logout'); } catch { /* already signed out */ }
  session.set(null); resetProjects(); closeModel(); showSignIn();
};

const THEMES = ['office', 'light', 'dark'];
const THEME_LABEL = { office: 'Theme: follow Office', light: 'Theme: light', dark: 'Theme: dark' };
let themePref = 'office';
try { themePref = localStorage.getItem('dwfxTheme') || 'office'; } catch { /* storage blocked */ }
function officeIsDark() {
  try {
    const bg = Office.context.officeTheme?.bodyBackgroundColor;
    if (!bg) return null;
    const n = parseInt(bg.replace('#', ''), 16), lum = 0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255);
    return lum < 128;
  } catch { return null; }
}
function applyTheme() {
  const d = document.documentElement;
  let dark = themePref === 'dark' ? true : themePref === 'light' ? false : officeIsDark();
  if (dark == null) d.removeAttribute('data-theme'); else d.dataset.theme = dark ? 'dark' : 'light';
  $('umTheme').textContent = THEME_LABEL[themePref];
  scene.background = new THREE.Color(getComputedStyle(d).getPropertyValue('--viewer').trim() || '#e8eaec');
  edgeMat.color.set(dark ? '#c8ced3' : '#3b444c'); invalidate();
}
$('umTheme').onclick = () => {
  themePref = THEMES[(THEMES.indexOf(themePref) + 1) % THEMES.length];
  try { localStorage.setItem('dwfxTheme', themePref); } catch { /* storage blocked */ }
  applyTheme();
};

async function startProjects() {
  selectTab('project');
  let last = null; try { last = localStorage.getItem('dwfxLastProject:' + (session.get()?.user?.id || '')); } catch { /* storage blocked */ }
  if (last) await openProject(last, false, true); else await showProjects();
}
$('aiChips').addEventListener('click', (e) => { const b = e.target.closest('[data-ask]'); if (b) { $('aiAsk').value = b.dataset.ask; $('aiAsk').focus(); } });

// ================================================================== App registry (used by the project screen and the ribbon)
Object.assign(App, {
  selectTab, openVersion, quickOpen, closeModel, addToExcel,
  currentVersionId: () => S.versionId,
  setContext: (project) => { $('ctxProject').textContent = project ? project.name : 'DWFx Measure'; },
  fit: () => fit(), showAll: () => $('showAll').click(),
  isolate: () => $('isolate').click(),
  clear: () => { S.ticked.clear(); S.isolated = false; update(); },
  selectFromRows: async () => {
    if (!S.data) { status('Open a model first.', 'bad'); return; }
    await Excel.run(async (ctx) => {
      const r = ctx.workbook.getSelectedRange(); r.load('address'); const sh = ctx.workbook.worksheets.getActiveWorksheet(); sh.load('id');
      await ctx.sync();
      S.quiet = 0; await onExcelSelect({ worksheetId: sh.id, address: r.address.split('!').pop() });
    });
  },
});

// ================================================================== ribbon commands (shared runtime)
const RIBBON = {
  openProjects: () => selectTab('project'), openElements: () => selectTab('elements'), openMeasure: () => selectTab('measure'),
  openAI: () => { selectTab('ai'); $('aiAsk')?.focus(); }, openAdmin: () => { if (session.get()?.user?.role !== 'admin') status('Admin is for administrators only.', 'bad'); else selectTab('admin'); },
  viewFit: () => App.fit(), viewShowAll: () => App.showAll(), viewIsolate: () => App.isolate(), viewClear: () => App.clear(),
  selectFromExcel: () => App.selectFromRows(), refreshProject: () => refreshProject(),
};
function registerRibbon() {
  if (typeof Office === 'undefined' || !Office.actions?.associate) return;
  for (const [name, fn] of Object.entries(RIBBON)) {
    Office.actions.associate(name, async (event) => {
      try { await Office.addin?.showAsTaskpane?.(); } catch { /* older Office */ }
      try { if (!session.get()?.token) showSignIn('Sign in first.'); else await fn(); }
      catch (err) { status(err.message, 'bad'); }
      event.completed();
    });
  }
}

// ================================================================== start
const officeReady = (typeof Office !== 'undefined') ? Office.onReady().catch(() => ({ host: null })) : Promise.resolve({ host: null });
officeReady.then(async (info) => {
  S.inExcel = typeof Office !== 'undefined' && info?.host === Office.HostType.Excel;
  if (S.inExcel) {
    Excel.run(async (ctx) => { ctx.workbook.worksheets.onSelectionChanged.add(onExcelSelect); await ctx.sync(); }).catch(() => {});
    registerRibbon();
    try { Office.context.document.addHandlerAsync?.(Office.EventType.OfficeThemeChanged, applyTheme); } catch { /* not supported */ }
  }
  applyTheme();
  try { $('siEmail').value = localStorage.getItem('dwfxEmail') || ''; } catch { /* storage blocked */ }
  const s = session.get();
  if (!s?.token) return showSignIn();
  try {
    const { user } = await api('GET', '/auth/me');
    session.set({ ...s, user }); showSignedIn(user); await startProjects();
  } catch (err) { if (err.status !== 401) showSignIn(err.message); }
});

window.__dwfx = { S, App, update, fit, applyFilter, renderPlan, quantitiesFor, evaluate, specFromAI, showProps, loadModelData, selectTab };
