// Where the add-in gets drawings and models from. Files kept on the computers (location 'local') come from the
// library on this computer (localstore.js); if this computer does not have one yet, the user chooses the file and its
// fingerprint is checked. Models are processed here, with this computer's power. Files still stored on the server
// (added before) are downloaded once and kept in the library too, so they open quickly next time.
import { $, esc, api, fmtBytes } from './core.js';
import { library, sha256 } from './localstore.js';
import { runEngine, LOCAL } from './localproc.js';
import { compareModels } from './compare.js';
import { binHeader } from './modelmerge.js';

export const isCad = (name) => /\.(dwg|dxf)$/i.test(name || '');

// ---------------------------------------------------------------- versions
const metas = new Map();
/** The server's record of a model version (cached for this page; fresh = ask again). */
export async function versionMeta(vid, { fresh = false } = {}) {
  if (!fresh && metas.has(vid)) return metas.get(vid);
  const { version } = await api('GET', `/versions/${vid}`);
  metas.set(vid, version);
  return version;
}
export const isLocal = (x) => x?.location === 'local';

/** Ask the user for a file this computer does not have yet. Resolves with the Blob once its fingerprint matches. */
export function chooseFile({ name, size, sha256: want, why = '' }) {
  return new Promise((resolve, reject) => {
    const d = $('dialog');
    if (!d) { reject(new Error(`${name} is not on this computer. Add it from the project page.`)); return; }
    d.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="cfTitle">
      <h2 id="cfTitle">Choose ${esc(name)}</h2>
      <div class="dlg-body"><p>${esc(why || 'This file is kept on the computers of the project team, not on the server, and this computer does not have it yet.')}</p>
        <p class="hint">Choose the same file the person who added it used (${esc(name)}${size ? `, ${fmtBytes(Number(size))}` : ''}). The add-in checks its fingerprint, so the measurements line up. It is then kept on this computer.</p>
        <input type="file" id="cfFile" aria-label="Choose ${esc(name)}"><div id="cfMsg" class="small" aria-live="polite"></div></div>
      <div class="dlg-actions"><button id="cfNo" class="btn">Cancel</button></div></div>`;
    d.hidden = false;
    const done = (err, blob) => { d.hidden = true; d.innerHTML = ''; err ? reject(err) : resolve(blob); };
    $('cfNo').onclick = () => done(new Error(`${name} was not chosen, so it cannot be opened on this computer.`));
    d.onkeydown = (e) => { if (e.key === 'Escape') $('cfNo')?.click(); };
    $('cfFile').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const msg = $('cfMsg'); msg.className = 'small'; msg.textContent = 'Checking the file…';
      try {
        const got = await sha256(f);
        if (want && got !== want) { msg.className = 'small bad'; msg.textContent = `${f.name} is not the same file (its content is different). Choose the file that was added to the project, or add the new file as a new version.`; e.target.value = ''; return; }
        await library.putFile(f, { name, key: got });
        done(null, f);
      } catch (err) { msg.className = 'small bad'; msg.textContent = err.message; }
    };
    $('cfFile').focus();
  });
}
/** The file of a version or drawing kept on the computers (asks for it if this computer does not have it). */
export async function fileFor(item) {
  const rec = await library.getFile(item.sha256);
  if (rec) return rec.blob;
  return chooseFile({ name: item.file_name || item.name, size: item.size, sha256: item.sha256 });
}

/** Process a model on this computer and keep the result in the library. Tells the project when the version is ready. */
export async function processHere(meta, blob, { onUpdate = () => {} } = {}) {
  const vid = meta.id, state = { step: 'Starting', pct: 0, started: Date.now() };
  LOCAL.set(vid, state);
  const ready = meta.status === 'ready';
  const tell = (text) => { if (!ready) api('POST', `/versions/${vid}/local`, { progress: text }).catch(() => {}); };
  const beat = setInterval(() => tell(state.step), 45000);
  try {
    if (!ready) await api('POST', `/versions/${vid}/local-again`).catch(() => {});
    const r = await runEngine(blob, (text, pct) => { state.step = `On this computer: ${text}`; if (pct != null) state.pct = pct; onUpdate(state); tell(state.step); });
    const payload = { ...r.payload, fileName: meta.file_name, geometryFormat: r.geometry ? 'bin2' : 'none' };
    state.step = 'Keeping the model on this computer'; state.pct = 97; onUpdate(state);
    await library.putModel(meta.sha256, { payload, geometry: r.geometry, sheets: r.sheets });
    const geo = r.geometry ? r.geometry.buffer.slice(r.geometry.byteOffset, r.geometry.byteOffset + r.geometry.byteLength) : null;
    if (!ready) {
      let tris = 0; try { tris = geo ? binHeader(geo).nTris || 0 : 0; } catch { /* no header */ }
      const stats = { elements: payload.elements.length, categories: Object.keys(payload.categories || {}).length, withGeometry: payload.elements.filter(e => e.bb).length,
        triangles: tris, source: payload.source, geoNote: payload.geoNote, qs: payload.qsVersion || 0, ms: r.ms,
        sheets: r.sheets.map(({ index, name, width, height }) => ({ index, name, width, height })) };
      await api('POST', `/versions/${vid}/local-ready`, stats);
      metas.delete(vid);
    }
    state.step = 'Done'; state.pct = 100; onUpdate(state);
    return { payload, geometry: geo };
  } catch (err) {
    if (!ready) await api('POST', `/versions/${vid}/local-failed`, { reason: err.message }).catch(() => {});
    throw err;
  } finally { clearInterval(beat); LOCAL.delete(vid); }
}
/** A model version's data: { data, geometry: ArrayBuffer | null }. From this computer when it can; processed here when needed. */
export async function loadVersion(vid, { onUpdate } = {}) {
  let meta = await versionMeta(vid);
  if (isLocal(meta)) {
    const m = await library.getModel(meta.sha256);
    if (m) return { data: m.payload, geometry: m.geometry, meta };
    const blob = await fileFor(meta);
    meta = await versionMeta(vid, { fresh: true });
    const r = await processHere(meta, blob, { onUpdate });
    return { data: r.payload, geometry: r.geometry, meta };
  }
  // stored on the server: download once, then keep it here
  if (meta.status !== 'ready') meta = await versionMeta(vid, { fresh: true });
  const key = `cloud:v:${vid}`, stamp = String(meta.processed_at || '');
  const hit = await library.getModel(key).catch(() => null);
  if (hit && hit.payload._stamp === stamp) return { data: hit.payload, geometry: hit.geometry, meta };
  const data = await (await api('GET', `/versions/${vid}/model`, null, { raw: true })).json();
  let geometry = null;
  if (data.geometryFormat === 'bin2') geometry = await (await api('GET', `/versions/${vid}/geometry`, null, { raw: true })).arrayBuffer();
  library.putModel(key, { payload: { ...data, _stamp: stamp }, geometry }).catch(() => { /* no room: open it from the server next time */ });
  return { data, geometry, meta };
}

/** Compare two versions on this computer (models kept on the computers never go to the server). */
export async function compareVersions(fromId, toId) {
  const [a, b] = await Promise.all([loadVersion(fromId), loadVersion(toId)]);
  const label = (m) => `${m.model_name} v${m.version}`;
  return { from: { id: fromId, label: label(a.meta) }, to: { id: toId, label: label(b.meta) }, ...compareModels(a.data, b.data) };
}

// ---------------------------------------------------------------- adding files
/** Add a DWFx to a project, kept on this computer: fingerprint, keep, register, process here. Resolves with the version. */
export async function addModel(pid, file, { modelName, discipline, note, onUpdate = () => {} } = {}) {
  onUpdate({ step: 'Reading the file', pct: 2 });
  const sha = await library.putFile(file, { name: file.name });
  const { version } = await api('POST', `/projects/${pid}/models/local`, { fileName: file.name, size: file.size, sha256: sha, modelName, discipline, note });
  const meta = { ...version, sha256: sha, file_name: version.file_name };
  metas.set(version.id, meta);
  processHere(meta, file, { onUpdate }).catch(() => { /* shown in the version list */ });
  return version;
}
/** Add drawings to a project, kept on this computer. */
export async function addDrawings(pid, files, { folderId = null } = {}) {
  const list = [];
  for (const f of files) list.push({ name: f.name, size: f.size, type: f.type, sha256: await library.putFile(f, { name: f.name }) });
  return (await api('POST', `/projects/${pid}/drawings/local`, { files: list, folderId })).drawings;
}

// ---------------------------------------------------------------- drawings
let cadWorker = null;
function dxfHere(blob) {
  return new Promise(async (resolve, reject) => {
    try {
      cadWorker ||= new Worker(new URL('./cadlocal.js', import.meta.url), { type: 'module' });
      cadWorker.onmessage = ({ data }) => (data.ok ? resolve(data.svg) : reject(new Error(data.error)));
      cadWorker.onerror = (e) => { cadWorker = null; reject(new Error(e.message || 'The DXF reader could not start.')); };
      cadWorker.postMessage({ buf: await blob.arrayBuffer() });
    } catch (err) { reject(err); }
  });
}
/** DWG / DXF to a measurable SVG: DXF on this computer, DWG on the server for this one request (nothing is kept there). */
async function cadSvg(blob, name) {
  if (/\.dxf$/i.test(name)) { try { return await dxfHere(blob); } catch (err) { if (/No drawing lines/.test(err.message)) throw err; } }
  const fd = new FormData(); fd.append('file', blob, name);
  const res = await api('POST', '/cad/convert', fd, { raw: true });
  if (!res.ok) { let msg = `The drawing could not be read (${res.status}).`; try { msg = (await res.json()).error || msg; } catch { /* not json */ } throw new Error(msg); }
  return res.text();
}
const svgResponse = (blob) => new Response(blob, { headers: { 'content-type': 'image/svg+xml' } });

/**
 * A drawing's content as a Response, wherever it is kept.
 * d: a project drawing { id, name, content_type, location, sha256, size } or a DWFx sheet { kind: 'sheet', versionId, index }.
 * cad: true gives DWG/DXF drawings as measurable SVG.
 */
export async function drawingResponse(d, { cad = true } = {}) {
  if (d.kind === 'sheet') {
    const meta = await versionMeta(d.versionId);
    if (!isLocal(meta)) return api('GET', `/versions/${d.versionId}/sheets/${d.index}`, null, { raw: true });
    let svg = await library.getSheet(meta.sha256, d.index);
    if (!svg) { await loadVersion(d.versionId); svg = await library.getSheet(meta.sha256, d.index); }
    if (!svg) throw new Error('This sheet was not found in the model.');
    return svgResponse(svg);
  }
  const local = isLocal(d), key = local ? d.sha256 : `cloud:d:${d.id}`;
  if (cad && isCad(d.name)) {
    const hit = await library.getCad(key).catch(() => null);
    if (hit) return svgResponse(hit);
    let text;
    if (local) text = await cadSvg(await fileFor(d), d.name);
    else text = await (await api('GET', `/drawings/${d.id}/cad`, null, { raw: true })).text();
    library.putCad(key, text).catch(() => {});
    return svgResponse(new Blob([text], { type: 'image/svg+xml' }));
  }
  const type = d.content_type || (/\.pdf$/i.test(d.name) ? 'application/pdf' : '');
  if (local) return new Response(await fileFor(d), { headers: { 'content-type': type || 'application/octet-stream' } });
  const hit = await library.getFile(key).catch(() => null);
  if (hit) return new Response(hit.blob, { headers: { 'content-type': hit.type || type } });
  const blob = await (await api('GET', `/drawings/${d.id}/file?inline=1`, null, { raw: true })).blob();
  library.putFile(blob, { name: d.name, type: blob.type || type, key }).catch(() => {});
  return new Response(blob, { headers: { 'content-type': blob.type || type } });
}

// ---------------------------------------------------------------- moving server copies to the computers
/** Owner action: keep this version's DWFx on the computers only. The file and its model are saved here first. */
export async function keepVersionHere(vid) {
  const meta = await versionMeta(vid, { fresh: true });
  if (isLocal(meta)) return;
  const blob = await (await api('GET', `/versions/${vid}/source`, null, { raw: true })).blob();
  const sha = await library.putFile(blob, { name: meta.file_name });
  const m = await loadVersion(vid);
  await library.putModel(sha, { payload: m.data, geometry: m.geometry, sheets: await cloudSheets(vid, meta) });
  await api('POST', `/versions/${vid}/keep-local`, { sha256: sha });
  metas.delete(vid);
}
async function cloudSheets(vid, meta) {
  const out = [];
  for (const s of meta.stats?.sheets || []) {
    try { out.push({ ...s, svg: await (await api('GET', `/versions/${vid}/sheets/${s.index}`, null, { raw: true })).blob() }); } catch { /* sheet missing */ }
  }
  return out;
}
export async function keepDrawingHere(d) {
  if (isLocal(d)) return;
  const blob = await (await api('GET', `/drawings/${d.id}/file?inline=1`, null, { raw: true })).blob();
  const sha = await library.putFile(blob, { name: d.name, type: d.content_type });
  const cad = await library.getCad(`cloud:d:${d.id}`).catch(() => null);
  if (cad) await library.putCad(sha, await cad.text());
  await api('POST', `/drawings/${d.id}/keep-local`, { sha256: sha });
}

/** For AI requests on a model kept on the computers: its elements go with the request (the server keeps none). */
export async function aiModel(versionId, data) {
  if (!versionId || !data) return {};
  try { if (!isLocal(await versionMeta(versionId))) return {}; } catch { return {}; }
  return { model: { elements: data.elements, categories: data.categories, up: data.up } };
}
