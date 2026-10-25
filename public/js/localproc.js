// Processing a model version on this computer (browser), then sending the finished model to the server.
// The server keeps the original DWFx and only stores the result, so Railway does no heavy work. If anything
// fails, the version goes to the server queue instead (the server can always process it).
import { api, upload } from './core.js';

/** True when this browser (Excel's WebView2, Excel on the web, Safari, Chrome...) can process models itself. */
export function canProcessLocally() {
  return typeof Worker !== 'undefined' && typeof WebAssembly === 'object' && typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

const gz = async (data) => new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());

let worker = null;
/** The running jobs of this page: versionId -> { step, pct, started } (the project page shows them). */
export const LOCAL = new Map();

/** Run the processing engine (Pyodide in a worker) on a DWFx on this computer.
 * onStep(text, pct). Resolves with { payload, geometry: Uint8Array | null, sheets: [{ index, name, width, height, svg }], ms }. */
let queue = Promise.resolve();
/** One model at a time: the engine is large, and two at once would not fit in memory on most computers. */
export function runEngine(file, onStep = () => {}) {
  const job = queue.catch(() => {}).then(() => engine(file, onStep));
  queue = job;
  return job;
}
async function engine(file, onStep) {
  const buf = await file.arrayBuffer();
  worker = worker || new Worker(new URL('./procworker.js', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data: m }) => {
        if (m.type === 'step') onStep(m.text, m.pct);
        else if (m.type === 'log') console.debug('[process]', m.text);
        else if (m.type === 'done') resolve(m);
        else if (m.type === 'error') reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'The processing engine stopped (the model may be too large for this computer).'));
      worker.postMessage({ type: 'run', file: buf, name: file.name || 'model.dwfx', version: '1' }, [buf]);
    });
  } catch (err) {
    // the engine may be in a bad state (out of memory): start a fresh one next time
    try { worker?.terminate(); } catch { /* gone */ } worker = null;
    throw err;
  }
}

/**
 * Process `file` (File/Blob) for the version and upload the result.
 * onUpdate(state) is called on every step. Resolves with { ms } or throws (after asking the server to take over).
 */
export async function processLocally(file, versionId, { onUpdate = () => {}, fallback = true } = {}) {
  const state = { step: 'Starting', pct: 0, started: Date.now() };
  LOCAL.set(versionId, state);
  const set = (text, pct) => { state.step = text; if (pct != null) state.pct = pct; onUpdate(state); api('POST', `/versions/${versionId}/local`, { progress: text }).catch(() => {}); };
  const beat = setInterval(() => api('POST', `/versions/${versionId}/local`, { progress: state.step }).catch(() => {}), 45000);
  try {
    const result = await runEngine(file, (text, pct) => set(`On this computer: ${text}`, pct));
    set('Sending the finished model to the server', 92);
    const fd = new FormData();
    fd.append('model', new Blob([await gz(JSON.stringify(result.payload))]), 'model.json.gz');
    if (result.geometry) fd.append('geometry', new Blob([await gz(result.geometry)]), 'geometry.bin.gz');
    fd.append('sheets', JSON.stringify(result.sheets.map(({ index, name, width, height }) => ({ index, name, width, height }))));
    for (const sh of result.sheets) fd.append(`sheet_${sh.index}`, new Blob([await gz(sh.svg)]), `sheet-${sh.index}.svg.gz`);
    fd.append('ms', String(result.ms));
    await upload(`/versions/${versionId}/processed`, fd, (x) => { state.pct = 92 + Math.round(x * 7); onUpdate(state); });
    state.step = 'Done'; state.pct = 100; onUpdate(state);
    return { ms: result.ms };
  } catch (err) {
    if (fallback) await api('POST', `/versions/${versionId}/server`, { reason: err.message }).catch(() => {});
    throw err;
  } finally { clearInterval(beat); LOCAL.delete(versionId); }
}
