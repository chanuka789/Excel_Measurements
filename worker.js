// Job worker: processes uploaded models and runs the daily backup.
// Runs inside the API by default (WORKER_IN_API=1) or as its own Railway service: `node worker.js`.
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, migrate, one } from './src/db.js';
import { claim, finish, fail, enqueue } from './src/jobs.js';
import { processVersion, backupDatabase } from './src/processing.js';

const HANDLERS = {
  process_version: (p) => processVersion(p.versionId),
  backup: () => backupDatabase(),
};
let running = false, timer = null;

async function tick() {
  const job = await claim();
  if (!job) return false;
  try { await HANDLERS[job.kind]?.(job.payload); await finish(job.id); }
  catch (e) { console.error(`job ${job.id} (${job.kind}) failed:`, e.message); await fail(job, e.message); }
  return true;
}
async function scheduleBackup() {
  const today = new Date().toISOString().slice(0, 10);
  const done = await one(`SELECT 1 FROM jobs WHERE kind='backup' AND created_at::date = $1::date`, [today]);
  if (!done) await enqueue('backup', { day: today });
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
  timer = setInterval(() => scheduleBackup().catch(() => {}), 60 * 60 * 1000);
  console.log('Worker started');
}
export const stopWorker = () => { running = false; if (timer) clearInterval(timer); timer = null; };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!pool) { console.error('DATABASE_URL is not set.'); process.exit(1); }
  migrate().then(startWorker).catch((e) => { console.error(e.message); process.exit(1); });
}
