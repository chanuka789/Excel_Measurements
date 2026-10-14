// Turns an uploaded DWFx version into element data + 3D geometry stored next to it.
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { q, one } from './db.js';
import * as store from './storage.js';
import { mergeQs, mergeMetrics, QS_VERSION, binHeader } from '../public/js/modelmerge.js';
export { mergeQs, mergeMetrics, QS_VERSION };

const run = promisify(execFile);
const gzip = promisify(zlib.gzip);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.PYTHON || 'python3';
const opts = { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60 * 1000 };

export const dataKey = (srcKey, name) => srcKey.replace(/source\.dwfx$/, name);

/** Read a DWFx file on disk.
 * Returns { elements payload (with exact geometry quantities merged in), geometryBin (Buffer|null), geoNote }. */
export async function readModel(file, work, step = () => {}) {
  await step('Reading elements and properties');
  await run(PY, ['-I', 'py/elements.py', file, path.join(work, 'elements.json')], opts);
  const elements = JSON.parse(await fs.readFile(path.join(work, 'elements.json'), 'utf8'));
  let geometryBin = null, geoNote = '', metrics = {};
  try {
    await step('Decoding the 3D model');
    await run('node', ['decode.mjs', file, path.join(work, 'meshes.bin')], opts);
    await run(PY, ['-I', 'py/geometry.py', file, path.join(work, 'meshes.bin'), path.join(work, 'geometry.json'), path.join(work, 'placed.bin')], opts);
    await step('Measuring the 3D geometry');
    await run(PY, ['-I', 'py/pack.py', path.join(work, 'geometry.json'), path.join(work, 'placed.bin'), path.join(work, 'geometry.bin'), path.join(work, 'metrics.json')], opts);
    geometryBin = await fs.readFile(path.join(work, 'geometry.bin'));
    metrics = JSON.parse(await fs.readFile(path.join(work, 'metrics.json'), 'utf8'));
  } catch { geoNote = '3D geometry could not be decoded for this file; measurements still work.'; }
  mergeMetrics(elements, metrics, geometryBin);
  if (geometryBin) {
    try {
      await step('Formwork and contact analysis');
      await run(PY, ['-I', 'py/qs.py', path.join(work, 'geometry.bin'), path.join(work, 'geometry.json'), path.join(work, 'qs.json')], opts);
      mergeQs(elements, JSON.parse(await fs.readFile(path.join(work, 'qs.json'), 'utf8')));
    } catch (err) { console.error('QS face analysis failed:', String(err.stderr || err.message).slice(-400)); }
  }
  return { elements, geometryBin, geoNote };
}

/** Job: add the QS face analysis to a model processed before it existed (no reprocess, no downtime). */
export async function updateQs(versionId) {
  const v = await one(`SELECT * FROM model_versions WHERE id=$1`, [versionId]);
  if (!v || v.status !== 'ready') return;
  const work = path.join(os.tmpdir(), 'qs-' + crypto.randomUUID());
  await fs.mkdir(work);
  try {
    const gz = promisify(zlib.gunzip);
    // object storage may hand back the bytes already decoded (Content-Encoding: gzip): unzip only real gzip data
    const gunzip = async (b) => (b[0] === 0x1f && b[1] === 0x8b ? gz(b) : b);
    const model = JSON.parse((await gunzip(await store.getBuffer(dataKey(v.storage_key, 'model.json.gz')))).toString());
    const mark = () => q(`UPDATE model_versions SET stats = coalesce(stats,'{}'::jsonb) || jsonb_build_object('qs', $2::int) WHERE id=$1`, [v.id, QS_VERSION]);
    if (model.qsVersion >= QS_VERSION || model.geometryFormat !== 'bin2') { await mark(); return; }
    await fs.writeFile(path.join(work, 'geometry.bin'), await gunzip(await store.getBuffer(dataKey(v.storage_key, 'geometry.bin.gz'))));
    await fs.writeFile(path.join(work, 'geometry.json'), JSON.stringify({ categories: Object.fromEntries(model.elements.map(e => [e.id, e.cat])) }));
    await run(PY, ['-I', 'py/qs.py', path.join(work, 'geometry.bin'), path.join(work, 'geometry.json'), path.join(work, 'qs.json')], opts);
    mergeQs(model, JSON.parse(await fs.readFile(path.join(work, 'qs.json'), 'utf8')));
    await store.putBuffer(dataKey(v.storage_key, 'model.json.gz'), await gzip(JSON.stringify(model)), 'application/json', { ContentEncoding: 'gzip' });
    await mark();
  } finally { fs.rm(work, { recursive: true, force: true }).catch(() => {}); }
}

const setProgress = (id, status, progress) => q(`UPDATE model_versions SET status=$2, progress=$3 WHERE id=$1`, [id, status, progress]);

/** Job handler: process one model version. */
export async function processVersion(versionId) {
  const v = await one(`SELECT * FROM model_versions WHERE id=$1`, [versionId]);
  if (!v) return;
  const work = path.join(os.tmpdir(), 'job-' + crypto.randomUUID());
  await fs.mkdir(work);
  try {
    await setProgress(v.id, 'processing', 'Downloading file');
    const file = path.join(work, 'model.dwfx');
    await store.download(v.storage_key, file);
    const { elements, geometryBin, geoNote } = await readModel(file, work, (t) => setProgress(v.id, 'processing', t).catch(() => {}));
    await setProgress(v.id, 'processing', 'Saving');
    const payload = { fileName: v.file_name, ...elements, geometryFormat: geometryBin ? 'bin2' : 'none', geoNote };
    await store.putBuffer(dataKey(v.storage_key, 'model.json.gz'), await gzip(JSON.stringify(payload)), 'application/json', { ContentEncoding: 'gzip' });
    if (geometryBin) await store.putBuffer(dataKey(v.storage_key, 'geometry.bin.gz'), await gzip(geometryBin), 'application/octet-stream', { ContentEncoding: 'gzip' });
    // 2D sheets inside the DWFx (if any) become SVG files next to the model
    let sheets = [];
    try {
      await run(PY, ['-I', 'py/sheets.py', file, path.join(work, 'sheets')], opts);
      sheets = JSON.parse(await fs.readFile(path.join(work, 'sheets', 'sheets.json'), 'utf8'));
      for (const sh of sheets) {
        const svg = await fs.readFile(path.join(work, 'sheets', `sheet-${sh.index}.svg`));
        await store.putBuffer(dataKey(v.storage_key, `sheets/sheet-${sh.index}.svg.gz`), await gzip(svg), 'image/svg+xml', { ContentEncoding: 'gzip' });
      }
    } catch (err) { console.error('sheet conversion failed:', err.message); sheets = []; }
    const withGeo = elements.elements.filter(e => e.bb).length;
    const stats = { elements: elements.elements.length, categories: Object.keys(elements.categories).length,
      withGeometry: withGeo, triangles: geometryBin ? binHeader(geometryBin).nTris : 0,
      source: elements.source, geoNote, qs: elements.qsVersion || 0, sheets: sheets.map(({ index, name, width, height }) => ({ index, name, width, height })) };
    await q(`UPDATE model_versions SET status='ready', progress=NULL, error=NULL, stats=$2, processed_at=now() WHERE id=$1`, [v.id, stats]);
  } catch (err) {
    const msg = String(err.stderr || err.message || err).trim().split('\n').pop().slice(0, 500);
    await q(`UPDATE model_versions SET status='failed', progress=NULL, error=$2 WHERE id=$1`, [v.id, msg]);
    throw err;
  } finally {
    fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** Daily backup: every table as gzipped JSON in the bucket (backups/YYYY-MM-DD.json.gz). */
export async function backupDatabase() {
  const tables = ['users', 'projects', 'project_members', 'models', 'model_versions', 'drawings', 'takeoffs', 'audit', 'settings', 'views', 'templates', 'zones', 'kb_rules', 'ai_usage', 'exports', 'folders', 'dim_groups', 'dim_items'];
  const out = { at: new Date().toISOString() };
  for (const t of tables) out[t] = await q(`SELECT * FROM ${t}`);
  const key = `backups/${out.at.slice(0, 10)}.json.gz`;
  await store.putBuffer(key, await gzip(JSON.stringify(out)), 'application/json');
  // keep 30 days
  const old = (await store.list('backups/')).map(o => o.key).sort().slice(0, -30);
  for (const k of old) await store.removeKey(k);
  return key;
}
