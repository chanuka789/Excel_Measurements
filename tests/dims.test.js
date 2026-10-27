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
  // CostX displays and fill patterns are kept; unknown ones are dropped
  r = await call('PATCH', `/api/dimgroups/${g.id}`, { token: T.user, body: { props: { display: 'Wall Area', posPattern: 'Cross Hatch', negPattern: '<b>' } } });
  assert.equal(r.data.group.props.display, 'Wall Area'); assert.equal(r.data.group.props.posPattern, 'Cross Hatch'); assert.equal(r.data.group.props.negPattern, undefined);
  r = await call('PATCH', `/api/dimgroups/${g.id}`, { token: T.user, body: { props: { display: 'Bogus' } } });
  assert.equal(r.data.group.props.display, undefined);
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

test('QS setup: editors set the assumptions; values are checked; no measurement-standard rule set is kept', async () => {
  let r = await call('PATCH', `/api/projects/${P.id}/qs`, { token: T.user, body: { ruleSet: 'POMI', groundLevel: 1.25, wpUpturn: 0.3, earthFaced: true, rates: { beam: 175, bad_key: 5 } } });
  assert.equal(r.status, 200); assert.equal(r.data.qs.ruleSet, undefined); assert.equal(r.data.qs.rates.beam, 175); assert.equal(r.data.qs.rates.bad_key, undefined);
  assert.equal((await call('PATCH', `/api/projects/${P.id}/qs`, { token: T.user, body: { rates: { beam: 5000 } } })).status, 400);
  assert.equal((await call('PATCH', `/api/projects/${P.id}/qs`, { token: T.other, body: { groundLevel: 2 } })).status, 403);
  r = await call('PATCH', `/api/projects/${P.id}/qs`, { token: T.user, body: { groundLevel: null } });
  assert.equal(r.data.qs.groundLevel, null);
  const p = (await call('GET', `/api/projects/${P.id}`, { token: T.other })).data.project;
  assert.equal(p.settings.qs.wpUpturn, 0.3);
});

test('drawing sets: named lists of drawings kept in the project settings (editors)', async () => {
  const k = 'd:' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12);
  let r = await call('PUT', `/api/projects/${P.id}/drawing-sets`, { token: T.user, body: { sets: [{ name: 'Level 1', keys: [k, k, 'bad'] }, { name: 'level 1', keys: [] }, { name: '' }] } });
  assert.equal(r.status, 200); assert.deepEqual(r.data.sets, [{ name: 'Level 1', keys: [k] }]);
  assert.equal((await call('PUT', `/api/projects/${P.id}/drawing-sets`, { token: T.user, body: { sets: 'x' } })).status, 400);
  assert.equal((await call('PUT', `/api/projects/${P.id}/drawing-sets`, { token: T.other, body: { sets: [] } })).status, 403);
  const p = (await call('GET', `/api/projects/${P.id}`, { token: T.user })).data.project;
  assert.deepEqual(p.settings.drawingSets, [{ name: 'Level 1', keys: [k] }]);
});

test('window link: one-time claim gives the app window its own session; messages go both ways through the server', async () => {
  const { id, claim } = (await call('POST', '/api/link', { token: T.user, body: {} })).data;
  assert.ok(id && claim);
  // a wrong code, then the right one (once only)
  assert.equal((await call('POST', '/api/link/claim', { body: { id, claim: 'x'.repeat(claim.length) } })).status, 401);
  const c = await call('POST', '/api/link/claim', { body: { id, claim } });
  assert.equal(c.status, 200); assert.equal(c.data.user.email, 'user@test.com');
  assert.equal((await call('POST', '/api/link/claim', { body: { id, claim } })).status, 401);
  const winToken = c.data.token;
  assert.notEqual(winToken, T.user);
  // another user cannot use the link
  assert.equal((await call('POST', `/api/link/${id}/send`, { token: T.other, body: { side: 'pane', msg: { type: 'x' } } })).status, 404);
  // the pane sends before the window listens: queued, then delivered when the window connects
  assert.equal((await call('POST', `/api/link/${id}/send`, { token: T.user, body: { side: 'pane', msg: { type: 'init', n: 1 } } })).data.delivered, false);
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/link/${id}/stream?side=win`, { headers: { Authorization: 'Bearer ' + winToken }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  const next = async (type) => {
    for (let k = 0; k < 20; k++) {
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const d = b.split('\n').find(l => l.startsWith('data: ')); if (d) { const m = JSON.parse(d.slice(6)); if (m.type === type) return m; } }
      const { value, done } = await reader.read(); if (done) return null; buf += dec.decode(value, { stream: true });
    }
    return null;
  };
  assert.equal((await next('init')).n, 1);
  assert.equal((await call('POST', `/api/link/${id}/send`, { token: T.user, body: { side: 'pane', msg: { type: 'state', n: 2 } } })).data.delivered, true);
  assert.equal((await next('state')).n, 2);
  assert.equal((await call('POST', `/api/link/${id}/send`, { token: T.user, body: { side: 'pane', msg: 'bad' } })).status, 400);
  assert.equal((await call('DELETE', `/api/link/${id}`, { token: T.user })).status, 200);
  assert.ok(await next('closed'));
  ctrl.abort();
  assert.equal((await call('POST', `/api/link/${id}/send`, { token: winToken, body: { side: 'win', msg: { type: 'x' } } })).status, 404);
});

test('on-screen take-off: drawing scale, multiplier and markups; measured dimensions keep their points', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData(); form.append('files', new Blob([png], { type: 'image/png' }), 'plan.png');
  const up = await call('POST', `/api/projects/${P.id}/drawings`, { token: T.user, form });
  assert.equal(up.status, 201);
  const d = up.data.drawings[0];
  const key = encodeURIComponent('d:' + d.id);
  const put = (props, token = T.user, pid = P.id, k = key) => call('PUT', `/api/projects/${pid}/drawing-settings/${k}`, { token, body: { props } });
  let r = await put({ multiplier: 10, pages: { 1: { scale: 0.05, ratio: 100 }, 2: { scale: -1 }, x: { scale: 1 } }, markups: [{ page: 1, x: 5, y: 6, text: 'Special tiles here', size: 500 }, { text: '' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data.props.pages), ['1']);                 // bad pages are dropped
  assert.equal(r.data.props.multiplier, 10);
  assert.equal(r.data.props.markups.length, 1); assert.equal(r.data.props.markups[0].size, 96);
  assert.equal((await put({}, T.other)).status, 403);                         // viewer
  assert.equal((await put({}, T.user, P2.id)).status, 404);                   // drawing of another project
  assert.equal((await put({}, T.user, P.id, 'nonsense')).status, 400);
  assert.equal((await put({}, T.user, P.id, encodeURIComponent(`s:${V1.id}:1`))).status, 200);   // a 2D sheet of a model in the project
  r = await call('GET', `/api/projects/${P.id}/drawing-settings`, { token: T.other });
  assert.equal(r.data.settings['d:' + d.id].pages[1].scale, 0.05);

  const g = (await call('POST', `/api/projects/${P.id}/dimgroups`, { token: T.user, body: { name: 'Floor tiles', mtype: 'Area' } })).data.group;
  const dim = { label: 'Area 0001', value: 12, unit: 'm2', kind: '2d', shape: 'area', pts: [0, 0, 10, 0, 10, 10, 'x'], len: 14, dmult: 10, src: { t: 'd', key: 'd:' + d.id, page: 1, name: 'plan.png' } };
  r = await call('PATCH', `/api/dimgroups/${g.id}`, { token: T.user, body: { props: { measured: [dim, { ...dim, pts: [0, 0, 1, 1], shape: 'blob', src: { t: 'zz', key: 'k' } }] } } });
  const [a, b] = r.data.group.props.measured;
  assert.equal(a.shape, 'area'); assert.equal(a.len, 14); assert.equal(a.dmult, 10); assert.equal(a.src.key, 'd:' + d.id);
  assert.equal(a.pts, undefined);                                             // a non-number point drops the points
  assert.deepEqual(b.pts, [0, 0, 1, 1]); assert.equal(b.shape, undefined); assert.equal(b.src, undefined);
});

test('one-time download links work once, for one path, for the user who asked', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData(); form.append('files', new Blob([png], { type: 'image/png' }), 'logo.png');
  const d = (await call('POST', `/api/projects/${P.id}/drawings`, { token: T.user, form })).data.drawings[0];
  const r = await call('POST', '/api/download-ticket', { token: T.user, body: { path: `/drawings/${d.id}/file` } });
  assert.equal(r.status, 200);
  const url = base + '/' + r.data.url;
  const first = await fetch(url); assert.equal(first.status, 200); assert.deepEqual(Buffer.from(await first.arrayBuffer()), png);
  assert.equal((await fetch(url)).status, 401);                               // used once
  const t2 = (await call('POST', '/api/download-ticket', { token: T.user, body: { path: `/drawings/${d.id}/file` } })).data.url;
  assert.equal((await fetch(base + '/' + t2.replace(`/drawings/${d.id}/file`, `/projects/${P.id}`))).status, 401);   // other path
  assert.equal((await call('POST', '/api/download-ticket', { token: T.user, body: { path: '../etc' } })).status, 400);
  assert.equal((await call('POST', '/api/download-ticket', { body: { path: '/x' } })).status, 401);
});

test('DWG / DXF drawings are converted on the server to a measurable SVG; unreadable files get a clear message', async () => {
  const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'Walls', '10', '0', '20', '0', '30', '0', '11', '5000', '21', '0', '31', '0',
    '0', 'CIRCLE', '8', 'Columns', '10', '2500', '20', '1000', '30', '0', '40', '200', '0', 'ENDSEC', '0', 'EOF'].join('\n');
  const form = new FormData();
  form.append('files', new Blob([dxf], { type: 'application/dxf' }), 'plan.dxf');
  form.append('files', new Blob([Buffer.from('AC1032 this is not really a drawing')], { type: 'application/acad' }), 'broken.dwg');
  const up = await call('POST', `/api/projects/${P.id}/drawings`, { token: T.user, form });
  assert.equal(up.status, 201);
  const [a, bad] = up.data.drawings;
  const r = await fetch(`${base}/api/drawings/${a.id}/cad`, { headers: { Authorization: 'Bearer ' + T.other } });   // viewers can read it
  assert.equal(r.status, 200);
  const svg = await r.text();
  assert.match(svg, /data-unit-m="0.001"/); assert.match(svg, /data-layer="Walls"/); assert.match(svg, /data-layer="Columns"/);
  assert.equal((await fetch(`${base}/api/drawings/${a.id}/cad`, { headers: { Authorization: 'Bearer ' + T.user } })).status, 200);   // second time from the cache
  const b = await call('GET', `/api/drawings/${bad.id}/cad`, { token: T.user });
  assert.equal(b.status, 422); assert.ok(b.data.error.length > 10);
  const png = (await call('GET', `/api/projects/${P.id}`, { token: T.user })).data.drawings.find(x => x.name === 'plan.png');
  if (png) assert.equal((await call('GET', `/api/drawings/${png.id}/cad`, { token: T.user })).status, 400);
});
