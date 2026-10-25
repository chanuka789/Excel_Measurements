// API routes for the project tree: folders (drawings/models and dimension groups),
// dimension groups (with properties, custom quantities, variables, measured dimensions) and their BIM dimensions.
import { q, one, tx, audit } from './db.js';
import { json, wrap, clean, uuidOk, fail, need, versionProject } from './http.js';

export const MTYPES = ['Count', 'Length', 'Area', 'Volume'];
const KINDS = ['drawing', 'dim'];
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : d);
const isId = (v) => Number.isSafeInteger(Number(v)) && String(v).trim() !== '';

/** The measurement rule a quantity follows (set, key, reference, work section, NRM1 element...), bounded. */
function cleanRule(r) {
  if (!r || typeof r !== 'object') return undefined;
  const o = {};
  for (const k of ['set', 'key', 'ref', 'group', 'title', 'nrm1', 'band']) if (r[k] != null && r[k] !== '') o[k] = clean(r[k], 160);
  for (const k of ['confirm', 'allowance', 'info']) if (r[k]) o[k] = true;
  return o.set || o.ref ? o : undefined;
}
/** Keep only known, bounded fields of a dimension group's properties. */
export function cleanProps(p = {}, old = {}) {
  const src = { ...old, ...(p && typeof p === 'object' ? p : {}) };
  const list = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
  return {
    display: MTYPES.includes(src.display) ? src.display : undefined,
    quantity: clean(src.quantity, 120) || undefined,           // BIM property used for the measured value
    multiplier: num(src.multiplier, 1), width: num(src.width), height: num(src.height), offset: num(src.offset),
    gfa: Boolean(src.gfa), posColor: color(src.posColor, '#107c10'), negColor: color(src.negColor, '#d13438'),
    weightUom: clean(src.weightUom, 20), zone: clean(src.zone, 120) || undefined, description: clean(src.description, 500) || undefined,
    custom: list(src.custom, 50).map(c => ({ label: clean(c?.label, 120), unit: clean(c?.unit, 20), expr: clean(c?.expr, 1500), rule: cleanRule(c?.rule) })).filter(c => c.label && c.expr),
    rule: cleanRule(src.rule),
    variables: list(src.variables, 50).map(v => ({ name: clean(v?.name, 60), value: num(v?.value), unit: clean(v?.unit, 20) })).filter(v => v.name),
    measured: list(src.measured, 5000).map(m => ({ id: clean(m?.id, 40) || Math.random().toString(36).slice(2, 10), label: clean(m?.label, 200) || 'Measured dimension',
      value: num(m?.value), unit: clean(m?.unit, 20), kind: clean(m?.kind, 20) || 'manual', sign: num(m?.sign, 1) < 0 ? -1 : 1, multiplier: num(m?.multiplier, 1),
      at: clean(m?.at, 40) || new Date().toISOString(), ...cleanGeometry(m) })),
  };
}
export const SHAPES = ['area', 'length', 'count', 'distance', 'face', 'rebar'];
/** Where an on-screen dimension was taken and its points (bounded): src {t, key, page, name}, shape, pts, len, dmult. */
export function cleanGeometry(m) {
  const o = {};
  if (!m || typeof m !== 'object') return o;
  if (SHAPES.includes(m.shape)) o.shape = m.shape;
  const s = m.src;
  if (s && typeof s === 'object' && ['d', 's', '3d'].includes(s.t)) {
    o.src = { t: s.t, key: clean(s.key, 120), page: Math.max(1, Math.min(10000, Math.round(num(s.page, 1)))), name: clean(s.name, 200) || undefined };
    if (!o.src.key) delete o.src;
  }
  if (Array.isArray(m.pts)) {
    const pts = m.pts.slice(0, 3000).map(Number);
    if (pts.length && pts.every(Number.isFinite)) o.pts = pts.map(v => Math.round(v * 1e5) / 1e5);
  }
  if (Array.isArray(m.holes)) {                                  // cutouts of an area dimension
    const holes = m.holes.slice(0, 100).filter(h => Array.isArray(h) && h.length >= 6 && h.length <= 3000 && h.every(v => Number.isFinite(Number(v))))
      .map(h => h.map(v => Math.round(Number(v) * 1e5) / 1e5));
    if (holes.length && o.shape === 'area') o.holes = holes;
  }
  if (o.shape === 'rebar' && m.rebar && typeof m.rebar === 'object') o.rebar = { spacing: Math.max(0, num(m.rebar.spacing)), extra: num(m.rebar.extra), bars: Math.max(0, Math.round(num(m.rebar.bars))) };
  if (m.len != null && Number.isFinite(Number(m.len))) o.len = num(m.len);
  if (m.dmult != null && Number.isFinite(Number(m.dmult)) && Number(m.dmult) !== 1) o.dmult = num(m.dmult, 1);
  return o;
}
const outGroup = (g, items = []) => ({ id: g.id, project_id: g.project_id, folder_id: g.folder_id, name: g.name, mtype: g.mtype, props: g.props || {},
  standard: g.standard, created_at: g.created_at, updated_at: g.updated_at,
  items: items.map(i => ({ id: Number(i.id), element_id: Number(i.element_id), version_id: i.version_id, sign: i.sign, multiplier: i.multiplier })) });

async function groupFor(req, id, min) {
  if (!uuidOk(id)) fail(404, 'Dimension group not found.');
  const g = await one(`SELECT * FROM dim_groups WHERE id=$1`, [id]); if (!g) fail(404, 'Dimension group not found.');
  if (g.standard) { if (min !== 'viewer' && req.user.role !== 'admin' && g.created_by !== req.user.id) fail(403, 'Only an admin or the person who added it can change a standard group.'); }
  else await need(req, g.project_id, min);
  return g;
}
async function folderOk(projectId, folderId, kind) {
  if (folderId == null || folderId === '') return null;
  if (!uuidOk(folderId)) fail(400, 'Folder not found.');
  const f = await one(`SELECT * FROM folders WHERE id=$1`, [folderId]);
  if (!f || f.project_id !== projectId || f.kind !== kind) fail(400, 'Folder not found in this project.');
  return f.id;
}

export function registerDims(api) {
  // ---------------------------------------------------------------- folders
  api.get('/projects/:pid/tree', wrap(async (req, res) => {
    await need(req, req.params.pid, 'viewer');
    const pid = req.params.pid;
    const [folders, groups, items] = await Promise.all([
      q(`SELECT id, kind, parent_id, name, sort FROM folders WHERE project_id=$1 ORDER BY sort, name`, [pid]),
      q(`SELECT * FROM dim_groups WHERE project_id=$1 ORDER BY name`, [pid]),
      q(`SELECT i.* FROM dim_items i JOIN dim_groups g ON g.id=i.group_id WHERE g.project_id=$1 ORDER BY i.id`, [pid]),
    ]);
    const by = new Map(); items.forEach(i => { if (!by.has(i.group_id)) by.set(i.group_id, []); by.get(i.group_id).push(i); });
    res.json({ folders, groups: groups.map(g => outGroup(g, by.get(g.id))) });
  }));
  api.post('/projects/:pid/folders', json, wrap(async (req, res) => {
    await need(req, req.params.pid, 'editor');
    const kind = KINDS.includes(req.body?.kind) ? req.body.kind : fail(400, 'Folder type must be drawing or dim.');
    const name = clean(req.body?.name, 120) || fail(400, 'Give the folder a name.');
    const parent = await folderOk(req.params.pid, req.body?.parentId, kind);
    const n = await one(`SELECT count(*)::int AS n FROM folders WHERE project_id=$1`, [req.params.pid]);
    if (n.n >= 2000) fail(400, 'This project has too many folders.');
    const sort = Number.isInteger(req.body?.sort) && req.body.sort >= 0 && req.body.sort < 10000 ? req.body.sort : 0;
    const f = await one(`INSERT INTO folders (project_id, kind, parent_id, name, sort, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, kind, parent_id, name, sort`,
      [req.params.pid, kind, parent, name, sort, req.user.id]);
    await audit(req.user.id, req.params.pid, 'folder.create', { name, kind });
    res.status(201).json({ folder: f });
  }));
  api.patch('/folders/:id', json, wrap(async (req, res) => {
    if (!uuidOk(req.params.id)) fail(404, 'Folder not found.');
    const f = await one(`SELECT * FROM folders WHERE id=$1`, [req.params.id]); if (!f) fail(404, 'Folder not found.');
    await need(req, f.project_id, 'editor');
    const name = req.body?.name !== undefined ? (clean(req.body.name, 120) || fail(400, 'Give the folder a name.')) : f.name;
    let parent = f.parent_id;
    if (req.body?.parentId !== undefined) {
      parent = await folderOk(f.project_id, req.body.parentId, f.kind);
      // a folder cannot move inside itself or its own sub-folders
      for (let p = parent; p; p = (await one(`SELECT parent_id FROM folders WHERE id=$1`, [p]))?.parent_id) if (p === f.id) fail(400, 'A folder cannot be moved into itself.');
    }
    await q(`UPDATE folders SET name=$2, parent_id=$3 WHERE id=$1`, [f.id, name, parent]);
    res.json({ ok: true });
  }));
  api.delete('/folders/:id', wrap(async (req, res) => {
    if (!uuidOk(req.params.id)) fail(404, 'Folder not found.');
    const f = await one(`SELECT * FROM folders WHERE id=$1`, [req.params.id]); if (!f) fail(404, 'Folder not found.');
    await need(req, f.project_id, 'editor');
    // nothing is lost: sub-folders, drawings, models and dimension groups move up to the parent folder
    await tx(async (c) => {
      await c(`UPDATE folders SET parent_id=$2 WHERE parent_id=$1`, [f.id, f.parent_id]);
      await c(`UPDATE models SET folder_id=$2 WHERE folder_id=$1`, [f.id, f.parent_id]);
      await c(`UPDATE drawings SET folder_id=$2 WHERE folder_id=$1`, [f.id, f.parent_id]);
      await c(`UPDATE dim_groups SET folder_id=$2 WHERE folder_id=$1`, [f.id, f.parent_id]);
      await c(`DELETE FROM folders WHERE id=$1`, [f.id]);
    });
    await audit(req.user.id, f.project_id, 'folder.delete', { name: f.name });
    res.json({ ok: true });
  }));
  // move a model or drawing into a folder (null = top level)
  for (const [table, label] of [['models', 'Model'], ['drawings', 'Drawing']]) {
    api.patch(`/${table}/:id/folder`, json, wrap(async (req, res) => {
      if (!uuidOk(req.params.id)) fail(404, `${label} not found.`);
      const r = await one(`SELECT * FROM ${table} WHERE id=$1`, [req.params.id]); if (!r) fail(404, `${label} not found.`);
      await need(req, r.project_id, 'editor');
      const folder = await folderOk(r.project_id, req.body?.folderId, 'drawing');
      await q(`UPDATE ${table} SET folder_id=$2 WHERE id=$1`, [r.id, folder]);
      res.json({ ok: true });
    }));
  }

  // ---------------------------------------------------------------- dimension groups
  api.post('/projects/:pid/dimgroups', json, wrap(async (req, res) => {
    await need(req, req.params.pid, 'editor');
    const b = req.body || {};
    let base = { name: b.name, mtype: b.mtype, props: b.props };
    if (b.fromStandard) {
      const s = uuidOk(b.fromStandard) ? await one(`SELECT * FROM dim_groups WHERE id=$1 AND standard`, [b.fromStandard]) : null;
      if (!s) fail(404, 'Standard dimension group not found.');
      base = { name: b.name || s.name, mtype: s.mtype, props: { ...s.props, ...(b.props || {}) } };
    }
    const name = clean(base.name, 200) || fail(400, 'Give the dimension group a name.');
    const mtype = MTYPES.includes(base.mtype) ? base.mtype : 'Count';
    const folder = await folderOk(req.params.pid, b.folderId, 'dim');
    const n = await one(`SELECT count(*)::int AS n FROM dim_groups WHERE project_id=$1`, [req.params.pid]);
    if (n.n >= 5000) fail(400, 'This project has too many dimension groups.');
    const g = await one(`INSERT INTO dim_groups (project_id, folder_id, name, mtype, props, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.pid, folder, name, mtype, cleanProps(base.props), req.user.id]);
    await audit(req.user.id, req.params.pid, 'dimgroup.create', { name });
    res.status(201).json({ group: outGroup(g) });
  }));
  api.patch('/dimgroups/:id', json, wrap(async (req, res) => {
    const g = await groupFor(req, req.params.id, 'editor');
    const b = req.body || {};
    const name = b.name !== undefined ? (clean(b.name, 200) || fail(400, 'Give the dimension group a name.')) : g.name;
    const mtype = b.mtype !== undefined ? (MTYPES.includes(b.mtype) ? b.mtype : fail(400, 'Unknown measurement type.')) : g.mtype;
    const folder = b.folderId !== undefined && !g.standard ? await folderOk(g.project_id, b.folderId, 'dim') : g.folder_id;
    const props = b.props !== undefined ? cleanProps(b.props, g.props) : g.props;
    if (JSON.stringify(props).length > 3_000_000) fail(413, 'This dimension group is too large.');
    const u = await one(`UPDATE dim_groups SET name=$2, mtype=$3, folder_id=$4, props=$5, updated_at=now() WHERE id=$1 RETURNING *`, [g.id, name, mtype, folder, props]);
    res.json({ group: outGroup(u) });
  }));
  api.post('/dimgroups/:id/copy', json, wrap(async (req, res) => {
    const g = await groupFor(req, req.params.id, 'viewer');
    if (g.standard) fail(400, 'Use "Add Dimension Group" to add a standard group to a project.');
    await need(req, g.project_id, 'editor');
    const name = clean(req.body?.name, 200) || `${g.name} (copy)`;
    const folder = req.body?.folderId !== undefined ? await folderOk(g.project_id, req.body.folderId, 'dim') : g.folder_id;
    const props = { ...g.props }; if (!req.body?.withDimensions) props.measured = [];
    const c = await tx(async (cx) => {
      const n = (await cx(`INSERT INTO dim_groups (project_id, folder_id, name, mtype, props, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [g.project_id, folder, name, g.mtype, props, req.user.id]))[0];
      if (req.body?.withDimensions) await cx(`INSERT INTO dim_items (group_id, element_id, version_id, sign, multiplier, added_by)
        SELECT $2, element_id, version_id, sign, multiplier, $3 FROM dim_items WHERE group_id=$1`, [g.id, n.id, req.user.id]);
      return n;
    });
    const items = await q(`SELECT * FROM dim_items WHERE group_id=$1 ORDER BY id`, [c.id]);
    await audit(req.user.id, g.project_id, 'dimgroup.copy', { from: g.name, name });
    res.status(201).json({ group: outGroup(c, items) });
  }));
  api.delete('/dimgroups/:id', wrap(async (req, res) => {
    const g = await groupFor(req, req.params.id, 'editor');
    await q(`DELETE FROM dim_groups WHERE id=$1`, [g.id]);
    await audit(req.user.id, g.project_id, 'dimgroup.delete', { name: g.name });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- BIM dimensions (elements in a group)
  api.post('/dimgroups/:id/items', json, wrap(async (req, res) => {
    const g = await groupFor(req, req.params.id, 'editor');
    if (g.standard) fail(400, 'Standard groups hold no dimensions.');
    const ids = [...new Set((req.body?.ids || []).filter(isId).map(Number))];
    if (!ids.length) fail(400, 'No objects to import.');
    if (ids.length > 50000) fail(400, 'Import at most 50,000 objects at once.');
    let vid = null;
    if (req.body?.versionId) { const v = await versionProject(req.body.versionId); if (!v || v.project_id !== g.project_id) fail(400, 'Model version is not in this project.'); vid = v.id; }
    const sign = Number(req.body?.sign) < 0 ? -1 : 1;
    const r = await q(`INSERT INTO dim_items (group_id, element_id, version_id, sign, added_by)
                       SELECT $1, x, $3, $4, $5 FROM unnest($2::bigint[]) AS x ON CONFLICT (group_id, element_id) DO NOTHING RETURNING id`,
      [g.id, ids, vid, sign, req.user.id]);
    await q(`UPDATE dim_groups SET updated_at=now() WHERE id=$1`, [g.id]);
    await audit(req.user.id, g.project_id, 'dimgroup.import', { name: g.name, added: r.length });
    const items = await q(`SELECT * FROM dim_items WHERE group_id=$1 ORDER BY id`, [g.id]);
    res.json({ added: r.length, skipped: ids.length - r.length, group: outGroup(g, items) });
  }));
  api.patch('/dimgroups/:id/items', json, wrap(async (req, res) => {
    const g = await groupFor(req, req.params.id, 'editor');
    const ids = (req.body?.ids || []).filter(isId).map(Number);
    const sets = [], vals = [g.id, ids];
    if (req.body?.sign !== undefined) { vals.push(Number(req.body.sign) < 0 ? -1 : 1); sets.push(`sign=$${vals.length}`); }
    if (req.body?.multiplier !== undefined) { vals.push(num(req.body.multiplier, 1)); sets.push(`multiplier=$${vals.length}`); }
    if (!sets.length) fail(400, 'Nothing to change.');
    const where = ids.length ? 'AND element_id = ANY($2::bigint[])' : 'AND $2::bigint[] IS NOT NULL';
    await q(`UPDATE dim_items SET ${sets.join(', ')} WHERE group_id=$1 ${where}`, vals);
    await q(`UPDATE dim_groups SET updated_at=now() WHERE id=$1`, [g.id]);
    const items = await q(`SELECT * FROM dim_items WHERE group_id=$1 ORDER BY id`, [g.id]);
    res.json({ group: outGroup(g, items) });
  }));
  api.post('/dimgroups/:id/items/remove', json, wrap(async (req, res) => {
    const g = await groupFor(req, req.params.id, 'editor');
    const ids = (req.body?.ids || []).filter(isId).map(Number);
    const r = req.body?.all ? await q(`DELETE FROM dim_items WHERE group_id=$1 RETURNING id`, [g.id])
      : await q(`DELETE FROM dim_items WHERE group_id=$1 AND element_id = ANY($2::bigint[]) RETURNING id`, [g.id, ids]);
    await q(`UPDATE dim_groups SET updated_at=now() WHERE id=$1`, [g.id]);
    await audit(req.user.id, g.project_id, 'dimgroup.remove', { name: g.name, removed: r.length });
    const items = await q(`SELECT * FROM dim_items WHERE group_id=$1 ORDER BY id`, [g.id]);
    res.json({ removed: r.length, group: outGroup(g, items) });
  }));

  // ---------------------------------------------------------------- standard dimension groups (company library)
  api.get('/dimgroups/standard', wrap(async (req, res) => {
    res.json({ groups: (await q(`SELECT * FROM dim_groups WHERE standard ORDER BY name`)).map(g => outGroup(g)) });
  }));
  api.post('/dimgroups/:id/standard', json, wrap(async (req, res) => {
    const g = await groupFor(req, req.params.id, 'editor');
    if (g.standard) fail(400, 'This is already a standard group.');
    const name = clean(req.body?.name, 200) || g.name;
    const props = { ...g.props, measured: [] };
    const old = await one(`SELECT id FROM dim_groups WHERE standard AND lower(name)=lower($1)`, [name]);
    const s = old ? await one(`UPDATE dim_groups SET mtype=$2, props=$3, updated_at=now() WHERE id=$1 RETURNING *`, [old.id, g.mtype, props])
      : await one(`INSERT INTO dim_groups (project_id, name, mtype, props, standard, created_by) VALUES (NULL,$1,$2,$3,true,$4) RETURNING *`, [name, g.mtype, props, req.user.id]);
    await audit(req.user.id, g.project_id, 'dimgroup.standard', { name, replaced: Boolean(old) });
    res.status(old ? 200 : 201).json({ group: outGroup(s), replaced: Boolean(old) });
  }));

  // ---------------------------------------------------------------- drawing settings (scale, multiplier, markups)
  api.get('/projects/:pid/drawing-settings', wrap(async (req, res) => {
    await need(req, req.params.pid, 'viewer');
    const rows = await q(`SELECT dkey, props, updated_at FROM drawing_settings WHERE project_id=$1`, [req.params.pid]);
    res.json({ settings: Object.fromEntries(rows.map(r => [r.dkey, { ...r.props, updated_at: r.updated_at }])) });
  }));
  api.put('/projects/:pid/drawing-settings/:dkey', json, wrap(async (req, res) => {
    const pid = req.params.pid, dkey = req.params.dkey;
    await need(req, pid, 'editor');
    await drawingInProject(pid, dkey);
    const props = cleanDrawingSettings(req.body?.props);
    await q(`INSERT INTO drawing_settings (project_id, dkey, props, updated_by) VALUES ($1,$2,$3,$4)
             ON CONFLICT (project_id, dkey) DO UPDATE SET props=EXCLUDED.props, updated_by=EXCLUDED.updated_by, updated_at=now()`, [pid, dkey, props, req.user.id]);
    await audit(req.user.id, pid, 'drawing.settings', { dkey });
    res.json({ props });
  }));
}

/** d:<drawing id> for an uploaded drawing, s:<version id>:<sheet number> for a 2D sheet inside a DWFx. */
export const DKEY_RE = /^(d:[0-9a-f-]{36}|s:[0-9a-f-]{36}:\d{1,4})$/i;
async function drawingInProject(pid, dkey) {
  if (!DKEY_RE.test(dkey)) fail(400, 'Unknown drawing.');
  const [t, id] = dkey.split(':');
  const row = t === 'd' ? await one(`SELECT project_id FROM drawings WHERE id=$1`, [id]) : await versionProject(id);
  if (!row || row.project_id !== pid) fail(404, 'Drawing not found in this project.');
}
/** Per drawing: multiplier (typical floors), pages {n: {scale m per drawing unit, ratio, calibrated}}, markups. */
export function cleanDrawingSettings(p = {}) {
  const src = p && typeof p === 'object' ? p : {};
  const pages = {};
  for (const [k, v] of Object.entries(src.pages && typeof src.pages === 'object' ? src.pages : {}).slice(0, 2000)) {
    const n = Math.round(Number(k)); const scale = num(v?.scale, 0);
    const a = v?.area, area = a && ['x0', 'y0', 'x1', 'y1'].every(k => Number.isFinite(Number(a[k]))) && Number(a.x1) > Number(a.x0) && Number(a.y1) > Number(a.y0)
      ? { x0: num(a.x0), y0: num(a.y0), x1: num(a.x1), y1: num(a.y1) } : undefined;
    if (!(n >= 1 && n <= 10000) || !(scale >= 0 && scale < 1e6) || (!scale && !area)) continue;     // a page can keep a working area before it has a scale
    pages[n] = { scale, ratio: num(v?.ratio, 0) > 0 ? num(v.ratio) : undefined, calibrated: Boolean(v?.calibrated) || undefined, area };
  }
  const markups = (Array.isArray(src.markups) ? src.markups.slice(0, 1000) : []).map(m => ({
    id: clean(m?.id, 40) || Math.random().toString(36).slice(2, 10), page: Math.max(1, Math.round(num(m?.page, 1))),
    x: num(m?.x), y: num(m?.y), tx: num(m?.tx, num(m?.x)), ty: num(m?.ty, num(m?.y)), text: clean(m?.text, 500), size: Math.max(6, Math.min(96, num(m?.size, 12))),
    color: color(m?.color, '#c50f1f') })).filter(m => m.text);
  const mult = num(src.multiplier, 1);
  return { multiplier: mult > 0 && mult <= 100000 ? mult : 1, pages, markups };
}
