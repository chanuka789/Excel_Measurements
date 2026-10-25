// REST API: auth, projects, members, model versions, drawings, take-offs, export, admin.
import express from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import archiver from 'archiver';
import { q, one, tx, audit } from './db.js';
import * as store from './storage.js';
import { enqueue } from './jobs.js';
import { backupDatabase, dataKey } from './processing.js';
import { login, logout, requireUser, requireAdmin, hashPassword, syncUsers, publicUser, downloadTicket } from './auth.js';
import { json, wrap, clean, safeName, uuidOk, HttpError, fail, need, versionProject, RANK } from './http.js';
import { registerFeatures } from './features.js';
import { registerDims } from './dims.js';
import { registerLink } from './link.js';
import { registerLocal } from './localproc.js';
import { loginGuard, loginFailed, loginSucceeded, apiLimit } from './security.js';
import { recordError } from './monitor.js';

export const api = express.Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 500 * 1024 * 1024, files: 20 } });
// ---------------------------------------------------------------- auth
api.post('/auth/login', json, loginGuard, wrap(async (req, res) => {
  const r = await login(req.body?.email, req.body?.password, req.get('user-agent'));
  if (!r) { loginFailed(req.body?.email); return res.status(401).json({ error: 'Email or password is not correct, or the account is disabled.' }); }
  loginSucceeded(req.body?.email);
  res.json(r);
}));
api.use(wrap(requireUser));
api.use(apiLimit());
api.post('/auth/logout', wrap(async (req, res) => { await logout(req.token); res.json({ ok: true }); }));
api.get('/auth/me', (req, res) => res.json({ user: req.user }));
/** A one-time link to a file the signed-in user can already download (used by Excel desktop). */
api.post('/download-ticket', json, (req, res) => {
  const path = String(req.body?.path || '');
  if (!/^\/[A-Za-z0-9/_.-]{1,300}$/.test(path) || path.includes('..')) return res.status(400).json({ error: 'Not a file link.' });
  res.json({ url: 'api' + path + '?dt=' + downloadTicket(req.user.id, path) });
});
api.get('/users/directory', wrap(async (req, res) => {
  res.json({ users: await q(`SELECT id, name, email FROM users WHERE active ORDER BY name`) });
}));

// ---------------------------------------------------------------- projects
api.get('/projects', wrap(async (req, res) => {
  const all = req.user.role === 'admin';
  const rows = await q(`
    SELECT p.*, COALESCE(pm.role, CASE WHEN $2 THEN 'owner' END) AS my_role,
      (SELECT count(*) FROM models m WHERE m.project_id=p.id)::int AS models,
      (SELECT count(*) FROM drawings d WHERE d.project_id=p.id)::int AS drawings,
      (SELECT count(*) FROM takeoffs t WHERE t.project_id=p.id)::int AS takeoffs,
      (SELECT string_agg(u.name, ', ' ORDER BY u.name) FROM project_members x JOIN users u ON u.id=x.user_id WHERE x.project_id=p.id) AS member_names
    FROM projects p LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$1
    WHERE $2 OR pm.user_id IS NOT NULL ORDER BY p.updated_at DESC`, [req.user.id, all]);
  res.json({ projects: rows });
}));
api.post('/projects', json, wrap(async (req, res) => {
  const name = clean(req.body?.name, 120); if (!name) fail(400, 'Give the project a name.');
  const p = await tx(async (x) => {
    const [p] = await x(`INSERT INTO projects (name, code, client, description, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, clean(req.body.code, 40) || null, clean(req.body.client, 120) || null, clean(req.body.description, 1000) || null, req.user.id]);
    await x(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'owner')`, [p.id, req.user.id]);
    return p;
  });
  await audit(req.user.id, p.id, 'project.create', { name });
  res.status(201).json({ project: p });
}));
api.get('/projects/:pid', wrap(async (req, res) => {
  const my = await need(req, req.params.pid, 'viewer');
  const pid = req.params.pid;
  const [project, members, models, versions, drawings, takeoffs] = await Promise.all([
    one(`SELECT * FROM projects WHERE id=$1`, [pid]),
    q(`SELECT u.id, u.name, u.email, m.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1 ORDER BY m.role, u.name`, [pid]),
    q(`SELECT * FROM models WHERE project_id=$1 ORDER BY name`, [pid]),
    q(`SELECT v.id, v.model_id, v.version, v.file_name, v.size, v.status, v.progress, v.error, v.stats, v.note, v.created_at, u.name AS uploaded_by
       FROM model_versions v JOIN models m ON m.id=v.model_id LEFT JOIN users u ON u.id=v.uploaded_by WHERE m.project_id=$1 ORDER BY v.version DESC`, [pid]),
    q(`SELECT d.id, d.name, d.size, d.content_type, d.folder_id, d.created_at, u.name AS uploaded_by FROM drawings d LEFT JOIN users u ON u.id=d.uploaded_by WHERE d.project_id=$1 ORDER BY d.created_at DESC`, [pid]),
    q(`SELECT t.id, t.name, t.version_id, t.created_at, u.name AS created_by, jsonb_array_length(t.spec->'ids') AS elements
       FROM takeoffs t LEFT JOIN users u ON u.id=t.created_by WHERE t.project_id=$1 ORDER BY t.created_at`, [pid]),
  ]);
  models.forEach(m => { m.versions = versions.filter(v => v.model_id === m.id); });
  res.json({ project, my_role: my, members, models, drawings, takeoffs });
}));
api.patch('/projects/:pid', json, wrap(async (req, res) => {
  await need(req, req.params.pid, 'owner');
  const b = req.body || {};
  const p = await one(`UPDATE projects SET name=COALESCE($2,name), code=$3, client=$4, description=$5, updated_at=now() WHERE id=$1 RETURNING *`,
    [req.params.pid, clean(b.name, 120) || null, clean(b.code, 40) || null, clean(b.client, 120) || null, clean(b.description, 1000) || null]);
  await audit(req.user.id, p.id, 'project.update', { name: p.name });
  res.json({ project: p });
}));
api.delete('/projects/:pid', json, wrap(async (req, res) => {
  await need(req, req.params.pid, 'owner');
  const p = await one(`SELECT * FROM projects WHERE id=$1`, [req.params.pid]);
  if (clean(req.body?.confirm) !== p.name) fail(400, 'Type the project name exactly to confirm deletion.');
  const files = await store.removePrefix(`projects/${p.id}/`);
  await q(`DELETE FROM projects WHERE id=$1`, [p.id]);
  await audit(req.user.id, p.id, 'project.delete', { name: p.name, files });
  res.json({ ok: true, filesDeleted: files });
}));

// ---------------------------------------------------------------- members
api.post('/projects/:pid/members', json, wrap(async (req, res) => {
  await need(req, req.params.pid, 'owner');
  const role = req.body?.role; if (!RANK[role]) fail(400, 'Role must be owner, editor or viewer.');
  const u = await one(`SELECT * FROM users WHERE email=$1 AND active`, [clean(req.body?.email).toLowerCase()]);
  if (!u) fail(404, 'No active user with that email. Add the user to APP_USERS in Railway first.');
  await q(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (project_id, user_id) DO UPDATE SET role=$3`, [req.params.pid, u.id, role]);
  await audit(req.user.id, req.params.pid, 'member.set', { email: u.email, role });
  res.json({ ok: true });
}));
api.delete('/projects/:pid/members/:uid', wrap(async (req, res) => {
  await need(req, req.params.pid, 'owner');
  const owners = await q(`SELECT user_id FROM project_members WHERE project_id=$1 AND role='owner'`, [req.params.pid]);
  if (owners.length === 1 && owners[0].user_id === Number(req.params.uid)) fail(400, 'A project needs at least one owner.');
  await q(`DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, [req.params.pid, Number(req.params.uid)]);
  await audit(req.user.id, req.params.pid, 'member.remove', { user_id: Number(req.params.uid) });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- model versions
api.post('/projects/:pid/models', upload.single('model'), wrap(async (req, res) => {
  try {
    await need(req, req.params.pid, 'editor');
    if (!req.file) fail(400, 'No DWFx file received.');
    if (!/\.dwfx$/i.test(req.file.originalname)) fail(400, 'Only .dwfx files can be loaded as models.');
    const name = clean(req.body?.modelName, 80) || req.file.originalname.replace(/\.dwfx$/i, '');
    const pid = req.params.pid;
    // local=1: the uploader's browser processes the model (public/js/localproc.js); the server only takes over if it cannot
    const local = req.body?.local === '1';
    const v = await tx(async (x) => {
      const [m] = await x(`INSERT INTO models (project_id, name, discipline) VALUES ($1,$2,$3)
                           ON CONFLICT (project_id, name) DO UPDATE SET discipline=COALESCE(EXCLUDED.discipline, models.discipline) RETURNING *`,
        [pid, name, clean(req.body?.discipline, 40) || null]);
      const [{ n }] = await x(`SELECT COALESCE(max(version),0)+1 AS n FROM model_versions WHERE model_id=$1`, [m.id]);
      const key = `projects/${pid}/models/${m.id}/v${n}/source.dwfx`;
      const [v] = await x(`INSERT INTO model_versions (model_id, version, file_name, size, storage_key, status, progress, note, uploaded_by, local_seen)
                           VALUES ($1,$2,$3,$4,$5,$8,$9,$6,$7,$10) RETURNING *`,
        [m.id, n, safeName(req.file.originalname), req.file.size, key, clean(req.body?.note, 300) || null, req.user.id,
          local ? 'local' : 'queued', local ? 'Processing on the uploader\'s computer' : 'Waiting to be processed', local ? new Date() : null]);
      return v;
    });
    await store.putFile(v.storage_key, req.file.path, 'application/octet-stream');
    if (!local) await enqueue('process_version', { versionId: v.id });
    await q(`UPDATE projects SET updated_at=now() WHERE id=$1`, [pid]);
    await audit(req.user.id, pid, 'model.upload', { model: name, version: v.version, file: v.file_name, size: v.size });
    res.status(201).json({ version: v });
  } finally { if (req.file) fs.rm(req.file.path, { force: true }).catch(() => {}); }
}));
api.get('/versions/:vid', wrap(async (req, res) => {
  const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
  await need(req, v.project_id, 'viewer');
  res.json({ version: { id: v.id, version: v.version, status: v.status, progress: v.progress, error: v.error, stats: v.stats, model_name: v.model_name, file_name: v.file_name } });
}));
api.get('/versions/:vid/model', wrap(async (req, res) => {
  const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
  await need(req, v.project_id, 'viewer');
  if (v.status !== 'ready') fail(409, 'This model version is not ready yet.');
  res.set({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
  (await store.getStream(dataKey(v.storage_key, 'model.json.gz'))).pipe(res);
}));
api.get('/versions/:vid/geometry', wrap(async (req, res) => {
  const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
  await need(req, v.project_id, 'viewer');
  if (v.status !== 'ready') fail(409, 'This model version is not ready yet.');
  const key = dataKey(v.storage_key, 'geometry.bin.gz');
  if (!(await store.exists(key))) fail(404, 'This version was processed with an older format. Press "Try again" to reprocess it.');
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Cache-Control': 'private, max-age=86400' });
  (await store.getStream(key)).pipe(res);
}));
api.get('/versions/:vid/source', wrap(async (req, res) => {
  const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
  await need(req, v.project_id, 'viewer');
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${v.file_name}"` });
  (await store.getStream(v.storage_key)).pipe(res);
}));
api.post('/versions/:vid/reprocess', wrap(async (req, res) => {
  const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
  await need(req, v.project_id, 'editor');
  await q(`UPDATE model_versions SET status='queued', progress='Waiting to be processed', error=NULL WHERE id=$1`, [v.id]);
  await enqueue('process_version', { versionId: v.id });
  res.json({ ok: true });
}));
api.delete('/versions/:vid', wrap(async (req, res) => {
  const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
  await need(req, v.project_id, 'owner');
  await store.removePrefix(v.storage_key.replace(/source\.dwfx$/, ''));
  await q(`DELETE FROM model_versions WHERE id=$1`, [v.id]);
  await q(`DELETE FROM models m WHERE m.id=$1 AND NOT EXISTS (SELECT 1 FROM model_versions WHERE model_id=m.id)`, [v.model_id]);
  await audit(req.user.id, v.project_id, 'model.delete_version', { model: v.model_name, version: v.version });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- drawings
const DRAWING_TYPES = /\.(pdf|dwfx|dwf|dwg|dxf|png|jpe?g|tiff?|xlsx|docx)$/i;
api.post('/projects/:pid/drawings', upload.array('files', 20), wrap(async (req, res) => {
  try {
    await need(req, req.params.pid, 'editor');
    if (!req.files?.length) fail(400, 'No files received.');
    let folder = null;
    if (req.body?.folderId) {
      const f = uuidOk(req.body.folderId) ? await one(`SELECT * FROM folders WHERE id=$1`, [req.body.folderId]) : null;
      if (!f || f.project_id !== req.params.pid || f.kind !== 'drawing') fail(400, 'Folder not found in this project.');
      folder = f.id;
    }
    const bad = req.files.find(f => !DRAWING_TYPES.test(f.originalname));
    if (bad) fail(400, `${bad.originalname}: this file type is not accepted. Use PDF, DWFx, DWF, DWG, DXF, images, XLSX or DOCX.`);
    const out = [];
    for (const f of req.files) {
      const d = await one(`INSERT INTO drawings (project_id, name, size, content_type, storage_key, uploaded_by, folder_id)
                           VALUES ($1,$2,$3,$4,'pending',$5,$6) RETURNING *`, [req.params.pid, safeName(f.originalname), f.size, f.mimetype, req.user.id, folder]);
      const key = `projects/${req.params.pid}/drawings/${d.id}/${d.name}`;
      await store.putFile(key, f.path, f.mimetype);
      await q(`UPDATE drawings SET storage_key=$2 WHERE id=$1`, [d.id, key]);
      out.push({ id: d.id, name: d.name, size: d.size });
    }
    await audit(req.user.id, req.params.pid, 'drawing.upload', { files: out.map(o => o.name) });
    res.status(201).json({ drawings: out });
  } finally { (req.files || []).forEach(f => fs.rm(f.path, { force: true }).catch(() => {})); }
}));
api.get('/drawings/:id/file', wrap(async (req, res) => {
  if (!uuidOk(req.params.id)) fail(404, 'Drawing not found.');
  const d = await one(`SELECT * FROM drawings WHERE id=$1`, [req.params.id]); if (!d) fail(404, 'Drawing not found.');
  await need(req, d.project_id, 'viewer');
  res.set({ 'Content-Type': d.content_type || 'application/octet-stream', 'Content-Disposition': `${req.query.inline ? 'inline' : 'attachment'}; filename="${d.name}"` });
  (await store.getStream(d.storage_key)).pipe(res);
}));
api.delete('/drawings/:id', wrap(async (req, res) => {
  if (!uuidOk(req.params.id)) fail(404, 'Drawing not found.');
  const d = await one(`SELECT * FROM drawings WHERE id=$1`, [req.params.id]); if (!d) fail(404, 'Drawing not found.');
  await need(req, d.project_id, 'editor');
  await store.removePrefix(`projects/${d.project_id}/drawings/${d.id}/`);
  await q(`DELETE FROM drawings WHERE id=$1`, [d.id]);
  await audit(req.user.id, d.project_id, 'drawing.delete', { name: d.name });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- take-offs
api.get('/projects/:pid/takeoffs', wrap(async (req, res) => {
  await need(req, req.params.pid, 'viewer');
  res.json({ takeoffs: await q(`SELECT t.*, u.name AS created_by_name FROM takeoffs t LEFT JOIN users u ON u.id=t.created_by WHERE project_id=$1 ORDER BY created_at`, [req.params.pid]) });
}));
api.post('/projects/:pid/takeoffs', json, wrap(async (req, res) => {
  await need(req, req.params.pid, 'editor');
  const spec = req.body?.spec;
  if (!spec || !Array.isArray(spec.ids) || !Array.isArray(spec.inputs)) fail(400, 'Take-off data is missing.');
  const vid = uuidOk(req.body.versionId) ? req.body.versionId : null;
  if (vid) { const v = await versionProject(vid); if (!v || v.project_id !== req.params.pid) fail(400, 'Model version is not in this project.'); }
  const t = await one(`INSERT INTO takeoffs (project_id, version_id, name, spec, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, created_at`,
    [req.params.pid, vid, clean(spec.name, 200) || 'Take-off group', spec, req.user.id]);
  await q(`UPDATE projects SET updated_at=now() WHERE id=$1`, [req.params.pid]);
  await audit(req.user.id, req.params.pid, 'takeoff.save', { name: t.name, elements: spec.ids.length });
  res.status(201).json({ takeoff: t });
}));
api.delete('/takeoffs/:id', wrap(async (req, res) => {
  if (!uuidOk(req.params.id)) fail(404, 'Take-off not found.');
  const t = await one(`SELECT * FROM takeoffs WHERE id=$1`, [req.params.id]); if (!t) fail(404, 'Take-off not found.');
  await need(req, t.project_id, 'editor');
  await q(`DELETE FROM takeoffs WHERE id=$1`, [t.id]);
  await audit(req.user.id, t.project_id, 'takeoff.delete', { name: t.name });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- export + activity
api.get('/projects/:pid/export', wrap(async (req, res) => {
  await need(req, req.params.pid, 'viewer');
  const pid = req.params.pid;
  const p = await one(`SELECT * FROM projects WHERE id=$1`, [pid]);
  const meta = {
    exported_at: new Date().toISOString(), exported_by: req.user.email, project: p,
    members: await q(`SELECT u.name, u.email, m.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE project_id=$1`, [pid]),
    models: await q(`SELECT m.name, m.discipline, v.version, v.file_name, v.size, v.status, v.stats, v.created_at FROM models m JOIN model_versions v ON v.model_id=m.id WHERE m.project_id=$1 ORDER BY m.name, v.version`, [pid]),
    drawings: await q(`SELECT name, size, created_at FROM drawings WHERE project_id=$1`, [pid]),
    takeoffs: await q(`SELECT name, spec, created_at FROM takeoffs WHERE project_id=$1 ORDER BY created_at`, [pid]),
    activity: await q(`SELECT a.at, u.email, a.action, a.detail FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE project_id=$1 ORDER BY at`, [pid]),
  };
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${safeName(p.name)}_export.zip"` });
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', (e) => res.destroy(e));
  zip.pipe(res);
  zip.append(JSON.stringify(meta, null, 2), { name: 'project.json' });
  const vers = await q(`SELECT v.storage_key, v.version, v.file_name, m.name FROM model_versions v JOIN models m ON m.id=v.model_id WHERE m.project_id=$1`, [pid]);
  for (const v of vers) zip.append(await store.getStream(v.storage_key), { name: `models/${safeName(v.name)}/v${v.version}_${v.file_name}` });
  for (const d of await q(`SELECT name, storage_key FROM drawings WHERE project_id=$1`, [pid])) zip.append(await store.getStream(d.storage_key), { name: `drawings/${d.name}` });
  await zip.finalize();
  await audit(req.user.id, pid, 'project.export');
}));
api.get('/projects/:pid/activity', wrap(async (req, res) => {
  await need(req, req.params.pid, 'viewer');
  res.json({ activity: await q(`SELECT a.at, u.name, a.action, a.detail FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE project_id=$1 ORDER BY at DESC LIMIT 200`, [req.params.pid]) });
}));

// ---------------------------------------------------------------- admin
api.get('/admin/users', requireAdmin, wrap(async (req, res) => {
  res.json({ users: await q(`SELECT u.id, u.email, u.name, u.role, u.active, u.created_at, u.last_login,
    (SELECT count(*) FROM project_members m WHERE m.user_id=u.id)::int AS projects FROM users u ORDER BY u.active DESC, u.name`) });
}));
api.post('/admin/hash', requireAdmin, json, wrap(async (req, res) => {
  try { res.json({ hash: hashPassword(String(req.body?.password || '')) }); } catch (e) { fail(400, e.message); }
}));
api.post('/admin/sync-users', requireAdmin, wrap(async (req, res) => { res.json(await syncUsers()); }));
api.get('/admin/audit', requireAdmin, wrap(async (req, res) => {
  res.json({ audit: await q(`SELECT a.at, u.email, a.project_id, p.name AS project, a.action, a.detail FROM audit a
    LEFT JOIN users u ON u.id=a.user_id LEFT JOIN projects p ON p.id=a.project_id ORDER BY a.at DESC LIMIT 300`) });
}));
api.get('/admin/system', requireAdmin, wrap(async (req, res) => {
  res.json({ storage: store.storageKind.split(':')[0], jobs: await q(`SELECT status, count(*)::int AS n FROM jobs GROUP BY status`),
    last_backup: (await store.list('backups/')).map(o => o.key).sort().pop() || null,
    totals: await one(`SELECT (SELECT count(*) FROM projects)::int AS projects, (SELECT count(*) FROM model_versions)::int AS versions,
      (SELECT count(*) FROM drawings)::int AS drawings, (SELECT coalesce(sum(size),0) FROM model_versions)::bigint + (SELECT coalesce(sum(size),0) FROM drawings)::bigint AS bytes`) });
}));
api.post('/admin/backup', requireAdmin, wrap(async (req, res) => { res.json({ key: await backupDatabase() }); }));

registerFeatures(api);
registerDims(api);
registerLink(api);
registerLocal(api);

// ---------------------------------------------------------------- error monitoring
const clientErrors = new Map();     // per user, per hour: stop a looping page from flooding the log
api.post('/client-errors', json, wrap(async (req, res) => {
  const k = req.user.id + ':' + new Date().toISOString().slice(0, 13);
  const n = (clientErrors.get(k) || 0) + 1; clientErrors.set(k, n);
  if (clientErrors.size > 5000) clientErrors.clear();
  if (n <= 30) await recordError({ source: 'client', ref: req.ref, userId: req.user.id, message: clean(req.body?.message, 2000), stack: clean(req.body?.stack, 8000), url: clean(req.body?.url, 500),
    detail: { ua: clean(req.get('user-agent'), 200), host: clean(req.body?.host, 40), version: clean(req.body?.version, 40) } });
  res.json({ ok: true, ref: req.ref });
}));
api.get('/admin/errors', requireAdmin, wrap(async (req, res) => {
  res.json({
    errors: await q(`SELECT e.id, e.at, e.source, e.ref, e.message, e.stack, e.url, e.detail, u.email FROM errors e LEFT JOIN users u ON u.id=e.user_id ORDER BY e.at DESC LIMIT 200`),
    counts: await one(`SELECT count(*) FILTER (WHERE at > now() - interval '1 day')::int AS day, count(*) FILTER (WHERE at > now() - interval '7 days')::int AS week FROM errors`),
    failedJobs: await q(`SELECT j.id, j.kind, j.error, j.finished_at, j.attempts, j.payload FROM jobs j WHERE status='failed' ORDER BY j.id DESC LIMIT 50`),
  });
}));
api.delete('/admin/errors', requireAdmin, wrap(async (req, res) => { await q(`DELETE FROM errors`); await audit(req.user.id, null, 'admin.clear_errors'); res.json({ ok: true }); }));

// errors
api.use((err, req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'The file is larger than 500 MB.' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
  recordError({ source: 'server', ref: req.ref, userId: req.user?.id, message: `${req.method} ${req.path}: ${err?.message || err}`, stack: err?.stack });
  res.status(500).json({ error: `Something went wrong on the server (reference ${req.ref}). Try again; if it keeps happening, send the reference to your admin.` });
});
export { publicUser };
