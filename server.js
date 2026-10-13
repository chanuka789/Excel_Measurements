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
import { syncUsers } from './src/auth.js';
import { readModel } from './src/processing.js';
import { registerAI, AI } from './src/ai.js';
import { storageKind } from './src/storage.js';
import { startWorker } from './worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.disable('x-powered-by');
app.use(compression());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', req.path.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use('/vendor/three', express.static(path.join(here, 'node_modules/three')));
app.use(express.static(path.join(here, 'public'), { index: 'taskpane.html' }));
app.get('/health', async (_req, res) => {
  let db = false; try { db = Boolean(await one('SELECT 1 AS ok')); } catch { /* db down */ }
  res.status(db ? 200 : 503).json({ ok: db, db, storage: storageKind.split(':')[0], ai: Boolean(AI.key), model: AI.key ? AI.model : null });
});

// Quick open: read a DWFx without saving it to a project (signed-in users only).
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });
registerAI(api);
api.post('/model', upload.single('model'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No DWFx file received.' });
  const job = path.join(os.tmpdir(), 'dwfx-' + crypto.randomUUID());
  await fs.mkdir(job);
  try {
    const file = path.join(job, 'model.dwfx');
    await fs.rename(req.file.path, file);
    const r = await readModel(file, job);
    res.json({ fileName: req.file.originalname, ...r.elements, geometry: r.geometry, geoNote: r.geoNote });
  } catch (err) {
    res.status(500).json({ error: String(err.stderr || err.message || err).trim().split('\n').pop().slice(0, 500) });
  } finally { fs.rm(job, { recursive: true, force: true }).catch(() => {}); }
});
app.use('/api', api);

export async function start(port = process.env.PORT || 3000) {
  if (!pool) throw new Error('DATABASE_URL is not set. Add a Postgres database and set DATABASE_URL.');
  await migrate();
  const s = await syncUsers();
  console.log(`Users: ${s.active} active, ${s.disabled} disabled${s.problems.length ? `, ${s.problems.length} APP_USERS problem(s)` : ''}`);
  if ((process.env.WORKER_IN_API || '1') === '1') startWorker();     // set WORKER_IN_API=0 when a separate worker service runs
  return new Promise(r => { const srv = app.listen(port, () => { console.log(`DWFx Measure server on port ${port}, storage ${storageKind.split(':')[0]}, AI ${AI.key ? AI.model : 'off'}`); r(srv); }); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((e) => { console.error(e.message); process.exit(1); });
}
