// API routes for phases 2-5: saved views, templates, zones, project settings, revision compare,
// take-off update, audit PDF exports, QS knowledge base and the AI assistant.
import crypto from 'crypto';
import { q, one, audit } from './db.js';
import * as store from './storage.js';
import express from 'express';
import { json, wrap, clean, safeName, uuidOk, fail, need, versionProject, roleIn, HttpError } from './http.js';
import { requireAdmin } from './auth.js';
import { PACKS } from './packs.js';
import { loadModelData, overview } from './modeldata.js';
import { dataKey } from './processing.js';
import { compareModels } from './compare.js';
import { auditPdf } from './report.js';
import { aiConfig, runAgent, runSummaryPlan, runCheck, runDescribe, aiUsage, logAI, seedRules } from './ai.js';
import { enqueue } from './jobs.js';

const bigJson = express.json({ limit: '40mb' });

/** Insert or refresh the built-in discipline templates and default QS rules. */
export async function seedFeatures() {
  for (const t of PACKS) {
    await q(`INSERT INTO templates (scope, name, discipline, description, spec, builtin) VALUES ('global',$1,$2,$3,$4,true)
             ON CONFLICT (name) WHERE builtin DO UPDATE SET discipline=EXCLUDED.discipline, description=EXCLUDED.description, spec=EXCLUDED.spec, updated_at=now()`,
      [t.name, t.discipline, t.description, t.spec]);
  }
  await seedRules();
}

export async function templatesFor(user, projectId) {
  return q(`SELECT id, scope, project_id, owner_id, name, discipline, description, spec, builtin, created_at FROM templates
            WHERE builtin OR scope='company' OR (scope='user' AND owner_id=$1) OR (scope='project' AND project_id=$2)
            ORDER BY builtin DESC, discipline NULLS LAST, name`, [user.id, uuidOk(projectId) ? projectId : null]);
}

export function registerFeatures(api) {
  // ---------------------------------------------------------------- saved views
  api.get('/projects/:pid/views', wrap(async (req, res) => {
    await need(req, req.params.pid, 'viewer');
    res.json({ views: await q(`SELECT v.id, v.name, v.version_id, v.state, v.created_at, u.name AS created_by FROM views v LEFT JOIN users u ON u.id=v.created_by
                               WHERE project_id=$1 ORDER BY v.created_at DESC`, [req.params.pid]) });
  }));
  api.post('/projects/:pid/views', json, wrap(async (req, res) => {
    await need(req, req.params.pid, 'editor');
    const name = clean(req.body?.name, 120); if (!name) fail(400, 'Give the view a name.');
    const state = req.body?.state; if (!state || typeof state !== 'object') fail(400, 'View data is missing.');
    if (JSON.stringify(state).length > 2_000_000) fail(413, 'This view is too large to save. Clear some of the selection first.');
    const vid = uuidOk(req.body?.versionId) ? req.body.versionId : null;
    const v = await one(`INSERT INTO views (project_id, version_id, name, state, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, created_at`,
      [req.params.pid, vid, name, state, req.user.id]);
    await audit(req.user.id, req.params.pid, 'view.save', { name });
    res.status(201).json({ view: v });
  }));
  api.delete('/views/:id', wrap(async (req, res) => {
    if (!uuidOk(req.params.id)) fail(404, 'View not found.');
    const v = await one(`SELECT * FROM views WHERE id=$1`, [req.params.id]); if (!v) fail(404, 'View not found.');
    await need(req, v.project_id, 'editor');
    await q(`DELETE FROM views WHERE id=$1`, [v.id]);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- 2D sheets from the DWFx
  api.get('/versions/:vid/sheets/:n', wrap(async (req, res) => {
    const v = await versionProject(req.params.vid); if (!v) fail(404, 'Model version not found.');
    await need(req, v.project_id, 'viewer');
    const n = Number(req.params.n); if (!Number.isInteger(n) || n < 1) fail(404, 'Sheet not found.');
    const key = dataKey(v.storage_key, `sheets/sheet-${n}.svg.gz`);
    if (!(await store.exists(key))) fail(404, 'Sheet not found.');
    res.set({ 'Content-Type': 'image/svg+xml', 'Content-Encoding': 'gzip', 'Cache-Control': 'private, max-age=86400' });
    (await store.getStream(key)).pipe(res);
  }));

  // ---------------------------------------------------------------- templates (method library)
  api.get('/templates', wrap(async (req, res) => {
    const pid = req.query.projectId;
    if (pid && !(await roleIn(req.user, pid))) fail(404, 'Project not found, or you do not have access to it.');
    res.json({ templates: await templatesFor(req.user, pid) });
  }));
  api.post('/templates', json, wrap(async (req, res) => {
    const b = req.body || {};
    const name = clean(b.name, 120); if (!name) fail(400, 'Give the template a name.');
    const spec = b.spec; if (!spec || !Array.isArray(spec.inputs)) fail(400, 'Template method is missing.');
    const scope = ['user', 'project', 'company'].includes(b.scope) ? b.scope : 'user';
    if (scope === 'company' && req.user.role !== 'admin') fail(403, 'Only an admin can save company templates.');
    if (scope === 'project') await need(req, b.projectId, 'editor');
    delete spec.ids;
    const t = await one(`INSERT INTO templates (scope, project_id, owner_id, name, discipline, description, spec) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [scope, scope === 'project' ? b.projectId : null, req.user.id, name, clean(b.discipline, 40) || null, clean(b.description, 500) || null, spec]);
    if (scope === 'project') await audit(req.user.id, b.projectId, 'template.save', { name });
    res.status(201).json({ template: t });
  }));
  api.delete('/templates/:id', wrap(async (req, res) => {
    if (!uuidOk(req.params.id)) fail(404, 'Template not found.');
    const t = await one(`SELECT * FROM templates WHERE id=$1`, [req.params.id]); if (!t) fail(404, 'Template not found.');
    if (t.builtin) fail(400, 'Built-in templates cannot be deleted.');
    if (t.scope === 'project') await need(req, t.project_id, 'editor');
    else if (t.owner_id !== req.user.id && req.user.role !== 'admin') fail(403, 'You can only delete your own templates.');
    await q(`DELETE FROM templates WHERE id=$1`, [t.id]);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- zones
  api.get('/projects/:pid/zones', wrap(async (req, res) => {
    await need(req, req.params.pid, 'viewer');
    res.json({ zones: await q(`SELECT id, name, color, ids, created_at FROM zones WHERE project_id=$1 ORDER BY name`, [req.params.pid]) });
  }));
  api.post('/projects/:pid/zones', json, wrap(async (req, res) => {
    await need(req, req.params.pid, 'editor');
    const name = clean(req.body?.name, 80); if (!name) fail(400, 'Give the zone a name.');
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isFinite).slice(0, 500000);
    const color = /^#[0-9a-f]{6}$/i.test(req.body?.color) ? req.body.color : null;
    const z = await one(`INSERT INTO zones (project_id, name, color, ids, created_by) VALUES ($1,$2,$3,$4,$5)
                         ON CONFLICT (project_id, name) DO UPDATE SET ids=EXCLUDED.ids, color=COALESCE(EXCLUDED.color, zones.color) RETURNING id, name, color, ids`,
      [req.params.pid, name, color, JSON.stringify(ids), req.user.id]);
    await audit(req.user.id, req.params.pid, 'zone.save', { name, elements: ids.length });
    res.status(201).json({ zone: z });
  }));
  api.delete('/zones/:id', wrap(async (req, res) => {
    if (!uuidOk(req.params.id)) fail(404, 'Zone not found.');
    const z = await one(`SELECT * FROM zones WHERE id=$1`, [req.params.id]); if (!z) fail(404, 'Zone not found.');
    await need(req, z.project_id, 'editor');
    await q(`DELETE FROM zones WHERE id=$1`, [z.id]);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- project settings (AI off, measurement rules)
  api.patch('/projects/:pid/settings', json, wrap(async (req, res) => {
    await need(req, req.params.pid, 'owner');
    const b = req.body || {};
    const cur = (await one(`SELECT settings, ai_off FROM projects WHERE id=$1`, [req.params.pid]));
    const settings = { ...cur.settings };
    if (b.openingThreshold != null) { const v = Number(b.openingThreshold); if (!(v >= 0 && v <= 100)) fail(400, 'Opening threshold must be between 0 and 100 m².'); settings.openingThreshold = v; }
    if (b.houseStyle != null) settings.houseStyle = clean(b.houseStyle, 1000);
    const aiOff = typeof b.aiOff === 'boolean' ? b.aiOff : cur.ai_off;
    const p = await one(`UPDATE projects SET settings=$2, ai_off=$3, updated_at=now() WHERE id=$1 RETURNING id, settings, ai_off`, [req.params.pid, settings, aiOff]);
    await audit(req.user.id, req.params.pid, 'project.settings', { aiOff, ...settings });
    res.json({ project: p });
  }));

  // ---------------------------------------------------------------- QS setup: rule set and measuring assumptions (editors)
  api.patch('/projects/:pid/qs', json, wrap(async (req, res) => {
    await need(req, req.params.pid, 'editor');
    const b = req.body || {};
    const cur = await one(`SELECT settings FROM projects WHERE id=$1`, [req.params.pid]);
    const qs = { ...(cur.settings?.qs || {}) };
    const num = (k, lo, hi) => { if (b[k] === undefined) return; if (b[k] === null && k === 'groundLevel') { qs[k] = null; return; } const v = Number(b[k]); if (!Number.isFinite(v) || v < lo || v > hi) fail(400, `${k} must be between ${lo} and ${hi}.`); qs[k] = v; };
    if (b.ruleSet !== undefined) { if (!['NRM2', 'POMI', 'NRM1'].includes(b.ruleSet)) fail(400, 'Rule set must be NRM2, POMI or NRM1.'); qs.ruleSet = b.ruleSet; }
    num('groundLevel', -1000, 10000); num('wpUpturn', 0, 5); num('roofUpturn', 0, 5);
    for (const k of ['wpUnderGround', 'wpFoundationSides', 'wpRoof', 'earthFaced']) if (b[k] !== undefined) qs[k] = Boolean(b[k]);
    if (b.rates && typeof b.rates === 'object') {
      qs.rates = { ...(qs.rates || {}) };
      for (const [k, v] of Object.entries(b.rates)) {
        if (!/^[a-z]{2,20}$/.test(k)) continue;
        const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 1000) fail(400, `Reinforcement rate for ${k} must be between 0 and 1000 kg/m3.`);
        qs.rates[k] = n;
      }
    }
    const settings = { ...(cur.settings || {}), qs };
    await q(`UPDATE projects SET settings=$2, updated_at=now() WHERE id=$1`, [req.params.pid, settings]);
    await audit(req.user.id, req.params.pid, 'project.qs', qs);
    res.json({ qs });
  }));

  // ---------------------------------------------------------------- take-off update (new revision)
  api.patch('/takeoffs/:id', json, wrap(async (req, res) => {
    if (!uuidOk(req.params.id)) fail(404, 'Take-off not found.');
    const t = await one(`SELECT * FROM takeoffs WHERE id=$1`, [req.params.id]); if (!t) fail(404, 'Take-off not found.');
    await need(req, t.project_id, 'editor');
    const spec = req.body?.spec; if (!spec || !Array.isArray(spec.ids)) fail(400, 'Take-off data is missing.');
    const vid = uuidOk(req.body?.versionId) ? req.body.versionId : t.version_id;
    if (vid) { const v = await versionProject(vid); if (!v || v.project_id !== t.project_id) fail(400, 'Model version is not in this project.'); }
    await q(`UPDATE takeoffs SET spec=$2, name=$3, version_id=$4, updated_at=now() WHERE id=$1`, [t.id, spec, clean(spec.name, 200) || t.name, vid]);
    await audit(req.user.id, t.project_id, 'takeoff.update', { name: t.name, log: req.body?.log || null });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- revision compare
  api.get('/compare', wrap(async (req, res) => {
    const a = await versionProject(req.query.from), b = await versionProject(req.query.to);
    if (!a || !b) fail(404, 'Model version not found.');
    if (a.project_id !== b.project_id) fail(400, 'Both versions must be in the same project.');
    await need(req, a.project_id, 'viewer');
    if (a.status !== 'ready' || b.status !== 'ready') fail(409, 'Both versions must be processed (Ready) first.');
    const [da, db] = await Promise.all([loadModelData(a), loadModelData(b)]);
    const result = compareModels(da, db);
    await audit(req.user.id, a.project_id, 'model.compare', { from: `${a.model_name} v${a.version}`, to: `${b.model_name} v${b.version}`, ...result.summary });
    res.json({ from: { id: a.id, label: `${a.model_name} v${a.version}` }, to: { id: b.id, label: `${b.model_name} v${b.version}` }, ...result });
  }));

  // ---------------------------------------------------------------- exports (audit PDF)
  api.get('/projects/:pid/exports', wrap(async (req, res) => {
    await need(req, req.params.pid, 'viewer');
    res.json({ exports: await q(`SELECT x.id, x.kind, x.name, x.size, x.created_at, u.name AS created_by FROM exports x LEFT JOIN users u ON u.id=x.created_by
                                 WHERE project_id=$1 ORDER BY x.created_at DESC`, [req.params.pid]) });
  }));
  api.post('/projects/:pid/exports/audit', bigJson, wrap(async (req, res) => {
    await need(req, req.params.pid, 'viewer');
    const p = await one(`SELECT * FROM projects WHERE id=$1`, [req.params.pid]);
    const groups = Array.isArray(req.body?.groups) ? req.body.groups.slice(0, 300) : [];
    if (!groups.length) fail(400, 'There are no take-off groups to report.');
    const pdf = await auditPdf({ project: p, model: clean(req.body?.model, 200), user: req.user, groups, checks: (req.body?.checks || []).slice(0, 100).map(String) });
    const id = crypto.randomUUID();
    const name = `${safeName(p.name)}_takeoff_audit_${new Date().toISOString().slice(0, 10)}.pdf`;
    const key = `projects/${p.id}/exports/${id}.pdf`;
    await store.putBuffer(key, pdf, 'application/pdf');
    const x = await one(`INSERT INTO exports (id, project_id, kind, name, size, storage_key, created_by) VALUES ($1,$2,'audit_pdf',$3,$4,$5,$6) RETURNING id, name, size, created_at`,
      [id, p.id, name, pdf.length, key, req.user.id]);
    await audit(req.user.id, p.id, 'export.audit_pdf', { name, groups: groups.length });
    res.status(201).json({ export: x });
  }));
  api.get('/exports/:id/file', wrap(async (req, res) => {
    if (!uuidOk(req.params.id)) fail(404, 'Export not found.');
    const x = await one(`SELECT * FROM exports WHERE id=$1`, [req.params.id]); if (!x) fail(404, 'Export not found.');
    await need(req, x.project_id, 'viewer');
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${safeName(x.name)}"` });
    (await store.getStream(x.storage_key)).pipe(res);
  }));
  api.delete('/exports/:id', wrap(async (req, res) => {
    if (!uuidOk(req.params.id)) fail(404, 'Export not found.');
    const x = await one(`SELECT * FROM exports WHERE id=$1`, [req.params.id]); if (!x) fail(404, 'Export not found.');
    await need(req, x.project_id, 'editor');
    await store.removeKey(x.storage_key).catch(() => {});
    await q(`DELETE FROM exports WHERE id=$1`, [x.id]);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- QS knowledge base
  api.get('/kb', wrap(async (req, res) => {
    const pid = uuidOk(req.query.projectId) ? req.query.projectId : null;
    if (pid) await need(req, pid, 'viewer');
    res.json({ rules: await q(`SELECT r.id, r.scope, r.project_id, r.title, r.body, r.tags, r.updated_at, u.name AS created_by FROM kb_rules r LEFT JOIN users u ON u.id=r.created_by
                               WHERE r.scope='company' OR r.project_id=$1 ORDER BY r.scope, r.title`, [pid]) });
  }));
  api.post('/kb', json, wrap(async (req, res) => {
    const b = req.body || {};
    const title = clean(b.title, 160), body = clean(b.body, 4000);
    if (!title || !body) fail(400, 'Give the rule a title and text.');
    const scope = b.scope === 'project' ? 'project' : 'company';
    if (scope === 'company' && req.user.role !== 'admin') fail(403, 'Only an admin can add company rules. Add it to the project instead.');
    if (scope === 'project') await need(req, b.projectId, 'editor');
    const r = await one(`INSERT INTO kb_rules (scope, project_id, title, body, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [scope, scope === 'project' ? b.projectId : null, title, body, clean(b.tags, 300) || null, req.user.id]);
    res.status(201).json({ rule: r });
  }));
  api.patch('/kb/:id', json, wrap(async (req, res) => {
    const r = await editableRule(req);
    const b = req.body || {};
    const u = await one(`UPDATE kb_rules SET title=COALESCE($2,title), body=COALESCE($3,body), tags=COALESCE($4,tags), updated_at=now() WHERE id=$1 RETURNING *`,
      [r.id, clean(b.title, 160) || null, clean(b.body, 4000) || null, b.tags != null ? clean(b.tags, 300) : null]);
    res.json({ rule: u });
  }));
  api.delete('/kb/:id', wrap(async (req, res) => {
    const r = await editableRule(req);
    await q(`DELETE FROM kb_rules WHERE id=$1`, [r.id]);
    res.json({ ok: true });
  }));
  async function editableRule(req) {
    if (!uuidOk(req.params.id)) fail(404, 'Rule not found.');
    const r = await one(`SELECT * FROM kb_rules WHERE id=$1`, [req.params.id]); if (!r) fail(404, 'Rule not found.');
    if (r.scope === 'company' && req.user.role !== 'admin') fail(403, 'Only an admin can change company rules.');
    if (r.scope === 'project') await need(req, r.project_id, 'editor');
    return r;
  }

  // ---------------------------------------------------------------- AI
  const aiErr = (res, err) => res.status(err.status || 502).json({ error: err.message || 'The AI request failed.' });
  api.get('/ai/status', wrap(async (req, res) => {
    const c = await aiConfig();
    res.json({ enabled: c.enabled && Boolean(c.provider), provider: c.provider ? { id: c.provider.id, label: c.provider.label, model: c.provider.model } : null,
      dailyLimit: c.dailyLimit, usage: await aiUsage(req.user.id) });
  }));
  api.post('/ai', bigJson, wrap(async (req, res) => {
    const { request, versionId, ticked, summary } = req.body || {};
    if (!request) fail(400, 'Type what you want to measure.');
    try {
      if (uuidOk(versionId)) {
        const v = await versionProject(versionId); if (!v) fail(404, 'Model version not found.');
        await need(req, v.project_id, 'viewer');
        const data = await loadModelData(v);
        const templates = await templatesFor(req.user, v.project_id);
        await logAI(req.user, v.project_id, request);
        res.json(await runAgent({ user: req.user, projectId: v.project_id, request, data, ticked: Array.isArray(ticked) ? ticked.map(Number) : [], templates }));
      } else {
        if (!summary) fail(400, 'Missing model summary.');
        res.json(await runSummaryPlan({ user: req.user, request, summary }));
      }
    } catch (err) { if (err instanceof HttpError) throw err; aiErr(res, err); }
  }));
  api.post('/ai/check', bigJson, wrap(async (req, res) => {
    const { versionId, groups } = req.body || {};
    if (!Array.isArray(groups) || !groups.length) fail(400, 'There is nothing to check yet. Add take-off groups first.');
    let projectId = null, ov = null;
    if (uuidOk(versionId)) {
      const v = await versionProject(versionId); if (!v) fail(404, 'Model version not found.');
      await need(req, v.project_id, 'viewer'); projectId = v.project_id;
      ov = overview(await loadModelData(v), { maxTypes: 150 });
    }
    try { res.json(await runCheck({ user: req.user, projectId, groups: groups.slice(0, 200), overviewData: ov })); } catch (err) { aiErr(res, err); }
  }));
  api.post('/ai/describe', bigJson, wrap(async (req, res) => {
    const { projectId, items } = req.body || {};
    if (!Array.isArray(items) || !items.length) fail(400, 'There are no items to describe.');
    let style = req.body?.style;
    if (uuidOk(projectId)) { await need(req, projectId, 'viewer'); style ||= (await one(`SELECT settings FROM projects WHERE id=$1`, [projectId]))?.settings?.houseStyle; }
    try { res.json(await runDescribe({ user: req.user, projectId: uuidOk(projectId) ? projectId : null, items: items.slice(0, 300), style })); } catch (err) { aiErr(res, err); }
  }));

  // admin: provider switch, limits, evaluation
  api.get('/admin/ai', requireAdmin, wrap(async (req, res) => {
    const c = await aiConfig();
    const ev = (await one(`SELECT value FROM settings WHERE key='ai_eval'`))?.value || null;
    const usage = await q(`SELECT u.name, u.email, count(*)::int AS requests, coalesce(sum(a.tokens_in+a.tokens_out),0)::int AS tokens
                           FROM ai_usage a JOIN users u ON u.id=a.user_id WHERE a.at > now() - interval '30 days' GROUP BY u.name, u.email ORDER BY requests DESC`);
    res.json({ enabled: c.enabled, provider: c.provider?.id || null, model: c.provider?.model || null, dailyLimit: c.dailyLimit,
      providers: c.providers.map(p => ({ id: p.id, label: p.label, model: p.model })), evaluation: ev, usage });
  }));
  api.put('/admin/ai', requireAdmin, json, wrap(async (req, res) => {
    const b = req.body || {};
    const cur = (await one(`SELECT value FROM settings WHERE key='ai'`))?.value || {};
    const next = { ...cur };
    if (b.provider !== undefined) next.provider = clean(b.provider, 40) || null;
    if (b.model !== undefined) next.model = clean(b.model, 120) || null;
    if (b.dailyLimit !== undefined) { const n = Number(b.dailyLimit); if (!(n >= 1 && n <= 100000)) fail(400, 'Daily limit must be between 1 and 100000.'); next.dailyLimit = n; }
    if (b.enabled !== undefined) next.enabled = Boolean(b.enabled);
    await q(`INSERT INTO settings (key, value) VALUES ('ai',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [next]);
    await audit(req.user.id, null, 'admin.ai', next);
    res.json({ ok: true });
  }));
  api.post('/admin/ai/eval', requireAdmin, json, wrap(async (req, res) => {
    const v = await versionProject(req.body?.versionId);
    if (!v || v.status !== 'ready') fail(400, 'Choose a processed model version to test the AI on.');
    await q(`INSERT INTO settings (key, value) VALUES ('ai_eval',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [{ status: 'queued', versionId: v.id, model: `${v.model_name} v${v.version}`, startedAt: new Date().toISOString() }]);
    await enqueue('ai_eval', { versionId: v.id, userId: req.user.id });
    res.json({ ok: true });
  }));
}
