// Job worker: processes uploaded models and runs the daily backup.
// Runs inside the API by default (WORKER_IN_API=1) or as its own Railway service: `node worker.js`.
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, migrate, one } from './src/db.js';
import { claim, finish, fail, enqueue } from './src/jobs.js';
import http from 'http';
import { processVersion, backupDatabase, updateQs, QS_VERSION } from './src/processing.js';
import { recordError, installCrashHandlers } from './src/monitor.js';

const HANDLERS = {
  process_version: (p) => processVersion(p.versionId),
  backup: () => backupDatabase(),
  qs_update: (p) => updateQs(p.versionId),
  // the AI test set takes a while: run it in the background so model processing is never blocked
  ai_eval: async (p) => { const m = await import('./src/aieval.js'); m.runEvaluation(p).catch(e => console.error('AI evaluation failed:', e.message)); },
};
const MAX_ATTEMPTS = { ai_eval: 1 };
let running = false, timer = null;

async function tick() {
  const job = await claim();
  if (!job) return false;
  try { await HANDLERS[job.kind]?.(job.payload); await finish(job.id); }
  catch (e) { await recordError({ source: 'worker', ref: 'JOB' + job.id, message: `job ${job.id} (${job.kind}) failed: ${e.message}`, stack: e.stack, detail: job.payload }); await fail(job, e.message, MAX_ATTEMPTS[job.kind] || 3); }
  return true;
}
async function scheduleBackup() {
  const today = new Date().toISOString().slice(0, 10);
  const done = await one(`SELECT 1 FROM jobs WHERE kind='backup' AND created_at::date = $1::date`, [today]);
  if (!done) await enqueue('backup', { day: today });
}

/** Models processed before the QS face analysis get it added once, in the background. */
async function scheduleQsUpgrade() {
  const { q } = await import('./src/db.js');
  const todo = await q(`SELECT v.id FROM model_versions v WHERE v.status='ready' AND coalesce((v.stats->>'qs')::int, 0) < $1
                        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind='qs_update' AND j.payload->>'versionId' = v.id::text AND j.status IN ('queued','running'))`, [QS_VERSION]);
  for (const r of todo) await enqueue('qs_update', { versionId: r.id });
  if (todo.length) console.log(`QS analysis queued for ${todo.length} model version(s)`);
}

export function startWorker() {
  if (running) return; running = true;
  const loop = async () => {
    while (running) {
      try { if (!(await tick())) await new Promise(r => setTimeout(r, 1000)); }
      catch (e) { if (running) { console.error('worker error:', e.message); await new Promise(r => setTimeout(r, 5000)); } }
    }
  };
  loop();
  scheduleBackup().catch(() => {});
  scheduleQsUpgrade().catch(() => {});
  timer = setInterval(() => scheduleBackup().catch(() => {}), 60 * 60 * 1000);
  console.log('Worker started');
}
export const stopWorker = () => { running = false; if (timer) clearInterval(timer); timer = null; };

// Standalone worker service (Railway: start command `node worker.js`). It answers /health on PORT so the
// platform health check passes; it does not serve the add-in.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!pool) { console.error('DATABASE_URL is not set.'); process.exit(1); }
  installCrashHandlers('worker');
  let last = Date.now();
  setInterval(() => { last = Date.now(); }, 10000).unref();
  http.createServer(async (req, res) => {
    let db = false; try { db = Boolean(await one('SELECT 1 AS ok')); } catch { /* db down */ }
    const ok = db && running && Date.now() - last < 60000;
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok, role: 'worker', db, running }));
  }).listen(process.env.PORT || 3001, () => console.log('Worker health on port', process.env.PORT || 3001));
  migrate().then(startWorker).catch((e) => { console.error(e.message); process.exit(1); });
}
