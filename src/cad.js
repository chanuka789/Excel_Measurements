// DWG / DXF drawings: converted once (in a worker thread) to a measurable SVG, kept next to the file.
import { Worker } from 'worker_threads';
import zlib from 'zlib';
import { one } from './db.js';
import os from 'os';
import fs from 'fs/promises';
import multer from 'multer';
import { cloudOnly, wrap, uuidOk, fail, need } from './http.js';
import * as store from './storage.js';

export const cadKind = (name) => (/\.dwg$/i.test(name || '') ? 'dwg' : /\.dxf$/i.test(name || '') ? 'dxf' : null);

/** Convert a DWG or DXF buffer to SVG in a worker thread (time and memory limited). */
export function convertCad(buf, kind, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./cadworker.js', import.meta.url), { workerData: { buf, kind }, resourceLimits: { maxOldGenerationSizeMb: 1536 } });
    const t = setTimeout(() => { w.terminate(); reject(new Error('The drawing took too long to read.')); }, timeoutMs);
    w.once('message', (m) => { clearTimeout(t); w.terminate(); m.ok ? resolve(m) : reject(new Error(m.error)); });
    w.once('error', (err) => { clearTimeout(t); reject(new Error(/memory access|unreachable|RuntimeError/i.test(err.message) ? 'This DWG version or file could not be read. Save it as DWG 2013-2018 or export a DXF or PDF, then upload it again.' : err.message)); });
    w.once('exit', (code) => { clearTimeout(t); if (code) reject(new Error('This drawing could not be read. Export it as DXF or PDF and upload it again.')); });
  });
}

const running = new Map();
export function registerCad(api) {
  api.get('/drawings/:id/cad', wrap(async (req, res) => {
    if (!uuidOk(req.params.id)) fail(404, 'Drawing not found.');
    const d = await one(`SELECT * FROM drawings WHERE id=$1`, [req.params.id]); if (!d) fail(404, 'Drawing not found.');
    await need(req, d.project_id, 'viewer'); cloudOnly(d);
    const kind = cadKind(d.name); if (!kind) fail(400, 'This drawing is not a DWG or DXF file.');
    const key = `${d.storage_key}.v1.svg.gz`;
    if (!(await store.exists(key))) {
      if (!running.has(key)) running.set(key, (async () => {
        const r = await convertCad(await store.getBuffer(d.storage_key), kind);
        await store.putBuffer(key, zlib.gzipSync(r.svg), 'image/svg+xml');
      })().finally(() => running.delete(key)));
      try { await running.get(key); } catch (err) { fail(422, err.message); }
    }
    res.set({ 'Content-Type': 'image/svg+xml', 'Content-Encoding': 'gzip', 'Cache-Control': 'private, max-age=86400' });
    (await store.getStream(key)).pipe(res);
  }));
}

// DWG / DXF kept on the user's computer: the add-in sends the file, gets the SVG back, and the server keeps nothing.
// (DXF is read in the browser; DWG needs LibreDWG, which stays on the server: GPL code is not sent to the computers.)
const transient = multer({ dest: os.tmpdir(), limits: { fileSize: 150 * 1024 * 1024, files: 1 } });
export function registerCadConvert(api) {
  api.post('/cad/convert', transient.single('file'), wrap(async (req, res) => {
    try {
      if (!req.file) fail(400, 'No drawing received.');
      const kind = cadKind(req.file.originalname); if (!kind) fail(400, 'Only DWG and DXF files can be converted.');
      let r; try { r = await convertCad(await fs.readFile(req.file.path), kind); } catch (err) { fail(422, err.message); }
      res.set({ 'Content-Type': 'image/svg+xml', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
      res.end(zlib.gzipSync(r.svg));
    } finally { if (req.file) fs.rm(req.file.path, { force: true }).catch(() => {}); }
  }));
}
