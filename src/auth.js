// Users come from the APP_USERS Railway variable (one per line: email | name | role | hash).
// Passwords are scrypt hashes: "scrypt$<salt b64>$<hash b64>". Sessions are random tokens (stored hashed), 30 days.
import crypto from 'crypto';
import { q, one, audit } from './db.js';

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(password) {
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(password, stored) {
  const [kind, s, h] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(got, want);
}
/** Same check without blocking other requests (runs on the libuv thread pool). */
export function verifyPasswordAsync(password, stored) {
  const [kind, s, h] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !s || !h) return Promise.resolve(false);
  const want = Buffer.from(h, 'base64');
  return new Promise((resolve) => crypto.scrypt(String(password), Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 },
    (err, got) => resolve(!err && got.length === want.length && crypto.timingSafeEqual(got, want))));
}

export function parseUsers(text) {
  const users = [], problems = [];
  String(text || '').split(/\r?\n|;;/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).forEach((line, i) => {
    const [email, name, role, hash] = line.split('|').map(s => (s || '').trim());
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return problems.push(`line ${i + 1}: email is not valid`);
    if (!['admin', 'user'].includes((role || '').toLowerCase())) return problems.push(`line ${i + 1}: role must be admin or user`);
    if (!/^scrypt\$/.test(hash)) return problems.push(`line ${i + 1}: password hash missing (use npm run hash-password)`);
    users.push({ email: email.toLowerCase(), name: name || email, role: role.toLowerCase(), hash });
  });
  return { users, problems };
}

/** Make the users table match APP_USERS. Users not listed are disabled (their projects stay). */
export async function syncUsers(text = process.env.APP_USERS) {
  const { users, problems } = parseUsers(text);
  problems.forEach(p => console.warn('APP_USERS', p));
  for (const u of users) {
    const before = await one(`SELECT id, pw_hash, role FROM users WHERE email=$1`, [u.email]);
    await q(`INSERT INTO users (email, name, role, pw_hash, active) VALUES ($1,$2,$3,$4,TRUE)
             ON CONFLICT (email) DO UPDATE SET name=$2, role=$3, pw_hash=$4, active=TRUE`, [u.email, u.name, u.role, u.hash]);
    // a new password or a lower role signs the user out everywhere
    if (before && (before.pw_hash !== u.hash || (before.role === 'admin' && u.role !== 'admin'))) await q(`DELETE FROM sessions WHERE user_id=$1`, [before.id]);
  }
  const listed = users.map(u => u.email);
  const off = await q(`UPDATE users SET active=FALSE WHERE active AND NOT (email = ANY($1::text[])) RETURNING id`, [listed]);
  if (off.length) await q(`DELETE FROM sessions WHERE user_id = ANY($1::int[])`, [off.map(r => r.id)]);
  return { active: users.length, disabled: off.length, problems };
}

export async function login(email, password, userAgent) {
  const u = await one(`SELECT * FROM users WHERE email=$1`, [String(email || '').trim().toLowerCase()]);
  // same work whether or not the user exists, to avoid revealing which emails are valid
  const ok = u ? await verifyPasswordAsync(password, u.pw_hash) : (await verifyPasswordAsync(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), false);
  if (!u || !ok || !u.active) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  await q(`INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1,$2, now() + make_interval(days => $3), $4)`,
    [sha(token), u.id, SESSION_DAYS, String(userAgent || '').slice(0, 200)]);
  await q(`UPDATE users SET last_login=now() WHERE id=$1`, [u.id]);
  await q(`DELETE FROM sessions WHERE expires_at < now()`);
  await audit(u.id, null, 'login');
  return { token, user: publicUser(u) };
}
export const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

export async function logout(token) { if (token) await q(`DELETE FROM sessions WHERE token_hash=$1`, [sha(token)]); }

const bearer = (req) => (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;

/** Express middleware: requires a valid session; sets req.user. */
export async function requireUser(req, res, next) {
  try {
    const t = bearer(req);
    if (!t) return res.status(401).json({ error: 'Please sign in.' });
    const u = await one(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                         WHERE s.token_hash=$1 AND s.expires_at > now() AND u.active`, [sha(t)]);
    if (!u) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    req.user = publicUser(u); req.token = t; next();
  } catch (e) { next(e); }
}
export const requireAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only.' });
