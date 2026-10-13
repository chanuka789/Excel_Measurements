// DWFx Measure add-in server: serves the Excel task pane, reads DWFx models, and relays AI requests.
import express from 'express';
import multer from 'multer';
import compression from 'compression';
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
const TOKEN = process.env.APP_TOKEN || '';            // shared access code
// AI provider: any OpenAI-compatible chat API (DeepSeek, OpenRouter for Meta Muse Spark, Meta Model API, ...)
const AI = {
  base: (process.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  key: process.env.AI_API_KEY || '',
  model: process.env.AI_MODEL || 'deepseek-flash',
};

const app = express();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024 } });
app.use(compression());
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use('/vendor/three', express.static(path.join(here, 'node_modules/three')));
app.use(express.static(path.join(here, 'public'), { index: 'taskpane.html' }));
app.get('/health', (_req, res) => res.json({ ok: true, ai: Boolean(AI.key), model: AI.key ? AI.model : null }));

const auth = (req, res, next) =>
  (TOKEN && req.get('x-app-token') !== TOKEN) ? res.status(401).json({ error: 'Wrong access code.' }) : next();

// ---- read a model: elements + quantities + 3D geometry
app.post('/api/model', auth, upload.single('model'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No DWFx file received.' });
  const job = path.join(os.tmpdir(), 'dwfx-' + crypto.randomUUID());
  await fs.mkdir(job);
  const model = path.join(job, 'model.dwfx');
  try {
    await fs.rename(req.file.path, model);
    const opts = { cwd: here, maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60 * 1000 };
    await run(PY, ['-I', 'py/elements.py', model, path.join(job, 'elements.json')], opts);
    let geometry = { meshes: [], labels: {} }, geoNote = '';
    try {
      await run('node', ['decode.mjs', model, path.join(job, 'meshes.json')], opts);
      await run(PY, ['-I', 'py/geometry.py', model, path.join(job, 'meshes.json'), path.join(job, 'geometry.json')], opts);
      geometry = JSON.parse(await fs.readFile(path.join(job, 'geometry.json'), 'utf8'));
    } catch (e) { geoNote = '3D geometry could not be decoded for this file; measurements still work.'; }
    const elements = JSON.parse(await fs.readFile(path.join(job, 'elements.json'), 'utf8'));
    res.json({ fileName: req.file.originalname, ...elements, geometry, geoNote });
  } catch (err) {
    res.status(500).json({ error: String(err.stderr || err.message || err).trim().split('\n').pop().slice(0, 500) });
  } finally {
    fs.rm(job, { recursive: true, force: true }).catch(() => {});   // models are never stored
  }
});

// ---- AI assistant: turns a plain-English request into a measurement plan (the add-in computes the numbers)
const SYSTEM = `You are a quantity surveyor's assistant inside an Excel add-in that measures Revit DWFx models.
You receive a SUMMARY of the model (categories, families, types with element counts, levels, and the measurable
quantity names available for each type) and a REQUEST. You never calculate quantities yourself. You return a plan
that the add-in applies to the real elements.
Return ONLY a JSON object:
{"message": "one or two plain sentences for the user",
 "groups": [ { "name": "short take-off group name, e.g. 'Internal walls 200 mm - First floor'",
   "filter": { "category": ["exact category names"], "family": ["exact family names, optional"],
               "type": ["exact type names, optional"], "type_contains": ["text, optional"],
               "type_excludes": ["text, optional"], "level": ["exact level names, optional"] },
   "quantities": ["Count" and/or exact quantity names from the summary, e.g. "Area", "Length", "Volume"],
   "note": "measurement assumption the QS should check" } ] }
Rules: use only names that appear in the summary; empty lists mean 'any'; prefer one group per distinct item a QS
would bill separately; if the request is unclear, return no groups and ask a short question in "message".`;

app.post('/api/ai', auth, express.json({ limit: '4mb' }), async (req, res) => {
  if (!AI.key) return res.status(503).json({ error: 'AI is not set up on the server. Add AI_API_KEY in Railway.' });
  const { request, summary } = req.body || {};
  if (!request || !summary) return res.status(400).json({ error: 'Missing request or model summary.' });
  try {
    const r = await fetch(AI.base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AI.key },
      body: JSON.stringify({
        model: AI.model, temperature: 0.1, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM },
                   { role: 'user', content: 'SUMMARY:\n' + JSON.stringify(summary) + '\n\nREQUEST:\n' + String(request).slice(0, 2000) }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'AI provider error: ' + (body.error?.message || r.statusText) });
    const text = body.choices?.[0]?.message?.content || '{}';
    const plan = JSON.parse(text.replace(/^```(json)?|```$/g, '').trim());
    res.json({ plan, model: AI.model });
  } catch (err) {
    res.status(502).json({ error: 'AI request failed: ' + err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('DWFx Measure server on port', port, AI.key ? `(AI: ${AI.model})` : '(AI off)'));
