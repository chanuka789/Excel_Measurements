// Files kept on the users' computers. The add-in reads and processes drawings and models on the computer and keeps
// them there (public/js/localstore.js); the server keeps only what the team shares: the name, size and SHA-256
// fingerprint of each file, the model's summary numbers, and the measurements. Another computer opens the same item
// by choosing the same file (the fingerprint must match), so the measurements line up exactly.
import { q, one, tx, audit } from './db.js';
import * as store from './storage.js';
import { DRAWING_TYPES, json, wrap, clean, safeName, uuidOk, fail, need, versionProject } from './http.js';

const SHA = /^[0-9a-f]{64}$/;
const sha = (s) => { const v = String(s || '').toLowerCase(); if (!SHA.test(v)) fail(400, 'The file fingerprint (SHA-256) is missing or not valid.'); return v; };
const size = (n) => { const v = Number(n); if (!Number.isSafeInteger(v) || v < 0) fail(400, 'The file size is not valid.'); return v; };
const num = (n) => (Number.isFinite(Number(n)) && Number(n) >= 0 ? Number(n) : 0);

/** Summary numbers of a model processed on a computer (the model itself stays there). */
export function cleanStats(b = {}) {
  const sheets = (Array.isArray(b.sheets) ? b.sheets : []).slice(0, 200).map(s => ({ index: Math.trunc(num(s.index)), name: clean(s.name, 200), width: num(s.width), height: num(s.height) })).filter(s => s.index >= 1);
  return { elements: Math.trunc(num(b.elements)), categories: Math.trunc(num(b.categories)), withGeometry: Math.trunc(num(b.withGeometry)), triangles: Math.trunc(num(b.triangles)),
    source: clean(b.source, 40) || null, geoNote: clean(b.geoNote, 300) || null, qs: Math.trunc(num(b.qs)), sheets, processedOn: 'computer', processMs: Math.trunc(num(b.ms)) || null };
}

export function registerLocalFirst(api) {
  // a new model version whose DWFx stays on this computer
  api.post('/projects/:pid/models/local', json, wrap(async (req, res) => {
    const pid = req.params.pid;
    await need(req, pid, 'editor');
    const b = req.body || {};
    const fileName = safeName(b.fileName);
    if (!/\.dwfx$/i.test(fileName)) fail(400, 'Only .dwfx files can be loaded as models.');
    const name = clean(b.modelName, 80) || fileName.replace(/\.dwfx$/i, '');
    const fp = sha(b.sha256), bytes = size(b.size);
    const v = await tx(async (x) => {
      const [m] = await x(`INSERT INTO models (project_id, name, discipline) VALUES ($1,$2,$3)
                           ON CONFLICT (project_id, name) DO UPDATE SET discipline=COALESCE(EXCLUDED.discipline, models.discipline) RETURNING *`,
        [pid, name, clean(b.discipline, 40) || null]);
      const [{ n }] = await x(`SELECT COALESCE(max(version),0)+1 AS n FROM model_versions WHERE model_id=$1`, [m.id]);
      const [v] = await x(`INSERT INTO model_versions (model_id, version, file_name, size, storage_key, status, progress, note, uploaded_by, local_seen, sha256, location)
                           VALUES ($1,$2,$3,$4,$5,'local','Processing on the uploader''s computer',$6,$7,now(),$8,'local') RETURNING *`,
        [m.id, n, fileName, bytes, `local-only/${pid}/${m.id}/v${n}`, clean(b.note, 300) || null, req.user.id, fp]);
      return v;
    });
    await q(`UPDATE projects SET updated_at=now() WHERE id=$1`, [pid]);
    await audit(req.user.id, pid, 'model.add_local', { model: name, version: v.version, file: v.file_name, size: bytes });
    res.status(201).json({ version: v });
  }));

  // processed on a computer: only the summary numbers come to the server
  api.post('/versions/:vid/local-ready', json, wrap(async (req, res) => {
    const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
    await need(req, v.project_id, 'editor');
    if (v.location !== 'local') fail(409, 'This version is stored on the server.');
    if (v.status === 'ready') return res.json({ ok: true, stats: v.stats });         // another computer finished it first
    const stats = cleanStats(req.body);
    await q(`UPDATE model_versions SET status='ready', progress=NULL, error=NULL, stats=$2, processed_at=now() WHERE id=$1`, [v.id, stats]);
    await audit(req.user.id, v.project_id, 'model.processed_locally', { version: v.version, ms: stats.processMs, elements: stats.elements });
    res.json({ ok: true, stats });
  }));
  // processing failed on the computer (the server cannot take it over: it has no copy)
  api.post('/versions/:vid/local-failed', json, wrap(async (req, res) => {
    const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
    await need(req, v.project_id, 'editor');
    if (v.location !== 'local' || v.status === 'ready') return res.json({ status: v.status });
    await q(`UPDATE model_versions SET status='failed', progress=NULL, error=$2 WHERE id=$1`, [v.id, clean(req.body?.reason, 300) || 'Processing on the computer failed.']);
    res.json({ status: 'failed' });
  }));
  api.post('/versions/:vid/local-again', json, wrap(async (req, res) => {
    const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
    await need(req, v.project_id, 'editor');
    if (v.location !== 'local') fail(409, 'This version is stored on the server.');
    if (v.status !== 'ready') await q(`UPDATE model_versions SET status='local', progress='Processing on a computer', error=NULL, local_seen=now() WHERE id=$1`, [v.id]);
    res.json({ ok: true });
  }));

  // drawings whose files stay on this computer
  api.post('/projects/:pid/drawings/local', json, wrap(async (req, res) => {
    const pid = req.params.pid;
    await need(req, pid, 'editor');
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length || files.length > 50) fail(400, 'Choose between 1 and 50 drawings.');
    let folder = null;
    if (req.body?.folderId) {
      const f = uuidOk(req.body.folderId) ? await one(`SELECT * FROM folders WHERE id=$1`, [req.body.folderId]) : null;
      if (!f || f.project_id !== pid || f.kind !== 'drawing') fail(400, 'Folder not found in this project.');
      folder = f.id;
    }
    const list = files.map(f => ({ name: safeName(f.name), size: size(f.size), type: clean(f.type, 100) || null, sha256: sha(f.sha256) }));
    const bad = list.find(f => !DRAWING_TYPES.test(f.name));
    if (bad) fail(400, `${bad.name}: this file type is not accepted. Use PDF, DWFx, DWF, DWG, DXF, images, XLSX or DOCX.`);
    const out = [];
    for (const f of list) {
      const d = await one(`INSERT INTO drawings (project_id, name, size, content_type, storage_key, uploaded_by, folder_id, sha256, location)
                           VALUES ($1,$2,$3,$4,'local-only',$5,$6,$7,'local') RETURNING id, name, size, content_type, sha256, location, folder_id, created_at`,
        [pid, f.name, f.size, f.type, req.user.id, folder, f.sha256]);
      out.push(d);
    }
    await audit(req.user.id, pid, 'drawing.add_local', { files: out.map(o => o.name) });
    res.status(201).json({ drawings: out });
  }));

  // move a file stored on the server to the computers: the add-in has already saved its own copy (same fingerprint),
  // then the server copy (and what was made from it) is deleted. Owners only, because teammates then need the file.
  api.post('/versions/:vid/keep-local', json, wrap(async (req, res) => {
    const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
    await need(req, v.project_id, 'owner');
    if (v.location === 'local') return res.json({ ok: true });
    if (v.status !== 'ready') fail(409, 'Wait until this version is processed.');
    const fp = sha(req.body?.sha256);
    await q(`UPDATE model_versions SET location='local', sha256=$2, storage_key=$3, stats=jsonb_set(coalesce(stats,'{}'), '{processedOn}', '"computer"') WHERE id=$1`,
      [v.id, fp, `local-only/${v.project_id}/${v.model_id}/v${v.version}`]);
    await store.removePrefix(v.storage_key.replace(/source\.dwfx$/, ''));
    await audit(req.user.id, v.project_id, 'model.keep_local', { model: v.model_name, version: v.version });
    res.json({ ok: true });
  }));
  api.post('/drawings/:id/keep-local', json, wrap(async (req, res) => {
    if (!uuidOk(req.params.id)) fail(404, 'Drawing not found.');
    const d = await one(`SELECT * FROM drawings WHERE id=$1`, [req.params.id]); if (!d) fail(404, 'Drawing not found.');
    await need(req, d.project_id, 'owner');
    if (d.location === 'local') return res.json({ ok: true });
    const fp = sha(req.body?.sha256);
    await q(`UPDATE drawings SET location='local', sha256=$2, storage_key='local-only' WHERE id=$1`, [d.id, fp]);
    await store.removePrefix(`projects/${d.project_id}/drawings/${d.id}/`);
    await audit(req.user.id, d.project_id, 'drawing.keep_local', { name: d.name });
    res.json({ ok: true });
  }));
}
