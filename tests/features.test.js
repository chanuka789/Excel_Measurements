// Integration tests for phases 2-5 routes: views, templates, zones, settings, compare, take-off update,
// audit PDF exports, QS rules, AI status and admin AI settings. Needs Postgres (TEST_DATABASE_URL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeDwfx } from './helpers.js';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/dwfx_test';
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'dwfx-store-'));
let base, srv, auth, db, T = {}, P, V1, V2;
const PW = { admin: 'Admin-pass-1', user: 'User-pass-22', other: 'Other-pass-333' };

async function call(method, url, { token, body, form } = {}) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  let payload;
  if (form) payload = form; else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), type: ct };
}
const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).data.token;
async function uploadVersion(token, pid, elements, name) {
  const file = path.join(os.tmpdir(), name); await makeDwfx(file, elements);
  const form = new FormData(); form.append('model', new Blob([fs.readFileSync(file)]), name); form.append('modelName', 'Structure');
  const up = await call('POST', `/api/projects/${pid}/models`, { token, form });
  for (let i = 0; i < 100; i++) {
    const r = await call('GET', `/api/versions/${up.data.version.id}`, { token });
    if (['ready', 'failed'].includes(r.data.version.status)) return r.data.version;
    await new Promise(res => setTimeout(res, 300));
  }
  throw new Error('processing timed out');
}
const E1 = [
  { cat: 'Structural Framing', fam: 'Beam', type: 'B-200X600', id: 1, level: 'Level 1', props: { 'Cut Length': '4000', Volume: '0.48 m³' } },
  { cat: 'Structural Framing', fam: 'Beam', type: 'B-200X600', id: 2, level: 'Level 1', props: { 'Cut Length': '5000', Volume: '0.60 m³' } },
  { cat: 'Structural Columns', fam: 'Column', type: 'C-300X300', id: 3, level: 'Level 1', props: { Volume: '0.27 m³' } },
];
const E2 = [E1[0], { ...E1[1], props: { 'Cut Length': '6000', Volume: '0.72 m³' } }, { cat: 'Floors', fam: 'Floor', type: 'Slab 200', id: 4, level: 'Level 2', props: { Area: '20 m²', Volume: '4.00 m³' } }];

before(async () => {
  process.env.DATABASE_URL = DB; process.env.LOCAL_STORAGE_DIR = STORE; process.env.WORKER_IN_API = '1';
  delete process.env.AWS_ACCESS_KEY_ID; delete process.env.BUCKET; delete process.env.AI_API_KEY; delete process.env.DEEPSEEK_API_KEY; delete process.env.OPENROUTER_API_KEY;
  auth = await import('../src/auth.js'); db = await import('../src/db.js');
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  process.env.APP_USERS = [`admin@test.com | Admin | admin | ${auth.hashPassword(PW.admin)}`, `user@test.com | User | user | ${auth.hashPassword(PW.user)}`,
    `other@test.com | Other | user | ${auth.hashPassword(PW.other)}`].join('\n');
  srv = await (await import('../server.js')).start(0);
  base = `http://127.0.0.1:${srv.address().port}`;
  T.admin = await login('admin@test.com', PW.admin); T.user = await login('user@test.com', PW.user); T.other = await login('other@test.com', PW.other);
  P = (await call('POST', '/api/projects', { token: T.user, body: { name: 'Features' } })).data.project;
  await call('POST', `/api/projects/${P.id}/members`, { token: T.user, body: { email: 'other@test.com', role: 'viewer' } });
  V1 = await uploadVersion(T.user, P.id, E1, 'v1.dwfx'); V2 = await uploadVersion(T.user, P.id, E2, 'v2.dwfx');
});
after(async () => {
  (await import('../worker.js')).stopWorker();
  srv?.closeAllConnections(); srv?.close();
  await new Promise(r => setTimeout(r, 1500)); await db.pool.end();
  fs.rmSync(STORE, { recursive: true, force: true });
});

test('discipline packs and default QS rules are seeded; templates save and delete', async () => {
  const t = (await call('GET', '/api/templates', { token: T.user })).data.templates;
  assert.ok(t.filter(x => x.builtin).length >= 20);
  assert.ok(['Structure', 'Architecture', 'Interiors', 'MEP'].every(d => t.some(x => x.discipline === d)));
  const spec = { name: 'My beams', filter: { category: ['Structural Framing'] }, inputs: [{ key: 'n', source: 'count', sum: true }], constants: [], formulas: [], ids: [1, 2] };
  const mine = await call('POST', '/api/templates', { token: T.user, body: { name: 'My beams', scope: 'user', spec } });
  assert.equal(mine.status, 201); assert.equal(mine.data.template.spec.ids, undefined);
  assert.ok(!(await call('GET', '/api/templates', { token: T.other })).data.templates.some(x => x.name === 'My beams'));
  assert.equal((await call('POST', '/api/templates', { token: T.user, body: { name: 'X', scope: 'company', spec } })).status, 403);
  assert.equal((await call('DELETE', `/api/templates/${t.find(x => x.builtin).id}`, { token: T.admin })).status, 400);
  assert.equal((await call('DELETE', `/api/templates/${mine.data.template.id}`, { token: T.user })).status, 200);
  const rules = (await call('GET', '/api/kb', { token: T.user })).data.rules;
  assert.ok(rules.length >= 8);
});
test('saved views and zones respect project roles', async () => {
  const v = await call('POST', `/api/projects/${P.id}/views`, { token: T.user, body: { name: 'Level 1', versionId: V1.id, state: { camera: {}, ticked: [1] } } });
  assert.equal(v.status, 201);
  assert.equal((await call('POST', `/api/projects/${P.id}/views`, { token: T.other, body: { name: 'x', state: {} } })).status, 403);
  assert.equal((await call('GET', `/api/projects/${P.id}/views`, { token: T.other })).data.views.length, 1);
  const z = await call('POST', `/api/projects/${P.id}/zones`, { token: T.user, body: { name: 'Block A', color: '#0078d4', ids: [1, 2] } });
  assert.equal(z.status, 201);
  const z2 = await call('POST', `/api/projects/${P.id}/zones`, { token: T.user, body: { name: 'Block A', ids: [1, 2, 3] } });
  assert.deepEqual(z2.data.zone.ids, [1, 2, 3]);                       // same name updates the zone
  assert.equal((await call('GET', `/api/projects/${P.id}/zones`, { token: T.other })).data.zones.length, 1);
  assert.equal((await call('DELETE', `/api/zones/${z.data.zone.id}`, { token: T.other })).status, 403);
});
test('revision compare and take-off update', async () => {
  const c = await call('GET', `/api/compare?from=${V1.id}&to=${V2.id}`, { token: T.other });
  assert.equal(c.status, 200);
  assert.deepEqual(c.data.summary, { added: 1, removed: 1, changed: 1, unchanged: 1 });
  assert.equal(c.data.changed[0].id, 2);
  const spec = { name: 'Beams', ids: [1, 2], inputs: [{ key: 'n', source: 'count', sum: true }], constants: [], formulas: [] };
  const t = (await call('POST', `/api/projects/${P.id}/takeoffs`, { token: T.user, body: { versionId: V1.id, spec } })).data.takeoff;
  assert.equal((await call('PATCH', `/api/takeoffs/${t.id}`, { token: T.user, body: { spec: { ...spec, ids: [1, 2, 4] }, versionId: V2.id, log: { added: 1 } } })).status, 200);
  const list = (await call('GET', `/api/projects/${P.id}/takeoffs`, { token: T.user })).data.takeoffs;
  assert.equal(list[0].version_id, V2.id); assert.deepEqual(list[0].spec.ids, [1, 2, 4]);
  assert.equal((await call('PATCH', `/api/takeoffs/${t.id}`, { token: T.other, body: { spec } })).status, 403);
});
test('processed model has exact-geometry fields and the 2D sheet route is safe', async () => {
  const m = (await call('GET', `/api/versions/${V1.id}/model`, { token: T.user })).data;
  assert.ok(m.geometryFormat === 'none' || m.geometryFormat === 'bin2');
  assert.equal((await call('GET', `/api/versions/${V1.id}/sheets/1`, { token: T.user })).status, 404);
  assert.equal((await call('GET', `/api/versions/${V1.id}/sheets/abc`, { token: T.user })).status, 404);
});
test('audit PDF export is stored for the project and can be downloaded and deleted', async () => {
  const groups = [{ ref: 'G1', name: 'Beams', count: 2, note: 'Count of beams', formulas: [], constants: [{ label: 'Slab', value: 0.2, unit: 'm' }], totals: [{ label: 'Count', unit: 'nr', value: 2 }] }];
  const x = await call('POST', `/api/projects/${P.id}/exports/audit`, { token: T.other, body: { model: 'Structure v1', groups } });
  assert.equal(x.status, 201);
  const f = await call('GET', `/api/exports/${x.data.export.id}/file`, { token: T.other });
  assert.equal(f.data.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await call('DELETE', `/api/exports/${x.data.export.id}`, { token: T.other })).status, 403);
  assert.equal((await call('DELETE', `/api/exports/${x.data.export.id}`, { token: T.user })).status, 200);
});
test('project settings, AI off switch and QS rules', async () => {
  assert.equal((await call('PATCH', `/api/projects/${P.id}/settings`, { token: T.other, body: { aiOff: true } })).status, 403);
  const s = await call('PATCH', `/api/projects/${P.id}/settings`, { token: T.user, body: { aiOff: true, openingThreshold: 0.6, houseStyle: 'NRM2' } });
  assert.equal(s.data.project.ai_off, true); assert.equal(s.data.project.settings.openingThreshold, 0.6);
  assert.equal((await call('PATCH', `/api/projects/${P.id}/settings`, { token: T.user, body: { openingThreshold: -1 } })).status, 400);
  assert.equal((await call('POST', '/api/kb', { token: T.user, body: { title: 'x', body: 'y', scope: 'company' } })).status, 403);
  const r = await call('POST', '/api/kb', { token: T.user, body: { title: 'Ground beams', body: 'Sides only', scope: 'project', projectId: P.id } });
  assert.equal(r.status, 201);
  assert.ok((await call('GET', `/api/kb?projectId=${P.id}`, { token: T.other })).data.rules.some(x => x.title === 'Ground beams'));
  assert.equal((await call('DELETE', `/api/kb/${r.data.rule.id}`, { token: T.other })).status, 403);
});
test('AI status and admin AI settings without a provider', async () => {
  const s = (await call('GET', '/api/ai/status', { token: T.user })).data;
  assert.equal(s.enabled, false);
  assert.equal((await call('POST', '/api/ai', { token: T.user, body: { request: 'beams', versionId: V1.id } })).status, 503);
  assert.equal((await call('GET', '/api/admin/ai', { token: T.user })).status, 403);
  assert.equal((await call('PUT', '/api/admin/ai', { token: T.admin, body: { dailyLimit: 50, enabled: true } })).status, 200);
  assert.equal((await call('GET', '/api/admin/ai', { token: T.admin })).data.dailyLimit, 50);
  assert.equal((await call('PUT', '/api/admin/ai', { token: T.admin, body: { dailyLimit: 0 } })).status, 400);
});
