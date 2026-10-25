// DWFx Measure server: serves the Excel add-in, the project API, and (optionally) runs the job worker.
import express from 'express';
import multer from 'multer';
import compression from 'compression';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { pool, migrate, one } from './src/db.js';
import { api } from './src/api.js';
import { registerLinkClaim } from './src/link.js';
import { syncUsers } from './src/auth.js';
import { readModel } from './src/processing.js';
import { AI } from './src/ai.js';
import { seedFeatures } from './src/features.js';
import { storageKind } from './src/storage.js';
import { startWorker } from './worker.js';
import { securityHeaders } from './src/security.js';
import { requestId, installCrashHandlers, pruneErrors } from './src/monitor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.disable('x-powered-by');
app.use(compression());
app.set('trust proxy', 1);                      // Railway's proxy sets X-Forwarded-For / -Proto
app.use(requestId);
app.use(securityHeaders(path.join(here, 'public')));
app.use('/vendor/three', express.static(path.join(here, 'node_modules/three')));
app.use('/vendor/bvh', express.static(path.join(here, 'node_modules/three-mesh-bvh/src')));
app.use('/vendor/polyclip', express.static(path.join(here, 'node_modules/polygon-clipping/dist')));          // cutouts (MIT)
app.use('/vendor/pdfjs-fonts', express.static(path.join(here, 'node_modules/pdfjs-dist/standard_fonts')));   // Helvetica, Times... for PDFs that do not embed them
app.use('/vendor/pdfjs-cmaps', express.static(path.join(here, 'node_modules/pdfjs-dist/cmaps')));
app.use('/vendor/pdfjs', express.static(path.join(here, 'node_modules/pdfjs-dist/build')));
// processing on the user's computer: the mesh decoder, Pyodide (Python + numpy + shapely in the browser) and the scripts
app.use('/vendor/dwf-viewer', express.static(path.join(here, 'node_modules/dwf-viewer/dist')));
app.use('/vendor/pyodide', express.static(process.env.PYODIDE_DIR || path.join(here, 'vendor/pyodide'), { maxAge: '1d', setHeaders: (res, p) => { if (p.endsWith('.wasm')) res.type('application/wasm'); } }));
const PY_PUBLIC = new Set(['elements.py', 'geometry.py', 'pack.py', 'qs.py', 'sheets.py']);
app.get('/py/:name', (req, res) => {
  if (!PY_PUBLIC.has(req.params.name)) return res.status(404).end();
  res.type('text/plain; charset=utf-8').sendFile(path.join(here, 'py', req.params.name));
});
app.use(express.static(path.join(here, 'public'), { index: 'taskpane.html' }));
app.get('/health', async (_req, res) => {
  let db = false; try { db = Boolean(await one('SELECT 1 AS ok')); } catch { /* db down */ }
  res.status(db ? 200 : 503).json({ ok: db, db, storage: storageKind.split(':')[0], ai: Boolean(AI.key), model: AI.key ? AI.model : null });
});

// Quick open: read a DWFx without saving it to a project (signed-in users only).
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });
api.post('/model', upload.single('model'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No DWFx file received.' });
  const job = path.join(os.tmpdir(), 'dwfx-' + crypto.randomUUID());
  await fs.mkdir(job);
  try {
    const file = path.join(job, 'model.dwfx');
    await fs.rename(req.file.path, file);
    const r = await readModel(file, job);
    res.json({ fileName: req.file.originalname, ...r.elements, geometryFormat: r.geometryBin ? 'bin2' : 'none', geometryB64: r.geometryBin ? r.geometryBin.toString('base64') : null, geoNote: r.geoNote });
  } catch (err) {
    res.status(500).json({ error: String(err.stderr || err.message || err).trim().split('\n').pop().slice(0, 500) });
  } finally { fs.rm(job, { recursive: true, force: true }).catch(() => {}); }
});
registerLinkClaim(app);
app.use('/api', api);

export async function start(port = process.env.PORT || 3000) {
  if (!pool) throw new Error('DATABASE_URL is not set. Add a Postgres database and set DATABASE_URL.');
  await migrate();
  await seedFeatures();
  await pruneErrors();
  const s = await syncUsers();
  console.log(`Users: ${s.active} active, ${s.disabled} disabled${s.problems.length ? `, ${s.problems.length} APP_USERS problem(s)` : ''}`);
  if ((process.env.WORKER_IN_API || '1') === '1') startWorker();     // set WORKER_IN_API=0 when a separate worker service runs
  return new Promise(r => { const srv = app.listen(port, () => { console.log(`DWFx Measure server on port ${port}, storage ${storageKind.split(':')[0]}, AI ${AI.key ? AI.model : 'off'}`); r(srv); }); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installCrashHandlers('server');
  start().catch((e) => { console.error(e.message); process.exit(1); });
}
