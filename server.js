// DWFx Structural add-in server: serves the Excel task pane and processes DWFx models.
import express from 'express';
import multer from 'multer';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const PY = process.env.PYTHON || 'python3';
const TOKEN = process.env.APP_TOKEN || '';           // optional shared password
const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 300 * 1024 * 1024 } });

app.use((req, res, next) => {                         // Office add-ins need HTTPS + these headers
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/vendor/three', express.static(path.join(here, 'node_modules/three')));
app.use(express.static(path.join(here, 'public'), { index: 'taskpane.html' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/process', upload.single('model'), async (req, res) => {
  if (TOKEN && req.get('x-app-token') !== TOKEN) return res.status(401).json({ error: 'Wrong access code.' });
  if (!req.file) return res.status(400).json({ error: 'No DWFx file received.' });
  const job = path.join(os.tmpdir(), 'dwfx-' + crypto.randomUUID());
  await fs.mkdir(job);
  const model = path.join(job, 'model.dwfx');
  try {
    await fs.rename(req.file.path, model);
    const base = (req.file.originalname || 'model.dwfx').replace(/\.dwfx$/i, '').replace(/[^\w.-]+/g, '_');
    const xlsx = path.join(job, base + '_Structural_Measurement_and_BOQ.xlsx');
    const opts = { cwd: here, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 };
    // 1. quantities workbook + element list
    const q = await run(PY, ['-I', 'py/dwfx_structural.py', model, xlsx, path.join(job, 'elements.json')], opts);
    // 2. geometry
    await run('node', ['decode.mjs', model, path.join(job, 'meshes.json')], opts);
    const g = await run(PY, ['-I', 'py/geometry.py', model, path.join(job, 'meshes.json'), path.join(job, 'geometry.json')], opts);
    const [xb, el, geo] = await Promise.all([
      fs.readFile(xlsx), fs.readFile(path.join(job, 'elements.json'), 'utf8'), fs.readFile(path.join(job, 'geometry.json'), 'utf8')]);
    res.json({
      fileName: path.basename(xlsx),
      xlsx: xb.toString('base64'),
      elements: JSON.parse(el),
      geometry: JSON.parse(geo),
      log: (q.stdout + g.stdout).trim(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.stderr || err.message || err).slice(-2000) });
  } finally {
    fs.rm(job, { recursive: true, force: true }).catch(() => {});   // models are not kept on the server
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('DWFx add-in server on port', port));
