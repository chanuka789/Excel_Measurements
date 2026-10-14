// Small Postgres job queue (FOR UPDATE SKIP LOCKED): safe with several workers.
import { q, one } from './db.js';

export async function enqueue(kind, payload, delaySec = 0) {
  return one(`INSERT INTO jobs (kind, payload, run_after) VALUES ($1, $2, now() + make_interval(secs => $3)) RETURNING id`, [kind, payload, delaySec]);
}
/** Jobs whose worker died 3 times (for example out of memory) are not taken again: they fail with a clear message. */
export async function failDead(maxAttempts = 3) {
  return q(`UPDATE jobs SET status='failed', finished_at=now(), error='The processing stopped ' || attempts || ' times without finishing (the server may have run out of memory).'
            WHERE status='running' AND locked_at < now() - interval '3 minutes' AND attempts >= $1 RETURNING id, kind, payload`, [maxAttempts]);
}
export async function claim() {
  return one(`UPDATE jobs SET status='running', locked_at=now(), attempts=attempts+1
              WHERE id = (SELECT id FROM jobs WHERE (status='queued' AND run_after <= now())
                             OR (status='running' AND locked_at < now() - interval '3 minutes')
                          ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
              RETURNING *`);
}
/** A running job says it is alive every minute; a job silent for 3 minutes (worker restarted) is taken again. */
export async function heartbeat(id) { await q(`UPDATE jobs SET locked_at=now() WHERE id=$1 AND status='running'`, [id]); }
export async function finish(id) { await q(`UPDATE jobs SET status='done', finished_at=now(), error=NULL WHERE id=$1`, [id]); }
export async function fail(job, err, maxAttempts = 3) {
  const retry = job.attempts < maxAttempts;
  await q(`UPDATE jobs SET status=$2, error=$3, run_after=now() + make_interval(secs => $4), finished_at=CASE WHEN $2='failed' THEN now() END WHERE id=$1`,
    [job.id, retry ? 'queued' : 'failed', String(err).slice(0, 2000), 30 * job.attempts]);
  return retry;
}
