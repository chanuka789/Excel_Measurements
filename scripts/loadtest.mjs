// Load test: N simulated users work at the same time for D seconds.
// Usage: BASE=http://localhost:3077 EMAIL=... PASSWORD=... USERS=25 SECONDS=60 node scripts/loadtest.mjs
// Each user signs in once, then repeats a realistic cycle: project list, project, model data, 3D geometry,
// templates, save a take-off group. Prints latency percentiles per request type, throughput and errors.
const BASE = (process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const USERS = Number(process.env.USERS || 25), SECONDS = Number(process.env.SECONDS || 60);
const stats = new Map(); let errors = 0, bytes = 0; const errSamples = [];
async function timed(name, fn) {
  const t0 = performance.now();
  try { const r = await fn(); if (!r.ok) { errors++; if (errSamples.length < 5) errSamples.push(`${name} ${r.status}`); } const b = await r.arrayBuffer(); bytes += b.byteLength; return r.ok ? b : null; }
  catch (e) { errors++; if (errSamples.length < 5) errSamples.push(`${name} ${e.message}`); return null; }
  finally { const ms = performance.now() - t0; if (!stats.has(name)) stats.set(name, []); stats.get(name).push(ms); }
}
const j = (b) => b ? JSON.parse(Buffer.from(b).toString()) : null;
async function user(i, until) {
  const login = j(await timed('login', () => fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.EMAIL, password: process.env.PASSWORD }) })));
  if (!login?.token) return;
  const H = { Authorization: 'Bearer ' + login.token, 'Accept-Encoding': 'gzip' };
  while (Date.now() < until) {
    const list = j(await timed('projects', () => fetch(BASE + '/api/projects', { headers: H })));
    const p = list?.projects?.[i % Math.max(list.projects.length, 1)]; if (!p) break;
    const d = j(await timed('project', () => fetch(BASE + '/api/projects/' + p.id, { headers: H })));
    const v = d?.models?.flatMap(m => m.versions).find(x => x.status === 'ready' && x.stats?.triangles != null);
    if (v) {
      await timed('model data', () => fetch(`${BASE}/api/versions/${v.id}/model`, { headers: H }));
      await timed('3D geometry', () => fetch(`${BASE}/api/versions/${v.id}/geometry`, { headers: H }));
      await timed('templates', () => fetch(`${BASE}/api/templates?projectId=${p.id}`, { headers: H }));
      await timed('save take-off', () => fetch(`${BASE}/api/projects/${p.id}/takeoffs`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: v.id, spec: { name: 'Load test ' + i, ids: [1, 2, 3], inputs: [{ key: 'n', source: 'count', sum: true }], constants: [], formulas: [] } }) }));
    }
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));      // think time
  }
}
const t0 = Date.now(), until = t0 + SECONDS * 1000;
await Promise.all(Array.from({ length: USERS }, (_, i) => user(i, until)));
const secs = (Date.now() - t0) / 1000;
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const rows = [...stats].map(([name, a]) => { a.sort((x, y) => x - y); return { request: name, count: a.length, p50_ms: Math.round(pct(a, 0.5)), p95_ms: Math.round(pct(a, 0.95)), p99_ms: Math.round(pct(a, 0.99)), max_ms: Math.round(a[a.length - 1]) }; });
const total = rows.reduce((s, r) => s + r.count, 0);
console.table(rows);
console.log(JSON.stringify({ users: USERS, seconds: Math.round(secs), requests: total, perSecond: Math.round(total / secs * 10) / 10, errors, errorRate: total ? +(errors / total * 100).toFixed(2) : 0, MB: Math.round(bytes / 1e6), errSamples }));
