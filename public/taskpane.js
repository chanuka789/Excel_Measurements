import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ------------------------------------------------------------------ state
const S = {
  inExcel: false, data: null, meshes: [], byId: new Map(), info: new Map(),
  selected: new Set(), isolated: null, catOn: new Set(), level: '', idRow: null, quiet: 0,
};
const $ = (id) => document.getElementById(id);
const status = (msg, err = false) => { const el = $('status'); el.textContent = msg; el.className = err ? 'err' : ''; };

// BOQ code -> legend group (the legend doubles as a filter)
const GROUPS = [
  { key: 'fdn', name: 'Pile caps & piles', color: '#7a8a5a', test: c => /^(PC|PC-BW|PCF|FDN|PILE)$/.test(c) },
  { key: 'gb', name: 'Ground beams', color: '#c98a2b', test: c => /^(GB|GB-BW|BWB)$/.test(c) },
  { key: 'gs', name: 'Ground slab', color: '#a7b0b6', test: c => /^GS-/.test(c) },
  { key: 'col', name: 'Columns', color: '#b5473a', test: c => c === 'COL' },
  { key: 'bm', name: 'Beams', color: '#2f6fa3', test: c => c === 'BM' },
  { key: 'wall', name: 'Walls', color: '#6b5b8c', test: c => /^(UW|W)-/.test(c) },
  { key: 'slab', name: 'Slabs', color: '#c3c9cd', test: c => /^(FS|RS)-/.test(c) || c === 'STEP' },
  { key: 'other', name: 'Other', color: '#8d9399', test: () => true },
];
const groupOf = (code) => GROUPS.find(g => g.test(code || '')) || GROUPS.at(-1);
const PICK = new THREE.Color('#f2a900');

// ------------------------------------------------------------------ viewer
const host = $('viewer');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9ebec');
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(1, 2, 1.5); scene.add(sun);
const root = new THREE.Group(); scene.add(root);

function resize() {
  const w = host.clientWidth, h = Math.max(host.clientHeight, 1);
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
(function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();

const mats = {};
function baseMat(code) {
  const g = groupOf(code);
  return mats[g.key] ||= new THREE.MeshLambertMaterial({ color: g.color, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
}
const pickMat = new THREE.MeshLambertMaterial({ color: PICK, emissive: new THREE.Color('#5a3d00'), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const ghostMat = new THREE.MeshLambertMaterial({ color: '#b9bfc4', transparent: true, opacity: 0.12, depthWrite: false });
const edgeMat = new THREE.LineBasicMaterial({ color: '#3b444c', transparent: true, opacity: 0.35 });

const b64f = (s) => new Float32Array(Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer);
const b64u = (s) => new Uint32Array(Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer);

function buildScene(geo) {
  root.clear(); S.meshes = []; S.byId = new Map();
  for (const m of geo.meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b64f(m.p), 3));
    g.setIndex(new THREE.BufferAttribute(b64u(m.i), 1));
    g.computeVertexNormals();
    const info = S.info.get(m.id);
    const mesh = new THREE.Mesh(g, baseMat(info?.code));
    mesh.userData.id = m.id;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), edgeMat));
    root.add(mesh); S.meshes.push(mesh);
    if (m.id != null) { if (!S.byId.has(m.id)) S.byId.set(m.id, []); S.byId.get(m.id).push(mesh); }
  }
  fit(S.meshes);
}

function fit(list) {
  const box = new THREE.Box3();
  list.filter(m => m.visible).forEach(m => box.expandByObject(m));
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
  const vf = THREE.MathUtils.degToRad(camera.fov / 2), hf = Math.atan(Math.tan(vf) * camera.aspect);
  const d = r / Math.sin(Math.min(vf, hf)) * 0.72;
  camera.position.copy(c).add(new THREE.Vector3(1, 0.75, 1.1).normalize().multiplyScalar(d));
  camera.near = d / 200; camera.far = d * 20; camera.updateProjectionMatrix();
  controls.target.copy(c); controls.update();
}

// visibility = category filter AND level filter AND isolate set
function visibleId(id) {
  const info = S.info.get(id);
  if (S.isolated) return S.isolated.has(id);
  if (S.catOn.size && !S.catOn.has(groupOf(info?.code).key)) return false;
  if (S.level && info?.level !== S.level) return false;
  return true;
}
function paint() {
  const ghost = S.selected.size > 0 && !S.isolated;
  for (const m of S.meshes) {
    const id = m.userData.id, sel = S.selected.has(id);
    m.visible = visibleId(id);
    m.material = sel ? pickMat : (ghost ? ghostMat : baseMat(S.info.get(id)?.code));
    m.children[0].visible = !ghost || sel;
  }
  $('isolate').setAttribute('aria-pressed', S.isolated ? 'true' : 'false');
  showSelection();
}

function showSelection() {
  const box = $('sel'); const ids = [...S.selected];
  if (!ids.length) { box.innerHTML = '<div class="empty">Nothing selected. Click an element, or select rows in the Measurement or BOQ sheet.</div>'; return; }
  if (ids.length === 1) {
    const i = S.info.get(ids[0]) || {}; const lab = S.data.geometry.labels[ids[0]] || '';
    box.innerHTML = `<table>
      <tr><td>Revit ID</td><td>${ids[0]}</td></tr>
      <tr><td>Type</td><td>${esc(i.desc || lab || 'Not measured (steel or other)')}</td></tr>
      <tr><td>BOQ code</td><td>${esc(i.code || '-')}</td></tr>
      <tr><td>Level</td><td>${esc(i.level || '-')}</td></tr>
      <tr><td>Mark</td><td>${esc(i.mark || '-')}</td></tr>
      <tr><td>Grade</td><td>${esc(i.grade || '-')}</td></tr></table>`;
    return;
  }
  const by = {}; ids.forEach(id => { const c = S.info.get(id)?.code || 'Not measured'; by[c] = (by[c] || 0) + 1; });
  box.innerHTML = `<div class="count">${ids.length} elements selected</div><table>` +
    Object.entries(by).sort().map(([c, n]) => `<tr><td>${esc(c)}</td><td>${n}</td></tr>`).join('') + '</table>';
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// click to pick (ignore drags)
const ray = new THREE.Raycaster(); let down = null;
renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  const hit = ray.intersectObjects(S.meshes.filter(m => m.visible), false)[0];
  const id = hit?.object.userData.id;
  if (!(e.ctrlKey || e.metaKey || e.shiftKey)) S.selected.clear();
  if (id != null) S.selected.has(id) && (e.ctrlKey || e.metaKey) ? S.selected.delete(id) : S.selected.add(id);
  paint();
  if (id != null && S.inExcel) goToRows([...S.selected]);
});

// ------------------------------------------------------------------ controls
$('isolate').onclick = () => {
  if (S.isolated) { S.isolated = null; } else if (S.selected.size) { S.isolated = new Set(S.selected); }
  else { status('Select elements first, then press Isolate.'); return; }
  paint(); fit(S.meshes);
};
$('showAll').onclick = () => { S.isolated = null; S.catOn.clear(); S.level = ''; $('level').value = ''; drawCats(); paint(); fit(S.meshes); };
$('clear').onclick = () => { S.selected.clear(); paint(); };
$('fit').onclick = () => fit(S.meshes);
$('level').onchange = (e) => { S.level = e.target.value; S.isolated = null; paint(); fit(S.meshes); };

function drawCats() {
  const present = new Set([...S.byId.keys()].map(id => groupOf(S.info.get(id)?.code).key));
  $('cats').innerHTML = GROUPS.filter(g => present.has(g.key)).map(g =>
    `<button data-k="${g.key}" aria-pressed="${S.catOn.has(g.key)}"><i style="background:${g.color}"></i>${g.name}</button>`).join('');
  $('cats').querySelectorAll('button').forEach(b => b.onclick = () => {
    const k = b.dataset.k; S.catOn.has(k) ? S.catOn.delete(k) : S.catOn.add(k); S.isolated = null; drawCats(); paint();
  });
}

// ------------------------------------------------------------------ loading a model
const drop = $('drop');
try { $('token').value = localStorage.getItem('dwfxToken') || ''; } catch { /* storage blocked */ }
drop.onclick = () => $('file').click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } };
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); };
$('file').onchange = (e) => e.target.files[0] && load(e.target.files[0]);
$('another').onclick = () => { document.body.classList.remove('loaded'); $('file').value = ''; };

async function load(file) {
  const st = $('startStatus');
  st.textContent = `Reading ${file.name}. Measuring and decoding the 3D model…`;
  try { localStorage.setItem('dwfxToken', $('token').value); } catch { /* storage blocked */ }
  const fd = new FormData(); fd.append('model', file, file.name);
  try {
    const res = await fetch('api/process', { method: 'POST', body: fd, headers: { 'x-app-token': $('token').value } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    S.data = data; S.info = new Map(data.elements.elements.map(e => [e.id, e]));
    S.selected.clear(); S.isolated = null; S.catOn.clear(); S.level = ''; S.idRow = null;
    document.body.classList.add('loaded'); resize();
    $('fileName').textContent = file.name;
    buildScene(data.geometry); drawCats();
    const levels = [...new Set(data.elements.elements.map(e => e.level).filter(Boolean))];
    $('level').innerHTML = '<option value="">All levels</option>' + levels.map(l => `<option>${esc(l)}</option>`).join('');
    paint(); st.textContent = '';
    const measured = data.elements.elements.length, withGeo = data.elements.elements.filter(e => S.byId.has(e.id)).length;
    status(`${measured} elements measured, ${withGeo} shown in 3D.` + (S.inExcel ? ' Press "Create sheets in Excel" to add the measurement and BOQ.' : ''));
    if (S.inExcel) await readIdRows(true);
  } catch (err) {
    st.textContent = 'Could not process this file: ' + err.message;
  }
}

$('download').onclick = () => {
  if (!S.data) return;
  const a = document.createElement('a');
  a.href = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + S.data.xlsx;
  a.download = S.data.fileName; a.click();
};

// ------------------------------------------------------------------ Excel link
const SHEETS = ['Read Me', 'BOQ', 'Measurement', 'Rates'];
const officeReady = (typeof Office !== 'undefined') ? Office.onReady() : Promise.resolve({ host: null });
officeReady.then((info) => {
  S.inExcel = typeof Office !== 'undefined' && info.host === Office.HostType.Excel;
  $('makeSheets').hidden = !S.inExcel;
  if (!S.inExcel) return;
  Excel.run(async (ctx) => { ctx.workbook.worksheets.onSelectionChanged.add(onExcelSelect); await ctx.sync(); }).catch(() => {});
});

$('makeSheets').onclick = async () => {
  if (!S.data) return;
  if (!Office.context.requirements.isSetSupported('ExcelApi', '1.13')) {
    status('This Excel version cannot insert sheets. Use "Download Excel file" instead.', true); return;
  }
  try {
    await Excel.run(async (ctx) => {
      const ws = ctx.workbook.worksheets; ws.load('items/name'); await ctx.sync();
      const existing = ws.items.filter(w => SHEETS.includes(w.name));
      if (existing.length && !confirmReplace(existing.map(w => w.name))) return;
      if (ws.items.length - existing.length < 1) { ws.add('Sheet1'); await ctx.sync(); } // workbook must keep one sheet
      existing.forEach(w => w.delete()); await ctx.sync();
      ctx.workbook.insertWorksheetsFromBase64(S.data.xlsx, { positionType: Excel.WorksheetPositionType.end });
      await ctx.sync();
      ws.getItem('BOQ').activate(); await ctx.sync();
    });
    await readIdRows(true);
    status('Measurement, BOQ, Rates and Read Me sheets created. Select rows to highlight the model.');
  } catch (err) { status('Excel error: ' + err.message, true); }
};
// replacing sheets is destructive, so ask once in the pane rather than silently
let replaceOk = false;
function confirmReplace(names) {
  if (replaceOk) return true;
  status(`This workbook already has ${names.join(', ')}. Press "Create sheets in Excel" again to replace them.`, true);
  replaceOk = true; setTimeout(() => { replaceOk = false; }, 15000);
  return false;
}

// Revit ID (column B) -> row number on the Measurement sheet
async function readIdRows(force) {
  if (S.idRow && !force) return S.idRow;
  try {
    await Excel.run(async (ctx) => {
      const sh = ctx.workbook.worksheets.getItemOrNullObject('Measurement'); await ctx.sync();
      if (sh.isNullObject) { S.idRow = null; return; }
      const r = sh.getRange('A1:B3000'); r.load('values'); await ctx.sync();
      S.idRow = new Map(); S.rowInfo = new Map();
      r.values.forEach((v, i) => { if (typeof v[1] === 'number') S.idRow.set(v[1], i + 1); S.rowInfo.set(i + 1, v); });
    });
  } catch { S.idRow = null; }
  return S.idRow;
}

async function goToRows(ids) {
  const map = await readIdRows(); if (!map) return;
  const rows = ids.map(id => map.get(id)).filter(Boolean).slice(0, 100);
  if (!rows.length) { status('The selected element is not in the Measurement sheet (steel or not measured).'); return; }
  S.quiet = Date.now();
  await Excel.run(async (ctx) => {
    const sh = ctx.workbook.worksheets.getItem('Measurement'); sh.activate();
    sh.getRanges(rows.map(r => `A${r}:AA${r}`).join(',')).select();
    await ctx.sync();
  }).catch(err => status('Excel error: ' + err.message, true));
}

async function onExcelSelect(ev) {
  if (!S.data || Date.now() - S.quiet < 800) return;      // ignore the selection we just made
  try {
    await Excel.run(async (ctx) => {
      const sh = ctx.workbook.worksheets.getItem(ev.worksheetId); sh.load('name');
      const rng = sh.getRange(ev.address); rng.load('rowIndex,rowCount'); await ctx.sync();
      const first = rng.rowIndex + 1, last = Math.min(rng.rowIndex + rng.rowCount, first + 3000);
      const ids = new Set();
      if (sh.name === 'Measurement') {
        const v = sh.getRange(`A${first}:B${last}`); v.load('values'); await ctx.sync();
        const codes = [];
        v.values.forEach(([code, id]) => { if (typeof id === 'number') ids.add(id); else if (code) codes.push(String(code).replace(/-DED$/, '-*')); });
        if (!ids.size) codes.forEach(c => matchCode(c).forEach(i => ids.add(i)));
      } else if (sh.name === 'BOQ') {
        const v = sh.getRange(`H${first}:H${last}`); v.load('values'); await ctx.sync();
        v.values.forEach(([code]) => { if (code) matchCode(String(code)).forEach(i => ids.add(i)); });
      } else return;
      if (!ids.size) return;
      S.selected = ids; paint();
      status(`${ids.size} element${ids.size > 1 ? 's' : ''} highlighted from ${sh.name}.`);
    });
  } catch { /* selection on other sheets is ignored */ }
}
function matchCode(code) {
  const wild = code.endsWith('*'), base = wild ? code.slice(0, -1) : code;
  return S.data.elements.elements.filter(e => wild ? e.code.startsWith(base) : e.code === base).map(e => e.id);
}

// expose for automated tests
window.__dwfx = { S, paint, fit, matchCode, load };
