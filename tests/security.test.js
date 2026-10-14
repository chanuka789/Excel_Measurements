// Security behaviour: login lockout, sign-out on password change, headers, API rate limit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/dwfx_test';
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'dwfx-store-'));
let base, srv, auth, db;
const post = (url, body, token) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });

before(async () => {
  process.env.DATABASE_URL = DB; process.env.LOCAL_STORAGE_DIR = STORE; process.env.WORKER_IN_API = '0';
  process.env.RATE_LIMIT_PER_MIN = '40'; process.env.CSP_MODE = 'enforce'; delete process.env.LOGIN_LIMIT_PER_IP;
  auth = await import('../src/auth.js'); db = await import('../src/db.js');
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  process.env.APP_USERS = `a@test.com | A | user | ${auth.hashPassword('First-pass-1')}\nb@test.com | B | user | ${auth.hashPassword('Second-pass-2')}\nc@test.com | C | admin | ${auth.hashPassword('Admin-pass-3')}`;
  srv = await (await import('../server.js')).start(0);
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => { srv?.closeAllConnections(); srv?.close(); await new Promise(r => setTimeout(r, 500)); await db.pool.end(); fs.rmSync(STORE, { recursive: true, force: true }); });

test('pages carry security headers and a content security policy', async () => {
  const r = await fetch(base + '/taskpane.html');
  const csp = r.headers.get('content-security-policy');
  assert.ok(csp.includes("object-src 'none'") && csp.includes('appsforoffice.microsoft.com') && /'sha256-/.test(csp));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});
test('ribbon icons can be cached and loaded by Excel on the web (Office hides icons sent with no-store)', async () => {
  const r = await fetch(base + '/assets/ribbon/projects-32.png?v=1');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/png/);
  assert.doesNotMatch(r.headers.get('cache-control') || '', /no-store|no-cache/);
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'cross-origin');
  const page = await fetch(base + '/taskpane.html');
  assert.match(page.headers.get('cache-control'), /no-store/);
  assert.equal(page.headers.get('cross-origin-resource-policy'), 'same-site');
});

test('an account is locked for 15 minutes after 8 wrong passwords, even with the right one', async () => {
  for (let i = 0; i < 8; i++) assert.equal((await post('/api/auth/login', { email: 'a@test.com', password: 'wrong-' + i })).status, 401);
  const r = await post('/api/auth/login', { email: 'a@test.com', password: 'First-pass-1' });
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /Too many sign-in attempts/);
});
test('changing a password in APP_USERS signs the user out everywhere', async () => {
  const t = (await (await post('/api/auth/login', { email: 'b@test.com', password: 'Second-pass-2' })).json()).token;
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + t } })).status, 200);
  await auth.syncUsers(`a@test.com | A | user | ${auth.hashPassword('First-pass-1')}\nb@test.com | B | user | ${auth.hashPassword('New-pass-333')}\nc@test.com | C | admin | ${auth.hashPassword('Admin-pass-3')}`);
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + t } })).status, 401);
});
test('browser errors are recorded with a reference and admins can read them', async () => {
  const user = (await (await post('/api/auth/login', { email: 'b@test.com', password: 'New-pass-333' })).json()).token;
  const admin = (await (await post('/api/auth/login', { email: 'c@test.com', password: 'Admin-pass-3' })).json()).token;
  const r = await (await post('/api/client-errors', { message: 'TypeError: x is undefined', stack: 'at y (model.js:1)', url: '/taskpane.html' }, user)).json();
  assert.match(r.ref, /^[0-9A-F]{8}$/);
  const list = await (await fetch(base + '/api/admin/errors', { headers: { Authorization: 'Bearer ' + admin } })).json();
  assert.ok(list.errors.some(e => e.ref === r.ref && e.source === 'client' && e.email === 'b@test.com'));
  assert.equal((await fetch(base + '/api/admin/errors', { headers: { Authorization: 'Bearer ' + user } })).status, 403);
  const bad = await fetch(base + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + user }, body: '{not json' });
  assert.equal(bad.status, 400);
});
test('the API rate limit answers 429 with Retry-After', async () => {
  const t = (await (await post('/api/auth/login', { email: 'b@test.com', password: 'New-pass-333' })).json()).token;
  let last;
  for (let i = 0; i < 45; i++) last = await fetch(base + '/api/projects', { headers: { Authorization: 'Bearer ' + t } });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
});
