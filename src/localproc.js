// Models processed on the user's computer (public/js/localproc.js): the browser sends the finished model and the
// server checks it and stores it. The server can always take over: "server" queues the normal processing, and a
// computer that stops reporting for 10 minutes hands its model to the server automatically (worker.js).
import os from 'os';
import fs from 'fs/promises';
import zlib from 'zlib';
import { promisify } from 'util';
import multer from 'multer';
import { q, audit } from './db.js';
import * as store from './storage.js';
import { enqueue } from './jobs.js';
import { dataKey } from './processing.js';
import { json, wrap, clean, fail, need, versionProject } from './http.js';
import { binHeader } from '../public/js/modelmerge.js';

const gunzip = promisify(zlib.gunzip);
const MAX_MODEL = 400 * 1024 * 1024, MAX_GEO = 1024 * 1024 * 1024, MAX_SHEETS = 60;
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 600 * 1024 * 1024, files: MAX_SHEETS + 2, fields: 10, fieldSize: 200000 } });
export const LOCAL_TIMEOUT_MIN = 10;

async function localVersion(req) {
  const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
  const role = await need(req, v.project_id, 'editor');
  if (v.uploaded_by !== req.user.id && role !== 'owner') fail(403, 'Only the person who uploaded this version (or the project owner) can process it on their computer.');
  return v;
}
const unzip = async (file, max, what) => {
  const raw = await fs.readFile(file);
  let out;
  try { out = await gunzip(raw, { maxOutputLength: max }); } catch (err) { fail(400, `The ${what} could not be read (${err.code === 'ERR_BUFFER_TOO_LARGE' ? 'too large' : 'not gzip'}).`); }
  return { raw, out };
};

/** Check a model payload made by a browser: the shape the add-in reads, nothing more. Returns stats. */
export function checkPayload(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.elements)) fail(400, 'The processed model has no element list.');
  if (p.elements.length > 1_000_000) fail(400, 'The processed model has too many elements.');
  for (const e of p.elements) {
    if (!e || !Number.isFinite(Number(e.id)) || typeof e.cat !== 'string' || typeof e.type !== 'string' || !e.q || typeof e.q !== 'object')
      fail(400, 'The processed model has an element in the wrong format.');
    for (const v of Object.values(e.q)) if (!Array.isArray(v) || !Number.isFinite(v[0]) || typeof v[1] !== 'string') fail(400, `Element ${e.id} has a quantity in the wrong format.`);
  }
  if (p.categories && typeof p.categories !== 'object') fail(400, 'The processed model has categories in the wrong format.');
}
/** geometry.bin layout check (py/pack.py): header JSON and the exact byte length it implies. */
export function checkGeometry(bin) {
  if (bin.length < 12 || bin.subarray(0, 4).toString() !== 'DWG2') fail(400, 'The processed 3D geometry is not in the expected format.');
  let h; try { h = binHeader(bin); } catch { fail(400, 'The processed 3D geometry header could not be read.'); }
  const hl = bin.readUInt32LE(4);
  if (8 + hl + h.nVerts * 12 + h.nTris * 12 + h.nEdges * 8 !== bin.length) fail(400, 'The processed 3D geometry is incomplete.');
  return h;
}
/** SVG sheets are shown inline in the drawing viewer: refuse anything that could run code. */
export function checkSvg(text) {
  if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) fail(400, 'A 2D sheet is not an SVG file.');
  if (/<script|<foreignObject|<iframe|<embed|<object|\son[a-z]+\s*=|javascript:|data:text\/html/i.test(text)) fail(400, 'A 2D sheet contains content that is not allowed.');
}

export function registerLocal(api) {
  // progress / heartbeat from the computer doing the work
  api.post('/versions/:vid/local', json, wrap(async (req, res) => {
    const v = await localVersion(req);
    if (v.status !== 'local') return res.json({ status: v.status });          // the server took over meanwhile
    await q(`UPDATE model_versions SET progress=$2, local_seen=now() WHERE id=$1 AND status='local'`, [v.id, clean(req.body?.progress, 200) || 'Processing on the uploader\'s computer']);
    res.json({ status: 'local' });
  }));
  // start (again) on this computer: the browser downloads the original DWFx itself
  api.post('/versions/:vid/local-start', json, wrap(async (req, res) => {
    const v = await localVersion(req);
    if (!['failed', 'queued', 'local'].includes(v.status)) fail(409, 'This version is being processed or is ready.');
    await q(`UPDATE model_versions SET status='local', progress='Processing on the uploader''s computer', error=NULL, local_seen=now() WHERE id=$1`, [v.id]);
    await q(`UPDATE jobs SET status='done', finished_at=now(), error='taken by the uploader''s computer' WHERE kind='process_version' AND status='queued' AND payload->>'versionId'=$1`, [v.id]);
    res.json({ ok: true });
  }));
  // hand over to the server (the browser could not do it, or the user asked)
  api.post('/versions/:vid/server', json, wrap(async (req, res) => {
    const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
    await need(req, v.project_id, 'editor');
    if (!['local', 'failed'].includes(v.status)) return res.json({ status: v.status });
    const why = clean(req.body?.reason, 300);
    await q(`UPDATE model_versions SET status='queued', progress=$2, error=NULL WHERE id=$1`, [v.id, why ? `Processing on the server (the computer could not: ${why})` : 'Waiting to be processed on the server']);
    await enqueue('process_version', { versionId: v.id });
    res.json({ status: 'queued' });
  }));
  // the finished model from the computer
  api.post('/versions/:vid/processed', upload.any(), wrap(async (req, res) => {
    const files = req.files || [];
    try {
      const v = await localVersion(req);
      if (v.status !== 'local') fail(409, 'This version is no longer waiting for your computer (the server may have taken over).');
      const f = (n) => files.find(x => x.fieldname === n);
      if (!f('model')) fail(400, 'The processed model is missing.');
      const model = await unzip(f('model').path, MAX_MODEL, 'processed model');
      let payload; try { payload = JSON.parse(model.out.toString('utf8')); } catch { fail(400, 'The processed model is not valid JSON.'); }
      checkPayload(payload);
      let geo = null, head = null;
      if (f('geometry')) { geo = await unzip(f('geometry').path, MAX_GEO, '3D geometry'); head = checkGeometry(geo.out); }
      let sheets = [];
      try { sheets = JSON.parse(req.body?.sheets || '[]'); } catch { fail(400, 'The sheet list is not valid.'); }
      if (!Array.isArray(sheets) || sheets.length > MAX_SHEETS) fail(400, 'Too many 2D sheets.');
      const svgs = [];
      for (const sh of sheets) {
        const n = Number(sh.index); if (!Number.isInteger(n) || n < 1 || n > 10000) fail(400, 'A 2D sheet number is not valid.');
        const file = f(`sheet_${n}`); if (!file) fail(400, `2D sheet ${n} is missing.`);
        const svg = await unzip(file.path, 200 * 1024 * 1024, '2D sheet'); checkSvg(svg.out.toString('utf8'));
        svgs.push({ n, raw: svg.raw, meta: { index: n, name: clean(sh.name, 200), width: Number(sh.width) || 0, height: Number(sh.height) || 0 } });
      }
      // store exactly what was checked; the file name always comes from the upload, never from the browser
      payload.fileName = v.file_name;
      payload.geometryFormat = geo ? 'bin2' : 'none';
      await store.putBuffer(dataKey(v.storage_key, 'model.json.gz'), zlib.gzipSync(JSON.stringify(payload)), 'application/json', { ContentEncoding: 'gzip' });
      if (geo) await store.putBuffer(dataKey(v.storage_key, 'geometry.bin.gz'), geo.raw, 'application/octet-stream', { ContentEncoding: 'gzip' });
      for (const s of svgs) await store.putBuffer(dataKey(v.storage_key, `sheets/sheet-${s.n}.svg.gz`), s.raw, 'image/svg+xml', { ContentEncoding: 'gzip' });
      const stats = { elements: payload.elements.length, categories: Object.keys(payload.categories || {}).length,
        withGeometry: payload.elements.filter(e => e.bb).length, triangles: head ? head.nTris : 0, source: payload.source, geoNote: clean(payload.geoNote, 300),
        qs: payload.qsVersion || 0, sheets: svgs.map(s => s.meta), processedOn: 'browser', processMs: Number(req.body?.ms) || null };
      const r = await q(`UPDATE model_versions SET status='ready', progress=NULL, error=NULL, stats=$2, processed_at=now() WHERE id=$1 AND status='local' RETURNING id`, [v.id, stats]);
      if (!r.length) fail(409, 'This version is no longer waiting for your computer.');
      await audit(req.user.id, v.project_id, 'model.processed_locally', { version: v.version, ms: stats.processMs, elements: stats.elements });
      res.json({ ok: true, stats });
    } finally { for (const x of files) fs.rm(x.path, { force: true }).catch(() => {}); }
  }));
}

/** Worker: a computer that stopped reporting hands its model to the server. */
export async function localTimeouts() {
  const stale = await q(`UPDATE model_versions SET status='queued', progress='The uploader''s computer stopped: processing on the server'
                         WHERE status='local' AND coalesce(local_seen, created_at) < now() - make_interval(mins => $1) RETURNING id`, [LOCAL_TIMEOUT_MIN]);
  for (const v of stale) await enqueue('process_version', { versionId: v.id });
  return stale.length;
}
