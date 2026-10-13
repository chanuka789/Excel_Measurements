// Integration tests for Phase 1: users from APP_USERS, projects, sharing, storage, take-offs, export, delete.
// Needs Postgres: TEST_DATABASE_URL (default postgres://postgres@localhost:5433/dwfx_test).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeDwfx } from './helpers.js';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/dwfx_test';
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'dwfx-store-'));
let base, srv, mod, auth, db;
const PW = { admin: 'Admin-pass-1', user: 'User-pass-22', other: 'Other-pass-333' };

async function call(method, url, { token, body, form } = {}) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  let payload;
  if (form) payload = form; else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
}
const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).data.token;
const waitReady = async (token, vid) => {
  for (let i = 0; i < 100; i++) {
    const r = await call('GET', `/api/versions/${vid}`, { token });
    if (['ready', 'failed'].includes(r.data.version.status)) return r.data.version;
    await new Promise(res => setTimeout(res, 300));
  }
  throw new Error('processing timed out');
};

before(async () => {
  process.env.DATABASE_URL = DB; process.env.LOCAL_STORAGE_DIR = STORE; process.env.WORKER_IN_API = '1';
  delete process.env.AWS_ACCESS_KEY_ID; delete process.env.BUCKET;
  auth = await import('../src/auth.js');
  db = await import('../src/db.js');
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  process.env.APP_USERS = [
    `admin@test.com | Admin Person | admin | ${auth.hashPassword(PW.admin)}`,
    `user@test.com | Normal User | user | ${auth.hashPassword(PW.user)}`,
    `other@test.com | Other User | user | ${auth.hashPassword(PW.other)}`,
  ].join('\n');
  mod = await import('../server.js');
  srv = await mod.start(0);
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  (await import('../worker.js')).stopWorker();
  srv?.closeAllConnections(); srv?.close();
  await new Promise(r => setTimeout(r, 1500));
  await db.pool.end();
  fs.rmSync(STORE, { recursive: true, force: true });
});

test('sign-in works only with correct password and listed users', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'user@test.com', password: 'wrong-password' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'nobody@test.com', password: PW.user } })).status, 401);
  const t = await login('USER@test.com', PW.user);
  assert.ok(t);
  const me = await call('GET', '/api/auth/me', { token: t });
  assert.equal(me.data.user.email, 'user@test.com');
  assert.equal((await call('GET', '/api/projects')).status, 401);
});

test('users removed from APP_USERS are disabled and signed out; re-adding restores them', async () => {
  const t = await login('other@test.com', PW.other);
  const keep = process.env.APP_USERS;
  const r = await auth.syncUsers(keep.split('\n').filter(l => !l.startsWith('other@')).join('\n'));
  assert.equal(r.disabled, 1);
  assert.equal((await call('GET', '/api/auth/me', { token: t })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'other@test.com', password: PW.other } })).status, 401);
  await auth.syncUsers(keep);
  assert.ok(await login('other@test.com', PW.other));
});

test('full project flow: create, upload, process, share, take-off, drawings, export, delete', async () => {
  const user = await login('user@test.com', PW.user);
  const other = await login('other@test.com', PW.other);
  const admin = await login('admin@test.com', PW.admin);

  const p = (await call('POST', '/api/projects', { token: user, body: { name: 'Villa A', code: 'P-001', client: 'Test client' } })).data.project;
  assert.ok(p.id);
  // other user cannot see it yet
  assert.equal((await call('GET', `/api/projects/${p.id}`, { token: other })).status, 404);
  assert.equal((await call('GET', '/api/projects', { token: other })).data.projects.length, 0);
  // admin sees all
  assert.ok((await call('GET', '/api/projects', { token: admin })).data.projects.some(x => x.id === p.id));

  // upload a model version, processed by the worker
  const file = path.join(os.tmpdir(), 'test-model.dwfx'); await makeDwfx(file);
  const form = new FormData();
  form.append('model', new Blob([fs.readFileSync(file)]), 'Structure.dwfx'); form.append('modelName', 'Structure'); form.append('discipline', 'Structure');
  const up = await call('POST', `/api/projects/${p.id}/models`, { token: user, form });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const v = await waitReady(user, up.data.version.id);
  assert.equal(v.status, 'ready', v.error);
  assert.equal(v.stats.elements, 3);
  const data = await call('GET', `/api/versions/${v.id}/model`, { token: user });
  assert.equal(data.data.elements.length, 3);
  assert.equal(data.data.elements.find(e => e.id === 1001).q.Length[0], 5);

  // second upload with the same model name becomes version 2
  const form2 = new FormData(); form2.append('model', new Blob([fs.readFileSync(file)]), 'Structure_rev2.dwfx'); form2.append('modelName', 'Structure');
  const up2 = await call('POST', `/api/projects/${p.id}/models`, { token: user, form: form2 });
  assert.equal(up2.data.version.version, 2);

  // share as viewer: can read, cannot upload
  assert.equal((await call('POST', `/api/projects/${p.id}/members`, { token: user, body: { email: 'other@test.com', role: 'viewer' } })).status, 200);
  assert.equal((await call('GET', `/api/projects/${p.id}`, { token: other })).status, 200);
  const f3 = new FormData(); f3.append('model', new Blob([fs.readFileSync(file)]), 'x.dwfx');
  assert.equal((await call('POST', `/api/projects/${p.id}/models`, { token: other, form: f3 })).status, 403);
  // last owner cannot be removed
  const meId = (await call('GET', '/api/auth/me', { token: user })).data.user.id;
  assert.equal((await call('DELETE', `/api/projects/${p.id}/members/${meId}`, { token: user })).status, 400);

  // take-off saved and listed
  const spec = { name: 'Walls - Level 1', ids: [1001, 1002], by: 'type', note: '', inputs: [{ key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true }], constants: [], formulas: [] };
  assert.equal((await call('POST', `/api/projects/${p.id}/takeoffs`, { token: user, body: { versionId: v.id, spec } })).status, 201);
  assert.equal((await call('POST', `/api/projects/${p.id}/takeoffs`, { token: other, body: { versionId: v.id, spec } })).status, 403);
  assert.equal((await call('GET', `/api/projects/${p.id}/takeoffs`, { token: other })).data.takeoffs[0].spec.ids.length, 2);

  // drawings
  const fd = new FormData(); fd.append('files', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'A-101 Plan.pdf');
  const dr = await call('POST', `/api/projects/${p.id}/drawings`, { token: user, form: fd });
  assert.equal(dr.status, 201);
  const got = await call('GET', `/api/drawings/${dr.data.drawings[0].id}/file`, { token: other });
  assert.equal(got.data.toString(), '%PDF-1.4 test');
  const bad = new FormData(); bad.append('files', new Blob(['x']), 'virus.exe');
  assert.equal((await call('POST', `/api/projects/${p.id}/drawings`, { token: user, form: bad })).status, 400);

  // export zip contains project.json
  const ex = await call('GET', `/api/projects/${p.id}/export`, { token: user });
  assert.equal(ex.status, 200);
  assert.ok(ex.data.includes(Buffer.from('project.json')));

  // files exist in storage, then delete removes everything
  const files = () => { const out = []; const walk = d => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach(f => f.isDirectory() ? walk(path.join(d, f.name)) : out.push(f.name)); walk(path.join(STORE, 'projects', p.id)); return out; };
  assert.ok(files().includes('source.dwfx') && files().includes('model.json.gz'));
  assert.equal((await call('DELETE', `/api/projects/${p.id}`, { token: other, body: { confirm: 'Villa A' } })).status, 403);
  assert.equal((await call('DELETE', `/api/projects/${p.id}`, { token: user, body: { confirm: 'wrong' } })).status, 400);
  assert.equal((await call('DELETE', `/api/projects/${p.id}`, { token: user, body: { confirm: 'Villa A' } })).status, 200);
  assert.equal(files().length, 0);
  assert.equal((await call('GET', `/api/projects/${p.id}`, { token: user })).status, 404);
});

test('admin tools: users list, hash, audit, system, backup; normal users are refused', async () => {
  const admin = await login('admin@test.com', PW.admin);
  const user = await login('user@test.com', PW.user);
  assert.equal((await call('GET', '/api/admin/users', { token: user })).status, 403);
  const users = (await call('GET', '/api/admin/users', { token: admin })).data.users;
  assert.ok(users.length >= 3);
  const h = (await call('POST', '/api/admin/hash', { token: admin, body: { password: 'New-password-9' } })).data.hash;
  assert.ok(auth.verifyPassword('New-password-9', h));
  assert.equal((await call('POST', '/api/admin/hash', { token: admin, body: { password: 'short' } })).status, 400);
  assert.ok((await call('GET', '/api/admin/audit', { token: admin })).data.audit.some(a => a.action === 'project.delete'));
  const b = await call('POST', '/api/admin/backup', { token: admin });
  assert.match(b.data.key, /^backups\/\d{4}-\d{2}-\d{2}\.json\.gz$/);
  assert.equal((await call('GET', '/api/admin/system', { token: admin })).data.storage, 'local');
});
