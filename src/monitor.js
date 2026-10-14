// Error monitoring: request IDs, a server error log with reference numbers, browser error reports,
// and crash handlers. Errors are kept in Postgres (table "errors", last 90 days) and shown in Admin.
import crypto from 'crypto';
import { q } from './db.js';

export const newRef = () => crypto.randomBytes(4).toString('hex').toUpperCase();

/** Gives every request an ID (echoed in X-Request-Id) so a user's error message can be found in the logs. */
export function requestId(req, res, next) {
  req.ref = newRef();
  res.setHeader('X-Request-Id', req.ref);
  next();
}

export async function recordError({ source = 'server', ref = null, userId = null, message, stack = null, url = null, detail = null }) {
  const msg = String(message || 'Unknown error').slice(0, 2000);
  console.error(`[${source}${ref ? ' ' + ref : ''}] ${msg}${stack ? '\n' + String(stack).split('\n').slice(0, 6).join('\n') : ''}`);
  try {
    await q(`INSERT INTO errors (source, ref, user_id, message, stack, url, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [source, ref, userId, msg, stack ? String(stack).slice(0, 8000) : null, url ? String(url).slice(0, 500) : null, detail]);
  } catch { /* the database may be the problem; the console line above is enough */ }
}

export async function pruneErrors() { await q(`DELETE FROM errors WHERE at < now() - interval '90 days'`).catch(() => {}); }

/** Last-resort handlers: log, and for a real crash exit so Railway restarts the service cleanly. */
export function installCrashHandlers(name = 'server') {
  process.on('unhandledRejection', (reason) => { recordError({ source: name, message: 'Unhandled promise rejection: ' + (reason?.message || reason), stack: reason?.stack }); });
  process.on('uncaughtException', (err) => {
    recordError({ source: name, message: 'Crash: ' + err.message, stack: err.stack }).finally(() => setTimeout(() => process.exit(1), 500));
  });
}
