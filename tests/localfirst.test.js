// Files kept on the users' computers: the server stores names, fingerprints, summary numbers and measurements only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeDwfx } from './helpers.js';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/dwfx_test';
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'dwfx-store-'));
let base, srv, auth, db, T = {}, P;
const PW = { user: 'User-pass-22', other: 'Other-pass-333' };
const SHA = 'a'.repeat(64), SHA2 = 'b'.repeat(64);

async function call(method, url, { token, body, form } = {}) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  let payload;
  if (form) payload = form; else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : null };
}
const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).data.token;
const files = () => fs.readdirSync(STORE, { recursive: true }).filter(f => fs.statSync(path.join(STORE, f)).isFile());

before(async () => {
  process.env.DATABASE_URL = DB; process.env.LOCAL_STORAGE_DIR = STORE; process.env.WORKER_IN_API = '0'; process.env.BUNDLE = '0';
  delete process.env.AWS_ACCESS_KEY_ID; delete process.env.BUCKET; delete process.env.AI_API_KEY;
  auth = await import('../src/auth.js'); db = await import('../src/db.js');
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  process.env.APP_USERS = [`user@test.com | User | user | ${auth.hashPassword(PW.user)}`, `other@test.com | Other | user | ${auth.hashPassword(PW.other)}`].join('\n');
  srv = await (await import('../server.js')).start(0);
  base = `http://127.0.0.1:${srv.address().port}`;
  T.user = await login('user@test.com', PW.user); T.other = await login('other@test.com', PW.other);
  P = (await call('POST', '/api/projects', { token: T.user, body: { name: 'Local first' } })).data.project;
  await call('POST', `/api/projects/${P.id}/members`, { token: T.user, body: { email: 'other@test.com', role: 'editor' } });
});
after(async () => {
  srv?.closeAllConnections(); srv?.close();
  await new Promise(r => setTimeout(r, 500)); await db.pool.end();
  fs.rmSync(STORE, { recursive: true, force: true });
});

test('a model kept on the computer: registered without a file, finished with summary numbers only', async () => {
  const bad = await call('POST', `/api/projects/${P.id}/models/local`, { token: T.user, body: { fileName: 'tower.dwfx', size: 1000, sha256: 'nope' } });
  assert.equal(bad.status, 400);
  const r = await call('POST', `/api/projects/${P.id}/models/local`, { token: T.user, body: { fileName: 'tower.dwfx', size: 123456, sha256: SHA, modelName: 'Tower', note: 'IFC issue' } });
  assert.equal(r.status, 201);
  const v = r.data.version;
  assert.equal(v.location, 'local'); assert.equal(v.status, 'local'); assert.equal(v.sha256, SHA);
  // the server has no copy: model, geometry, source, sheets and server processing all say so
  for (const u of ['model', 'geometry', 'source', 'sheets/1']) assert.equal((await call('GET', `/api/versions/${v.id}/${u}`, { token: T.user })).status, 409, u);
  assert.equal((await call('POST', `/api/versions/${v.id}/server`, { token: T.user })).status, 409);
  assert.equal((await call('POST', `/api/versions/${v.id}/reprocess`, { token: T.user })).status, 409);
  // a teammate (editor) can send the heartbeat and finish it too
  assert.equal((await call('POST', `/api/versions/${v.id}/local`, { token: T.other, body: { progress: 'Reading' } })).data.status, 'local');
  const done = await call('POST', `/api/versions/${v.id}/local-ready`, { token: T.user, body: { elements: 812, categories: 9, triangles: 40000, ms: 5200, sheets: [{ index: 1, name: 'Plan', width: 841, height: 594 }], evil: '<script>' } });
  assert.equal(done.status, 200);
  assert.equal(done.data.stats.elements, 812); assert.equal(done.data.stats.processedOn, 'computer'); assert.equal(done.data.stats.evil, undefined);
  const meta = (await call('GET', `/api/versions/${v.id}`, { token: T.other })).data.version;
  assert.equal(meta.status, 'ready'); assert.equal(meta.location, 'local'); assert.equal(meta.sha256, SHA); assert.equal(meta.size, 123456);
  const p = (await call('GET', `/api/projects/${P.id}`, { token: T.other })).data;
  assert.equal(p.models[0].versions[0].location, 'local');
  assert.equal(files().length, 0, 'nothing stored on the server');
  // the AI needs the elements: without them it is refused, the server keeps none of them
  assert.equal((await call('POST', '/api/ai/check', { token: T.user, body: { versionId: v.id, groups: [{ name: 'x' }] } })).status, 409);
  const model = { elements: [{ id: 1, cat: 'Walls', fam: 'Basic Wall', type: 'W1', q: { Volume: [1, 'm³'] } }] };
  for (const [url, body] of [['/api/ai', { request: 'walls', versionId: v.id, model }], ['/api/ai/check', { versionId: v.id, groups: [{ name: 'x' }], model }]]) {
    const r = await call('POST', url, { token: T.user, body });
    assert.notEqual(r.status, 409, `${url} accepts the elements sent with the request`);         // (no AI key here, so it stops later)
  }
  // deleting works with no files to remove
  assert.equal((await call('DELETE', `/api/versions/${v.id}`, { token: T.user })).status, 200);
});

test('a failed run on the computer stays with the computers, never goes to the server', async () => {
  const v = (await call('POST', `/api/projects/${P.id}/models/local`, { token: T.user, body: { fileName: 'b.dwfx', size: 10, sha256: SHA2 } })).data.version;
  assert.equal((await call('POST', `/api/versions/${v.id}/local-failed`, { token: T.user, body: { reason: 'Out of memory' } })).data.status, 'failed');
  await db.q(`UPDATE model_versions SET status='local', local_seen=now() - interval '1 hour' WHERE id=$1`, [v.id]);
  await (await import('../src/localproc.js')).localTimeouts();
  const row = await db.one(`SELECT status, error FROM model_versions WHERE id=$1`, [v.id]);
  assert.equal(row.status, 'failed'); assert.match(row.error, /computer/);
  assert.equal((await db.q(`SELECT 1 FROM jobs WHERE payload->>'versionId'=$1`, [v.id])).length, 0);
  assert.equal((await call('POST', `/api/versions/${v.id}/local-again`, { token: T.other })).status, 200);
  assert.equal((await db.one(`SELECT status FROM model_versions WHERE id=$1`, [v.id])).status, 'local');
});

test('drawings kept on the computer: name, size and fingerprint only', async () => {
  const bad = await call('POST', `/api/projects/${P.id}/drawings/local`, { token: T.user, body: { files: [{ name: 'virus.exe', size: 1, sha256: SHA }] } });
  assert.equal(bad.status, 400);
  const r = await call('POST', `/api/projects/${P.id}/drawings/local`, { token: T.user, body: { files: [{ name: 'GA plan.pdf', size: 5000, type: 'application/pdf', sha256: SHA }, { name: 'site.dwg', size: 900, sha256: SHA2 }] } });
  assert.equal(r.status, 201); assert.equal(r.data.drawings.length, 2);
  const [pdf, dwg] = r.data.drawings;
  assert.equal(pdf.location, 'local');
  assert.equal((await call('GET', `/api/drawings/${pdf.id}/file`, { token: T.user })).status, 409);
  assert.equal((await call('GET', `/api/drawings/${dwg.id}/cad`, { token: T.user })).status, 409);
  const viewer = await call('POST', `/api/projects/${P.id}/drawings/local`, { token: T.other, body: { files: [{ name: 'a.pdf', size: 1, sha256: SHA }] } });
  assert.equal(viewer.status, 201, 'editors can add');
  const p = (await call('GET', `/api/projects/${P.id}`, { token: T.user })).data;
  assert.ok(p.drawings.every(d => d.location === 'local' && d.sha256));
  // measurements on it are stored as usual
  const g = (await call('POST', `/api/projects/${P.id}/dimgroups`, { token: T.user, body: { name: 'Slab', mtype: 'Area', props: {} } })).data.group;
  const m = { id: 'm1', label: 'Area 0001', value: 12, unit: 'm²', kind: '2d', sign: 1, multiplier: 1, shape: 'area', src: { t: 'd', key: `d:${pdf.id}`, page: 1, name: pdf.name }, pts: [[0, 0], [4, 0], [4, 3]] };
  assert.equal((await call('PATCH', `/api/dimgroups/${g.id}`, { token: T.user, body: { props: { measured: [m] } } })).status, 200);
  assert.equal((await call('DELETE', `/api/drawings/${pdf.id}`, { token: T.user })).status, 200);
  assert.equal(files().length, 0);
});

test('a DWG or DXF on the computer is converted for this request only', async () => {
  const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'Walls', '10', '0', '20', '0', '11', '1000', '21', '0', '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const form = new FormData(); form.append('file', new Blob([dxf]), 'plan.dxf');
  const r = await fetch(base + '/api/cad/convert', { method: 'POST', headers: { Authorization: 'Bearer ' + T.user }, body: form });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<svg/);
  assert.equal(files().length, 0, 'nothing kept');
  const bad = new FormData(); bad.append('file', new Blob(['x']), 'plan.pdf');
  assert.equal((await fetch(base + '/api/cad/convert', { method: 'POST', headers: { Authorization: 'Bearer ' + T.user }, body: bad })).status, 400);
});

test('owners can move a file stored on the server to the computers', async () => {
  const file = path.join(os.tmpdir(), 'lf.dwfx');
  await makeDwfx(file, [{ cat: 'Walls', fam: 'Basic Wall', type: 'W1', id: 5, level: 'L1', props: { Volume: '1 m³' } }]);
  const form = new FormData(); form.append('model', new Blob([fs.readFileSync(file)]), 'lf.dwfx');
  const v = (await call('POST', `/api/projects/${P.id}/models`, { token: T.user, form })).data.version;
  await db.q(`UPDATE model_versions SET status='ready' WHERE id=$1`, [v.id]);
  assert.ok(files().length > 0);
  assert.equal((await call('POST', `/api/versions/${v.id}/keep-local`, { token: T.other, body: { sha256: SHA } })).status, 403, 'editors cannot');
  assert.equal((await call('POST', `/api/versions/${v.id}/keep-local`, { token: T.user, body: { sha256: SHA } })).status, 200);
  assert.equal(files().length, 0);
  assert.equal((await call('GET', `/api/versions/${v.id}`, { token: T.user })).data.version.location, 'local');
  const fd = new FormData(); fd.append('files', new Blob(['%PDF-1.4']), 'x.pdf');
  const d = (await call('POST', `/api/projects/${P.id}/drawings`, { token: T.user, form: fd })).data.drawings[0];
  assert.equal((await call('POST', `/api/drawings/${d.id}/keep-local`, { token: T.user, body: { sha256: SHA2 } })).status, 200);
  assert.equal(files().length, 0);
});
