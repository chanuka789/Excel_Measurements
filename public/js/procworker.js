// Processes a DWFx on the user's own computer (a Web Worker, so Excel stays responsive). It runs exactly the same
// steps as the server: py/elements.py, the dwf-viewer mesh decoder, py/geometry.py, py/pack.py, py/qs.py and
// py/sheets.py (Python runs in the browser with Pyodide), then merges them with the same code (modelmerge.js).
// Messages in:  { type: 'run', file: ArrayBuffer, name, version }
// Messages out: { type: 'step', text, pct } | { type: 'log', text } | { type: 'done', payload, geometry, sheets, ms } | { type: 'error', message }
// The formwork step (qs.py) of a large model is split over helper workers (this same file, message 'qs-part').
import { encodeMeshes, meshesOf } from './meshbin.js';
import { binHeader, joinQsParts, mergeMetrics, mergeQs } from './modelmerge.js';

const BASE = new URL('../', import.meta.url);                 // the add-in's public root
const SCRIPTS = ['elements.py', 'geometry.py', 'pack.py', 'qs.py', 'sheets.py'];
let pyReady = null;

const step = (text, pct) => self.postMessage({ type: 'step', text, pct });

async function engine(version) {
  if (!pyReady) pyReady = (async () => {
    const { loadPyodide } = await import(new URL('vendor/pyodide/pyodide.mjs', BASE).href);
    const py = await loadPyodide({ indexURL: new URL('vendor/pyodide/', BASE).href, stdout: (t) => self.postMessage({ type: 'log', text: t }), stderr: (t) => self.postMessage({ type: 'log', text: t }) });
    await py.loadPackage(['numpy', 'shapely'], { messageCallback: () => {} });
    py.FS.mkdirTree('/py'); py.FS.mkdirTree('/work');
    for (const s of SCRIPTS) {
      const r = await fetch(new URL(`py/${s}?v=${encodeURIComponent(version || '')}`, BASE));
      if (!r.ok) throw new Error(`Could not load ${s} (${r.status}).`);
      py.FS.writeFile(`/py/${s}`, await r.text());
    }
    return py;
  })();
  try { return await pyReady; } catch (err) { pyReady = null; throw err; }
}

/** Run one script like `python3 -I py/<name> args...`; a non-zero exit becomes an error with its message. */
function runScript(py, name, args) {
  py.globals.set('_argv', py.toPy([`/py/${name}`, ...args]));
  py.runPython(`
import sys, runpy
sys.argv = list(_argv)
try:
    runpy.run_path(sys.argv[0], run_name='__main__')
except SystemExit as _e:
    if _e.code not in (None, 0):
        raise RuntimeError(str(_e.code)) from None
`);
}
const readJson = (py, p) => JSON.parse(py.FS.readFile(p, { encoding: 'utf8' }));
const rm = (py, p) => { try { py.FS.unlink(p); } catch { /* not there */ } };

/** How many workers share the formwork step: the computer's cores (leave one for Excel), at most 4 (memory). */
function partsFor(bin, force) {
  if (force) return Math.max(1, Math.min(8, force | 0));
  let tris = 0; try { tris = binHeader(bin).nTris; } catch { /* small */ }
  if (typeof Worker === 'undefined') return 1;                  // some browsers have no workers inside workers
  const cores = Number(self.navigator?.hardwareConcurrency) || 2;
  return tris < 60000 ? 1 : Math.max(1, Math.min(4, cores - 1));
}

function qsPart(py, i, n) {
  runScript(py, 'qs.py', ['/work/geometry.bin', '/work/geometry.json', `/work/qs-${i}.json`, `${i}/${n}`]);
  const r = readJson(py, `/work/qs-${i}.json`); rm(py, `/work/qs-${i}.json`); return r;
}

/** qs.py on this engine, or split into n parts with n - 1 helper workers (any helper that fails is redone here). */
async function formwork(py, bin, version, force) {
  const n = partsFor(bin, force);
  if (n === 1) { runScript(py, 'qs.py', ['/work/geometry.bin', '/work/geometry.json', '/work/qs.json']); const r = readJson(py, '/work/qs.json'); rm(py, '/work/qs.json'); return r; }
  const geo = py.FS.readFile('/work/geometry.json');
  const helpers = [], parts = [];
  let done = 0;
  const tick = () => step(`Formwork and contact analysis (${++done} of ${n} parts done, ${n} workers)`, 60 + Math.round(26 * done / n));
  try {
    const jobs = [];
    for (let i = 1; i < n; i++) {
      let w; try { w = new Worker(new URL(import.meta.url), { type: 'module' }); } catch { jobs.push(Promise.resolve(null)); continue; }
      helpers.push(w);
      jobs.push(new Promise((resolve) => {
        w.onmessage = ({ data: m }) => { if (m.type === 'qs-part-done') resolve(JSON.parse(m.text)); else if (m.type === 'qs-part-error') { self.postMessage({ type: 'log', text: `qs part ${i}: ${m.message}` }); resolve(null); } };
        w.onerror = (e) => { self.postMessage({ type: 'log', text: `qs part ${i}: ${e.message || 'worker stopped'}` }); resolve(null); };
        w.postMessage({ type: 'qs-part', bin: bin.slice(), geo: geo.slice(), part: [i, n], version });
      }).then((r) => { try { w.terminate(); } catch { /* gone */ } if (r) tick(); return r; }));
    }
    parts.push(qsPart(py, 0, n)); tick();
    const got = await Promise.all(jobs);
    for (let i = 1; i < n; i++) {
      if (!got[i - 1]) { step(`Formwork and contact analysis (redoing part ${i + 1} of ${n})`, 80); parts.push(qsPart(py, i, n)); }
      else parts.push(got[i - 1]);
    }
  } finally { for (const w of helpers) try { w.terminate(); } catch { /* gone */ } }
  return joinQsParts(parts);
}

/** Helper worker: one part of qs.py. */
async function helperPart({ bin, geo, part, version }) {
  const py = await engine(version);
  py.FS.writeFile('/work/geometry.bin', new Uint8Array(bin)); py.FS.writeFile('/work/geometry.json', new Uint8Array(geo));
  runScript(py, 'qs.py', ['/work/geometry.bin', '/work/geometry.json', '/work/qs.json', `${part[0]}/${part[1]}`]);
  return py.FS.readFile('/work/qs.json', { encoding: 'utf8' });
}

async function run(buf, name, version, opts = {}) {
  const t0 = Date.now();
  step('Loading the processing engine (the first time downloads about 20 MB, then it is cached)', 2);
  const py = await engine(version);
  py.FS.writeFile('/work/model.dwfx', new Uint8Array(buf));

  step('Reading elements and properties', 10);
  runScript(py, 'elements.py', ['/work/model.dwfx', '/work/elements.json']);
  const elements = readJson(py, '/work/elements.json'); rm(py, '/work/elements.json');

  let geometryBin = null, geoNote = '', metrics = {};
  try {
    step('Decoding the 3D model', 22);
    const { openDwfDocument } = await import(new URL('vendor/dwf-viewer/format/open.js', BASE).href);
    let doc = await openDwfDocument(new Uint8Array(buf), { fileName: name || 'model.dwfx' });
    let meshes = await meshesOf(doc); doc = null;
    if (!meshes.length) throw new Error('no 3D model page');
    py.FS.writeFile('/work/meshes.bin', encodeMeshes(meshes)); meshes = null;
    step('Placing the 3D geometry', 38);
    runScript(py, 'geometry.py', ['/work/model.dwfx', '/work/meshes.bin', '/work/geometry.json', '/work/placed.bin']); rm(py, '/work/meshes.bin');
    step('Measuring the 3D geometry', 48);
    runScript(py, 'pack.py', ['/work/geometry.json', '/work/placed.bin', '/work/geometry.bin', '/work/metrics.json']); rm(py, '/work/placed.bin');
    geometryBin = py.FS.readFile('/work/geometry.bin');
    metrics = readJson(py, '/work/metrics.json'); rm(py, '/work/metrics.json');
  } catch (err) {
    self.postMessage({ type: 'log', text: 'geometry: ' + (err.message || err) });
    geoNote = '3D geometry could not be decoded for this file; measurements still work.'; geometryBin = null;
  }
  mergeMetrics(elements, metrics, geometryBin);
  if (geometryBin) {
    try {
      step('Formwork and contact analysis (the longest step)', 60);
      mergeQs(elements, await formwork(py, geometryBin, version, opts.parts));
    } catch (err) { self.postMessage({ type: 'log', text: 'QS face analysis failed: ' + (err.message || err).toString().slice(-400) }); }
  }
  rm(py, '/work/geometry.bin'); rm(py, '/work/geometry.json');

  const sheets = [];
  try {
    step('Converting 2D sheets', 88);
    runScript(py, 'sheets.py', ['/work/model.dwfx', '/work/sheets']);
    for (const sh of readJson(py, '/work/sheets/sheets.json')) {
      sheets.push({ ...sh, svg: py.FS.readFile(`/work/sheets/sheet-${sh.index}.svg`, { encoding: 'utf8' }) });
      rm(py, `/work/sheets/sheet-${sh.index}.svg`);
    }
    rm(py, '/work/sheets/sheets.json');
  } catch (err) { self.postMessage({ type: 'log', text: 'sheets: ' + (err.message || err) }); }
  rm(py, '/work/model.dwfx');

  const payload = { fileName: name, ...elements, geometryFormat: geometryBin ? 'bin2' : 'none', geoNote };
  return { payload, geometry: geometryBin, sheets, ms: Date.now() - t0 };
}

self.onmessage = async ({ data }) => {
  if (data?.type === 'qs-part') {
    try { self.postMessage({ type: 'qs-part-done', text: await helperPart(data) }); }
    catch (err) { self.postMessage({ type: 'qs-part-error', message: String(err?.message || err).slice(-300) }); }
    return;
  }
  if (data?.type !== 'run') return;
  try {
    const r = await run(data.file, data.name, data.version, { parts: data.parts });
    self.postMessage({ type: 'done', ...r }, r.geometry ? [r.geometry.buffer] : []);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err).split('\n').filter(Boolean).pop()?.slice(0, 500) || 'Processing failed.' });
  }
};
