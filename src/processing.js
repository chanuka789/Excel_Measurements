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

const run = promisify(execFile);
const gzip = promisify(zlib.gzip);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.PYTHON || 'python3';
const opts = { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, timeout: 30 * 60 * 1000 };

export const dataKey = (srcKey, name) => srcKey.replace(/source\.dwfx$/, name);

/** Read a DWFx file on disk. Returns { elements payload, geometry, geoNote }. */
export async function readModel(file, work) {
  await run(PY, ['-I', 'py/elements.py', file, path.join(work, 'elements.json')], opts);
  let geometry = { meshes: [], labels: {} }, geoNote = '';
  try {
    await run('node', ['decode.mjs', file, path.join(work, 'meshes.json')], opts);
    await run(PY, ['-I', 'py/geometry.py', file, path.join(work, 'meshes.json'), path.join(work, 'geometry.json')], opts);
    geometry = JSON.parse(await fs.readFile(path.join(work, 'geometry.json'), 'utf8'));
  } catch { geoNote = '3D geometry could not be decoded for this file; measurements still work.'; }
  const elements = JSON.parse(await fs.readFile(path.join(work, 'elements.json'), 'utf8'));
  return { elements, geometry, geoNote };
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
    await setProgress(v.id, 'processing', 'Reading elements and building 3D model');
    const { elements, geometry, geoNote } = await readModel(file, work);
    await setProgress(v.id, 'processing', 'Saving');
    const payload = { fileName: v.file_name, ...elements, geometry, geoNote };
    await store.putBuffer(dataKey(v.storage_key, 'model.json.gz'), await gzip(JSON.stringify(payload)), 'application/json', { ContentEncoding: 'gzip' });
    const withGeo = new Set((geometry.meshes || []).map(m => m.id)).size;
    const stats = { elements: elements.elements.length, categories: Object.keys(elements.categories).length,
      withGeometry: withGeo, meshes: (geometry.meshes || []).length, source: elements.source, geoNote };
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
  const tables = ['users', 'projects', 'project_members', 'models', 'model_versions', 'drawings', 'takeoffs', 'audit', 'settings'];
  const out = { at: new Date().toISOString() };
  for (const t of tables) out[t] = await q(`SELECT * FROM ${t}`);
  const key = `backups/${out.at.slice(0, 10)}.json.gz`;
  await store.putBuffer(key, await gzip(JSON.stringify(out)), 'application/json');
  // keep 30 days
  const old = (await store.list('backups/')).map(o => o.key).sort().slice(0, -30);
  for (const k of old) await store.removeKey(k);
  return key;
}
