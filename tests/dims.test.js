// Integration tests for the project tree: folders, dimension groups, dimensions and standard groups.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeDwfx } from './helpers.js';

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/dwfx_test';
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'dwfx-store-'));
let base, srv, auth, db, T = {}, P, P2, V1;
const PW = { admin: 'Admin-pass-1', user: 'User-pass-22', other: 'Other-pass-333' };

async function call(method, url, { token, body, form } = {}) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  let payload;
  if (form) payload = form; else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + url, { method, headers, body: payload });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json() : null };
}
const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).data.token;
const E1 = [
  { cat: 'Structural Framing', fam: 'Beam', type: 'B-200X600', id: 11, level: 'Level 1', props: { 'Cut Length': '4000', Volume: '0.48 m³' } },
  { cat: 'Structural Framing', fam: 'Beam', type: 'B-200X600', id: 12, level: 'Level 1', props: { 'Cut Length': '5000', Volume: '0.60 m³' } },
  { cat: 'Structural Columns', fam: 'Column', type: 'C-300X300', id: 13, level: 'Level 1', props: { Volume: '0.27 m³' } },
];

before(async () => {
  process.env.DATABASE_URL = DB; process.env.LOCAL_STORAGE_DIR = STORE; process.env.WORKER_IN_API = '1';
  delete process.env.AWS_ACCESS_KEY_ID; delete process.env.BUCKET; delete process.env.AI_API_KEY;
  auth = await import('../src/auth.js'); db = await import('../src/db.js');
  await db.q('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  process.env.APP_USERS = [`admin@test.com | Admin | admin | ${auth.hashPassword(PW.admin)}`, `user@test.com | User | user | ${auth.hashPassword(PW.user)}`,
    `other@test.com | Other | user | ${auth.hashPassword(PW.other)}`].join('\n');
  srv = await (await import('../server.js')).start(0);
  base = `http://127.0.0.1:${srv.address().port}`;
  T.admin = await login('admin@test.com', PW.admin); T.user = await login('user@test.com', PW.user); T.other = await login('other@test.com', PW.other);
  P = (await call('POST', '/api/projects', { token: T.user, body: { name: 'Tree' } })).data.project;
  P2 = (await call('POST', '/api/projects', { token: T.user, body: { name: 'Other project' } })).data.project;
  await call('POST', `/api/projects/${P.id}/members`, { token: T.user, body: { email: 'other@test.com', role: 'viewer' } });
  const file = path.join(os.tmpdir(), 'tree.dwfx'); await makeDwfx(file, E1);
  const form = new FormData(); form.append('model', new Blob([fs.readFileSync(file)]), 'tree.dwfx'); form.append('modelName', 'Structure');
  V1 = (await call('POST', `/api/projects/${P.id}/models`, { token: T.user, form })).data.version;
});
after(async () => {
  (await import('../worker.js')).stopWorker();
  srv?.closeAllConnections(); srv?.close();
  await new Promise(r => setTimeout(r, 1500)); await db.pool.end();
  fs.rmSync(STORE, { recursive: true, force: true });
});

test('folders: create, nest, rename, move models and drawings in, delete keeps the contents', async () => {
  const mk = (body, token = T.user) => call('POST', `/api/projects/${P.id}/folders`, { token, body });
  const a = (await mk({ kind: 'drawing', name: 'Landscape' })).data.folder;
  const b = (await mk({ kind: 'drawing', name: 'Sections', parentId: a.id })).data.folder;
  assert.equal(b.parent_id, a.id);
  assert.equal((await mk({ kind: 'drawing', name: 'X' }, T.other)).status, 403);            // viewer
  assert.equal((await mk({ kind: 'nope', name: 'X' })).status, 400);
  const dimF = (await mk({ kind: 'dim', name: 'SD 100%' })).data.folder;
  assert.equal((await mk({ kind: 'drawing', name: 'X', parentId: dimF.id })).status, 400);  // wrong kind as parent
  assert.equal((await call('PATCH', `/api/folders/${a.id}`, { token: T.user, body: { parentId: b.id } })).status, 400); // into own child
  assert.equal((await call('PATCH', `/api/folders/${b.id}`, { token: T.user, body: { name: 'Hardscape sections' } })).status, 200);
  // drawing uploaded straight into a folder, model moved into a folder
  const form = new FormData(); form.append('files', new Blob(['%PDF-1.4 test']), 'LS-HTD-4001.pdf'); form.append('folderId', b.id);
  const d = (await call('POST', `/api/projects/${P.id}/drawings`, { token: T.user, form })).data.drawings[0];
  const proj = (await call('GET', `/api/projects/${P.id}`, { token: T.user })).data;
  assert.equal(proj.drawings.find(x => x.id === d.id).folder_id, b.id);
  const model = proj.models[0];
  assert.equal((await call('PATCH', `/api/models/${model.id}/folder`, { token: T.user, body: { folderId: a.id } })).status, 200);
  assert.equal((await call('PATCH', `/api/models/${model.id}/folder`, { token: T.user, body: { folderId: dimF.id } })).status, 400);
  // deleting "Sections" moves its drawing up to "Landscape"
  assert.equal((await call('DELETE', `/api/folders/${b.id}`, { token: T.user })).status, 200);
  const after = (await call('GET', `/api/projects/${P.id}`, { token: T.user })).data;
  assert.equal(after.drawings.find(x => x.id === d.id).folder_id, a.id);
  assert.equal(after.models[0].folder_id, a.id);
  const tree = (await call('GET', `/api/projects/${P.id}/tree`, { token: T.other })).data;   // viewers can read
  assert.deepEqual(tree.folders.map(f => f.name).sort(), ['Landscape', 'SD 100%']);
});

test('dimension groups: properties, import objects, signs and multipliers, copy, delete', async () => {
  const f = (await call('POST', `/api/projects/${P.id}/folders`, { token: T.user, body: { kind: 'dim', name: 'Irrigation' } })).data.folder;
  const props = { display: 'Length', multiplier: 2, width: 0.3, height: 0.5, offset: 0.1, posColor: '#107c10', negColor: '#ff0000', weightUom: 'kg',
    custom: [{ label: 'Formwork', unit: 'm2', expr: '{Length} * 2' }], variables: [{ name: 'Waste', value: 1.05, unit: '' }], evil: '<script>' };
  const g = (await call('POST', `/api/projects/${P.id}/dimgroups`, { token: T.user, body: { name: 'IR Ducts', mtype: 'Length', folderId: f.id, props } })).data.group;
  assert.equal(g.mtype, 'Length'); assert.equal(g.folder_id, f.id); assert.equal(g.props.multiplier, 2); assert.equal(g.props.evil, undefined);
  assert.equal(g.props.custom.length, 1); assert.equal(g.props.variables[0].value, 1.05);
  assert.equal((await call('POST', `/api/projects/${P.id}/dimgroups`, { token: T.other, body: { name: 'X' } })).status, 403);
  assert.equal((await call('POST', `/api/projects/${P2.id}/dimgroups`, { token: T.user, body: { name: 'X', folderId: f.id } })).status, 400); // folder of another project
  // import objects (duplicates are skipped), make one negative, change multiplier
  let r = await call('POST', `/api/dimgroups/${g.id}/items`, { token: T.user, body: { ids: [11, 12, 12, 'x'], versionId: V1.id } });
  assert.equal(r.data.added, 2); assert.equal(r.data.group.items.length, 2);
  r = await call('POST', `/api/dimgroups/${g.id}/items`, { token: T.user, body: { ids: [12, 13], versionId: V1.id } });
  assert.equal(r.data.added, 1); assert.equal(r.data.skipped, 1);
  assert.equal((await call('POST', `/api/dimgroups/${g.id}/items`, { token: T.user, body: { ids: [1], versionId: '00000000-0000-0000-0000-000000000000' } })).status, 400);
  r = await call('PATCH', `/api/dimgroups/${g.id}/items`, { token: T.user, body: { ids: [13], sign: -1, multiplier: 3 } });
  const i13 = r.data.group.items.find(i => i.element_id === 13);
  assert.equal(i13.sign, -1); assert.equal(i13.multiplier, 3);
  // measured (manual) dimensions live in the properties
  r = await call('PATCH', `/api/dimgroups/${g.id}`, { token: T.user, body: { props: { measured: [{ label: 'Distance on site', value: 12.5, unit: 'm', kind: 'distance' }] } } });
  assert.equal(r.data.group.props.measured[0].value, 12.5); assert.equal(r.data.group.props.multiplier, 2);   // other properties kept
  assert.equal((await call('PATCH', `/api/dimgroups/${g.id}`, { token: T.user, body: { mtype: 'Weird' } })).status, 400);
  // copy with and without dimensions
  const c1 = (await call('POST', `/api/dimgroups/${g.id}/copy`, { token: T.user, body: { name: 'IR Ducts B', withDimensions: true } })).data.group;
  assert.equal(c1.items.length, 3); assert.equal(c1.props.measured.length, 1);
  const c2 = (await call('POST', `/api/dimgroups/${g.id}/copy`, { token: T.user, body: {} })).data.group;
  assert.equal(c2.items.length, 0); assert.equal(c2.props.measured.length, 0); assert.equal(c2.name, 'IR Ducts (copy)');
  // remove dimensions, delete group
  r = await call('POST', `/api/dimgroups/${g.id}/items/remove`, { token: T.user, body: { ids: [11] } });
  assert.equal(r.data.removed, 1); assert.equal(r.data.group.items.length, 2);
  assert.equal((await call('DELETE', `/api/dimgroups/${c2.id}`, { token: T.other })).status, 403);
  assert.equal((await call('DELETE', `/api/dimgroups/${c2.id}`, { token: T.user })).status, 200);
  const tree = (await call('GET', `/api/projects/${P.id}/tree`, { token: T.user })).data;
  assert.equal(tree.groups.find(x => x.id === g.id).items.length, 2);
  assert.ok(!tree.groups.some(x => x.id === c2.id));
  // deleting the folder keeps the groups (moved to the top level)
  await call('DELETE', `/api/folders/${f.id}`, { token: T.user });
  const t2 = (await call('GET', `/api/projects/${P.id}/tree`, { token: T.user })).data;
  assert.equal(t2.groups.find(x => x.id === g.id).folder_id, null);
});

test('standard dimension groups: add from a project, reuse in another project', async () => {
  const g = (await call('POST', `/api/projects/${P.id}/dimgroups`, { token: T.user, body: { name: 'Concrete to beams', mtype: 'Volume', props: { quantity: 'Geo volume', measured: [{ label: 'x', value: 1 }] } } })).data.group;
  await call('POST', `/api/dimgroups/${g.id}/items`, { token: T.user, body: { ids: [11] } });
  const s = await call('POST', `/api/dimgroups/${g.id}/standard`, { token: T.user, body: {} });
  assert.equal(s.status, 201); assert.equal(s.data.group.standard, true); assert.equal(s.data.group.props.measured.length, 0);
  assert.equal((await call('POST', `/api/dimgroups/${g.id}/standard`, { token: T.user, body: {} })).data.replaced, true);  // same name updates it
  const list = (await call('GET', '/api/dimgroups/standard', { token: T.other })).data.groups;
  assert.equal(list.length, 1);
  const n = (await call('POST', `/api/projects/${P2.id}/dimgroups`, { token: T.user, body: { fromStandard: list[0].id } })).data.group;
  assert.equal(n.name, 'Concrete to beams'); assert.equal(n.mtype, 'Volume'); assert.equal(n.props.quantity, 'Geo volume');
  assert.equal((await call('POST', `/api/dimgroups/${list[0].id}/items`, { token: T.user, body: { ids: [1] } })).status, 400);
  assert.equal((await call('DELETE', `/api/dimgroups/${list[0].id}`, { token: T.other })).status, 403);
  assert.equal((await call('DELETE', `/api/dimgroups/${list[0].id}`, { token: T.admin })).status, 200);
});
