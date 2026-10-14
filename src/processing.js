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

/** Read a DWFx file on disk.
 * Returns { elements payload (with exact geometry quantities merged in), geometryBin (Buffer|null), geoNote }. */
export async function readModel(file, work) {
  await run(PY, ['-I', 'py/elements.py', file, path.join(work, 'elements.json')], opts);
  const elements = JSON.parse(await fs.readFile(path.join(work, 'elements.json'), 'utf8'));
  let geometryBin = null, geoNote = '', metrics = {};
  try {
    await run('node', ['decode.mjs', file, path.join(work, 'meshes.json')], opts);
    await run(PY, ['-I', 'py/geometry.py', file, path.join(work, 'meshes.json'), path.join(work, 'geometry.json')], opts);
    await run(PY, ['-I', 'py/pack.py', path.join(work, 'geometry.json'), path.join(work, 'geometry.bin'), path.join(work, 'metrics.json')], opts);
    geometryBin = await fs.readFile(path.join(work, 'geometry.bin'));
    metrics = JSON.parse(await fs.readFile(path.join(work, 'metrics.json'), 'utf8'));
  } catch { geoNote = '3D geometry could not be decoded for this file; measurements still work.'; }
  mergeMetrics(elements, metrics, geometryBin);
  return { elements, geometryBin, geoNote };
}

/** Add exact quantities measured from the 3D geometry to each element (kept separate from Revit's values). */
export function mergeMetrics(elements, metrics, geometryBin) {
  let up = 'y';
  if (geometryBin && geometryBin.length > 8) {
    try { up = JSON.parse(geometryBin.subarray(8, 8 + geometryBin.readUInt32LE(4)).toString()).up || 'y'; } catch { /* keep default */ }
  }
  const ax = { x: 0, y: 1, z: 2 }[up] ?? 1, hz = [0, 1, 2].filter(i => i !== ax);
  elements.up = up;
  for (const e of elements.elements) {
    const m = metrics[String(e.id)]; if (!m) continue;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const ext = [0, 1, 2].map(i => m.bb[i + 3] - m.bb[i]);
    const [L, W] = hz.map(i => ext[i]).sort((a, b) => b - a);
    e.bb = m.bb;
    if (m.solid) e.q['Geo volume'] = [r3(m.vol), 'm3'];
    e.q['Geo surface area'] = [r3(m.area), 'm2'];
    e.q['Geo top area'] = [r3(m.top), 'm2'];
    e.q['Geo bottom area'] = [r3(m.bottom), 'm2'];
    e.q['Geo side area'] = [r3(m.side), 'm2'];
    e.q['Geo plan area'] = [r3(m.plan), 'm2'];
    e.q['Geo box length'] = [r3(L), 'm'];
    e.q['Geo box width'] = [r3(W), 'm'];
    e.q['Geo box height'] = [r3(ext[ax]), 'm'];
  }
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
    const { elements, geometryBin, geoNote } = await readModel(file, work);
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
      withGeometry: withGeo, triangles: geometryBin ? JSON.parse(geometryBin.subarray(8, 8 + geometryBin.readUInt32LE(4)).toString()).nTris : 0,
      source: elements.source, geoNote, sheets: sheets.map(({ index, name, width, height }) => ({ index, name, width, height })) };
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
