import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ================================================================== state
const S = {
  inExcel: false, data: null, E: [], byId: new Map(), meshes: [], meshById: new Map(),
  ticked: new Set(), isolated: false, search: '', level: '', open: new Set(),
  tree: null, catColor: new Map(), takeoff: [], rowsById: null, quiet: 0,
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const status = (msg, err = false) => { const el = $('status'); el.textContent = msg; el.className = err ? 'err' : ''; };
const fmt = (v, u) => (u === 'm' ? v.toFixed(3) : u === '' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v.toFixed(2))
  .replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// muted, distinguishable colours for categories (assigned in order of size)
const PALETTE = ['#8a9aa6', '#c98a2b', '#2f6fa3', '#b5473a', '#6b5b8c', '#7a8a5a', '#3f8f8a', '#a8794f',
  '#5d6f8f', '#9a5d7a', '#6f8f3f', '#4f7fa8', '#b0905a', '#7d7d7d'];

// ================================================================== 3D viewer
const host = $('viewer');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
host.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#e9ebec');
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(1, 2, 1.5); scene.add(sun);
const root = new THREE.Group(); scene.add(root);
function resize() {
  const w = host.clientWidth, h = Math.max(host.clientHeight, 1);
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
(function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();

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
  controls.target.copy(c); controls.update();
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
  $('isolate').setAttribute('aria-pressed', String(S.isolated));
  $('selCount').textContent = S.ticked.size ? `(${S.ticked.size})` : '';
}

// click in 3D: tick that element (Ctrl/Shift adds)
const ray = new THREE.Raycaster(); let down = null;
renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  const hit = ray.intersectObjects(S.meshes.filter(m => m.visible), false)[0];
  const id = hit?.object.userData.id;
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
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'measure') renderMeasure();
});

function update() { paint(); renderTree(); if ($('tab-measure').classList.contains('on')) renderMeasure(); }

// ================================================================== measure
const DEFAULT_Q = /^(area|length|volume|perimeter|face area.*|count)$/i;
function quantitiesFor(ids) {
  const m = new Map();
  for (const id of ids) {
    const e = S.byId.get(id);
    for (const [k, [v, u]] of Object.entries(e.q)) {
      const key = k + '|' + u;
      if (!m.has(key)) m.set(key, { name: k, unit: u, n: 0, sum: 0 });
      const o = m.get(key); o.n++; o.sum += v;
    }
  }
  return [...m.values()].sort((a, b) => (DEFAULT_Q.test(b.name) - DEFAULT_Q.test(a.name)) || b.n - a.n || a.name.localeCompare(b.name));
}
function defaultName(ids) {
  const types = new Set(ids.map(id => S.byId.get(id).type)), cats = new Set(ids.map(id => S.byId.get(id).cat));
  const lv = new Set(ids.map(id => S.byId.get(id).level));
  const base = types.size === 1 ? [...types][0] : cats.size === 1 ? [...cats][0] : 'Selected elements';
  return base + (lv.size === 1 && [...lv][0] ? ' - ' + [...lv][0] : '');
}
function renderMeasure() {
  const box = $('measureBody'); const ids = [...S.ticked];
  if (!ids.length) { box.innerHTML = '<div class="empty">Tick elements in the Elements tab or click them in 3D, then choose what to measure here.</div>'; return; }
  const qs = quantitiesFor(ids);
  box.innerHTML = `<div class="sum">${ids.length} element${ids.length > 1 ? 's' : ''} ticked</div>
    <label class="field">Take-off group name <input type="text" id="gName" value="${esc(defaultName(ids))}"></label>
    <table class="q"><thead><tr><th></th><th>Quantity</th><th>Elements</th><th style="text-align:right">Total</th></tr></thead><tbody>
    <tr><td><input type="checkbox" data-q="Count|nr" checked aria-label="Count"></td><td>Count</td><td>${ids.length}</td><td class="v">${ids.length} nr</td></tr>
    ${qs.map((q, i) => `<tr><td><input type="checkbox" data-q="${esc(q.name)}|${esc(q.unit)}" ${DEFAULT_Q.test(q.name) && q.n >= ids.length / 2 ? 'checked' : ''} aria-label="${esc(q.name)}"></td>
      <td>${esc(q.name)}</td><td>${q.n}${q.n < ids.length ? ' of ' + ids.length : ''}</td><td class="v">${fmt(q.sum, q.unit)} ${esc(q.unit)}</td></tr>`).join('')}
    </tbody></table>
    <div class="row"><label>Sub-totals by <select id="gBy"><option value="type">Type</option><option value="level">Level</option><option value="">None</option></select></label></div>
    <div class="row">
      ${S.inExcel ? '<button class="primary" id="toExcel">Add to Excel take-off</button>' : '<button class="primary" id="toList">Add to take-off list</button>'}
      ${!S.inExcel ? `<button id="csv" ${S.takeoff.length ? '' : 'disabled'}>Download take-off (${S.takeoff.length} groups)</button>` : ''}
    </div>
    <div class="hint">Numbers come straight from the model properties, converted to metres. Check rounding: Revit exports areas to the precision set in the model's project units.</div>`;
  const pick = () => [...box.querySelectorAll('input[data-q]:checked')].map(c => { const [name, unit] = c.dataset.q.split('|'); return { name, unit }; });
  const group = () => ({ name: $('gName').value.trim() || defaultName(ids), ids, qs: pick(), by: $('gBy').value });
  if (S.inExcel) $('toExcel').onclick = () => addToExcel(group());
  else {
    $('toList').onclick = () => { S.takeoff.push(group()); status(`Added "${group().name}". ${S.takeoff.length} group(s) in the list.`); renderMeasure(); };
    $('csv') && ($('csv').onclick = downloadCsv);
  }
}
const qv = (e, q) => q.name === 'Count' ? 1 : (e.q[q.name] && e.q[q.name][1] === q.unit ? e.q[q.name][0] : null);

function downloadCsv() {
  const lines = [];
  S.takeoff.forEach((g, gi) => {
    lines.push([`G${gi + 1} ${g.name}`]);
    lines.push(['Revit ID', 'Category', 'Family', 'Type', 'Level', 'Mark', ...g.qs.map(q => `${q.name} (${q.unit})`)]);
    g.ids.forEach(id => { const e = S.byId.get(id); lines.push([e.id, e.cat, e.fam, e.type, e.level, e.mark, ...g.qs.map(q => qv(e, q) ?? '')]); });
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
async function addToExcel(g) {
  if (!g.qs.length) { status('Tick at least one quantity.', true); return; }
  try {
    await Excel.run(async (ctx) => {
      let sh = ctx.workbook.worksheets.getItemOrNullObject(SHEET); await ctx.sync();
      if (sh.isNullObject) {
        sh = ctx.workbook.worksheets.add(SHEET);
        sh.getRange('A1').values = [['TAKE-OFF']];
        sh.getRange('A1').format.font.set({ bold: true, size: 14, color: '#0a5082', name: 'Arial' });
        sh.getRange('A2').values = [[`Source: ${S.data.fileName} (${S.data.source}). Quantities from model properties, in metres. Revit IDs in column B link rows to the 3D model.`]];
        sh.getRange('A2').format.font.set({ italic: true, size: 9, name: 'Arial', color: '#5b6670' });
        ['A:A', 'B:B', 'C:C', 'D:D', 'E:E', 'F:F', 'G:G'].forEach((c, i) => sh.getRange(c).format.columnWidth = [42, 60, 90, 110, 200, 85, 50][i]);
      }
      const used = sh.getUsedRangeOrNullObject(true); used.load('rowCount,rowIndex');
      const colA = sh.getRange('A1:A20000'); colA.load('values');
      await ctx.sync();
      const groupNo = colA.values.filter(r => /^G\d+$/.test(String(r[0]))).length + 1;
      let r = (used.isNullObject ? 2 : used.rowIndex + used.rowCount) + 2;   // 1-based next free row with a gap

      const qCols = g.qs.map((q, i) => colL(7 + i));            // H, I, ...
      const last = qCols.at(-1);
      const head = ['Ref', 'Revit ID', 'Category', 'Family', 'Type', 'Level', 'Mark', ...g.qs.map(q => `${q.name} (${q.unit})`)];
      const rows = [], fmts = [];
      const title = r;
      rows.push([`G${groupNo}`, g.name, ...Array(head.length - 2).fill('')]); fmts.push('title');
      rows.push(head); fmts.push('head');
      const els = g.ids.map(id => S.byId.get(id));
      const key = (e) => g.by === 'type' ? e.type : g.by === 'level' ? (e.level || '(no level)') : '';
      const parts = new Map(); els.forEach(e => { const k = key(e); if (!parts.has(k)) parts.set(k, []); parts.get(k).push(e); });
      const firstData = title + 2;
      let n = 0;
      for (const [k, list] of [...parts].sort((a, b) => a[0].localeCompare(b[0]))) {
        const start = title + rows.length;
        list.sort((a, b) => (a.level || '').localeCompare(b.level || '') || a.id - b.id).forEach(e => {
          n++;
          rows.push([`G${groupNo}.${n}`, e.id, e.cat, e.fam, e.type, e.level, e.mark, ...g.qs.map(q => qv(e, q) ?? '')]); fmts.push('data');
        });
        if (g.by && parts.size > 1) {
          const end = title + rows.length - 1;
          rows.push(['', `Sub-total ${k}`, '', '', '', '', '', ...qCols.map(c => `=SUBTOTAL(9,${c}${start}:${c}${end})`)]); fmts.push('sub');
        }
      }
      const lastData = title + rows.length - 1;
      rows.push(['', `Total ${g.name}`, '', '', '', '', '', ...qCols.map(c => `=SUBTOTAL(9,${c}${firstData}:${c}${lastData})`)]); fmts.push('total');

      const rng = sh.getRange(`A${title}:${last}${title + rows.length - 1}`);
      rng.formulas = rows;
      rng.format.font.set({ name: 'Arial', size: 9 });
      const B = Excel.BorderIndex, edges = [B.edgeTop, B.edgeBottom, B.edgeLeft, B.edgeRight, B.insideHorizontal, B.insideVertical];
      edges.forEach(ed => { const b = sh.getRange(`A${title + 1}:${last}${title + rows.length - 1}`).format.borders.getItem(ed); b.style = 'Continuous'; b.color = '#BFBFBF'; });
      g.qs.forEach((q, i) => sh.getRange(`${qCols[i]}${title + 2}:${qCols[i]}${title + rows.length - 1}`).numberFormat =
        [[q.name === 'Count' ? '#,##0' : q.unit === 'm' ? '#,##0.000' : '#,##0.00']]);
      fmts.forEach((f, i) => {
        const row = sh.getRange(`A${title + i}:${last}${title + i}`);
        if (f === 'title') { row.format.fill.color = '#0a5082'; row.format.font.set({ bold: true, color: '#FFFFFF', size: 10 }); }
        if (f === 'head') { row.format.fill.color = '#D9E6F2'; row.format.font.bold = true; row.format.wrapText = true; }
        if (f === 'sub') { row.format.fill.color = '#F2F2F2'; row.format.font.bold = true; }
        if (f === 'total') { row.format.fill.color = '#E2E8EE'; row.format.font.bold = true; }
      });
      sh.getRange(`B${title}:B${title + rows.length}`).format.horizontalAlignment = 'Left';
      sh.activate(); sh.getRange(`A${title}`).select();
      S.quiet = Date.now();
      await ctx.sync();
    });
    S.rowsById = null;
    status(`Added G-group "${g.name}" to the ${SHEET} sheet.`);
  } catch (err) { status('Excel error: ' + err.message, true); }
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
// Excel selection -> tick in 3D (any sheet with Revit IDs in column B; a G-title row selects its whole group)
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
      if (!ids.size && /^G\d+$/.test(String(v.values[0][0]))) {           // group title row
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
    const qn = {}; ids.slice(0, 50).forEach(id => Object.entries(S.byId.get(id).q).forEach(([k, [, u]]) => { qn[k] = u; }));
    items.push({ category: cat, family: fam, type: typ, count: ids.length,
      levels: [...new Set(ids.map(id => S.byId.get(id).level).filter(Boolean))], quantities: qn });
  }
  return { file: S.data.fileName, levels: [...new Set(S.E.map(e => e.level).filter(Boolean))], items: items.slice(0, 3000) };
}
function applyFilter(f = {}) {
  const lc = (a) => (a || []).map(s => String(s).toLowerCase());
  const [cat, fam, typ, inc, exc, lev] = [lc(f.category), lc(f.family), lc(f.type), lc(f.type_contains), lc(f.type_excludes), lc(f.level)];
  return S.E.filter(e => {
    const t = e.type.toLowerCase();
    return (!cat.length || cat.includes(e.cat.toLowerCase())) && (!fam.length || fam.includes(e.fam.toLowerCase())) &&
      (!typ.length || typ.includes(t)) && (!inc.length || inc.some(s => t.includes(s))) &&
      (!exc.length || !exc.some(s => t.includes(s))) && (!lev.length || lev.includes((e.level || '').toLowerCase()));
  }).map(e => e.id);
}
$('aiGo').onclick = async () => {
  const ask = $('aiAsk').value.trim(); if (!ask) return;
  const out = $('aiOut'); out.innerHTML = '<div class="hint">Asking the AI…</div>';
  try {
    const res = await fetch('api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-token': token() },
      body: JSON.stringify({ request: ask, summary: modelSummary() }) });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || res.statusText);
    renderPlan(data.plan || {}, data.model);
  } catch (err) { out.innerHTML = `<div class="aimsg" style="color:var(--danger)">${esc(err.message)}</div>`; }
};
function renderPlan(plan, model) {
  const out = $('aiOut'); out.innerHTML = '';
  if (plan.message) out.insertAdjacentHTML('beforeend', `<div class="aimsg">${esc(plan.message)}</div>`);
  (plan.groups || []).forEach((g) => {
    const ids = applyFilter(g.filter);
    const want = (g.quantities || ['Count']).map(String);
    const qs = [{ name: 'Count', unit: 'nr' }, ...quantitiesFor(ids).filter(q => want.some(w => w.toLowerCase() === q.name.toLowerCase()))
      .map(q => ({ name: q.name, unit: q.unit }))].filter((q, i) => i > 0 || want.some(w => /count/i.test(w)) || want.length === 0);
    const totals = quantitiesFor(ids);
    const card = document.createElement('div'); card.className = 'card';
    card.innerHTML = `<h3>${esc(g.name || 'Group')}</h3>
      <div>${ids.length} element${ids.length === 1 ? '' : 's'} found${qs.filter(q => q.name !== 'Count').map(q => {
        const t = totals.find(x => x.name === q.name && x.unit === q.unit); return t ? `, ${esc(q.name)} ${fmt(t.sum, t.unit)} ${esc(t.unit)}` : ''; }).join('')}</div>
      ${g.note ? `<div class="note">${esc(g.note)}</div>` : ''}
      <div class="row"><button data-a="tick">Show in model</button>${ids.length ? `<button class="primary" data-a="add">${S.inExcel ? 'Add to Excel' : 'Add to list'}</button>` : ''}</div>`;
    card.querySelector('[data-a=tick]').onclick = () => { S.ticked = new Set(ids); update(); fit(ids.filter(id => S.meshById.has(id))); };
    const add = card.querySelector('[data-a=add]');
    if (add) add.onclick = async () => {
      const grp = { name: g.name || defaultName(ids), ids, qs: qs.length ? qs : [{ name: 'Count', unit: 'nr' }], by: 'type' };
      if (S.inExcel) await addToExcel(grp); else { S.takeoff.push(grp); status(`Added "${grp.name}" to the take-off list.`); }
      add.disabled = true; add.textContent = 'Added';
    };
    out.append(card);
  });
  if (!(plan.groups || []).length && !plan.message) out.innerHTML = '<div class="aimsg">The AI did not return a plan. Try describing the elements and quantities more clearly.</div>';
  if (model) out.insertAdjacentHTML('beforeend', `<div class="hint">Model: ${esc(model)}. Element counts and totals above are calculated by the add-in.</div>`);
}

// ================================================================== loading a model
const token = () => $('token').value;
try { $('token').value = localStorage.getItem('dwfxToken') || ''; } catch { /* storage blocked */ }
const drop = $('drop');
drop.onclick = () => $('file').click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } };
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); };
$('file').onchange = (e) => e.target.files[0] && load(e.target.files[0]);

async function load(file) {
  const st = $('startStatus'); st.className = '';
  st.textContent = `Reading ${file.name}. Large models can take a minute…`;
  try { localStorage.setItem('dwfxToken', token()); } catch { /* storage blocked */ }
  const fd = new FormData(); fd.append('model', file, file.name);
  try {
    const res = await fetch('api/model', { method: 'POST', body: fd, headers: { 'x-app-token': token() } });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || res.statusText);
    S.data = data; S.E = data.elements; S.byId = new Map(S.E.map(e => [e.id, e]));
    S.ticked.clear(); S.isolated = false; S.search = ''; S.level = ''; S.open.clear(); S.rowsById = null; mats.clear();
    buildTree();
    document.body.classList.add('loaded'); resize();
    $('fileName').textContent = file.name;
    buildScene(data.geometry);
    const levels = [...new Set(S.E.map(e => e.level).filter(Boolean))];
    $('level').innerHTML = '<option value="">All levels</option>' + levels.map(l => `<option>${esc(l)}</option>`).join('');
    renderTree(); paint(); st.textContent = '';
    const shown = S.E.filter(e => S.meshById.has(e.id)).length;
    status(`${S.E.length} elements in ${S.tree.size} categories, ${shown} shown in 3D.` + (data.geoNote ? ' ' + data.geoNote : ''));
  } catch (err) { st.className = 'err'; st.textContent = 'Could not open this file: ' + err.message; }
}

// ================================================================== Office
const officeReady = (typeof Office !== 'undefined') ? Office.onReady() : Promise.resolve({ host: null });
officeReady.then((info) => {
  S.inExcel = typeof Office !== 'undefined' && info.host === Office.HostType.Excel;
  if (S.inExcel) Excel.run(async (ctx) => { ctx.workbook.worksheets.onSelectionChanged.add(onExcelSelect); await ctx.sync(); }).catch(() => {});
});

window.__dwfx = { S, update, fit, applyFilter, renderPlan, quantitiesFor, load };
