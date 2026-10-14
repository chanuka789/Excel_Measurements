// Link between the Excel task pane and the app window (a normal browser window that can be minimised and
// maximised). Office cannot message a browser window it did not open as a dialog, so both sides talk through the
// server: each side keeps one streaming GET open (server-sent events) and posts messages to the other side.
// Links live in memory on the API instance (one instance on Railway); a lost link is simply re-opened by the pane.
import crypto from 'crypto';
import { json, wrap, fail } from './http.js';
import { createSession, publicUser } from './auth.js';
import { one, audit } from './db.js';

const LINKS = new Map();                 // id -> { userId, created, claimCode, claimed, sides: {pane, win}, queue: {pane: [], win: []}, seen }
const IDLE_MS = 12 * 3600 * 1000, CLAIM_MS = 5 * 60 * 1000, QUEUE_MAX = 300, PER_USER = 6;
const other = (side) => (side === 'pane' ? 'win' : 'pane');
const okSide = (s) => (s === 'pane' || s === 'win' ? s : fail(400, 'side must be pane or win'));
setInterval(() => {
  const now = Date.now();
  for (const [id, l] of LINKS) if (now - l.seen > IDLE_MS && !l.sides.pane && !l.sides.win) LINKS.delete(id);
}, 10 * 60 * 1000).unref();

function getLink(req) {
  const l = LINKS.get(String(req.params.id || ''));
  if (!l || l.userId !== req.user.id) fail(404, 'This window link has ended. Open the app window again from the task pane.');
  l.seen = Date.now();
  return l;
}
function push(l, side, msg) {
  const res = l.sides[side];
  if (res) { res.write(`data: ${JSON.stringify(msg)}\n\n`); res.flush?.(); return true; }
  const q = l.queue[side]; q.push(msg); if (q.length > QUEUE_MAX) q.shift();
  return false;
}

/** Routes behind sign-in. */
export function registerLink(api) {
  api.post('/link', json, wrap(async (req, res) => {
    const mine = [...LINKS.entries()].filter(([, l]) => l.userId === req.user.id).sort((a, b) => a[1].created - b[1].created);
    while (mine.length >= PER_USER) { const [id, l] = mine.shift(); Object.values(l.sides).forEach(r => r?.end()); LINKS.delete(id); }
    const id = crypto.randomBytes(18).toString('base64url');
    const claimCode = crypto.randomBytes(24).toString('base64url');
    LINKS.set(id, { userId: req.user.id, created: Date.now(), seen: Date.now(), claimCode, claimed: false, sides: { pane: null, win: null }, queue: { pane: [], win: [] } });
    res.json({ id, claim: claimCode, expiresIn: CLAIM_MS / 1000 });
  }));
  // one streaming connection per side; a new connection replaces the old one
  api.get('/link/:id/stream', wrap(async (req, res) => {
    const l = getLink(req), side = okSide(req.query.side);
    l.sides[side]?.end();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders?.();
    l.sides[side] = res;
    res.write(`: linked\n\n`);
    push(l, other(side), { type: 'peer', side, online: true });
    const q = l.queue[side].splice(0); q.forEach(m => res.write(`data: ${JSON.stringify(m)}\n\n`));
    push(l, side, { type: 'peer', side: other(side), online: Boolean(l.sides[other(side)]) });
    const beat = setInterval(() => { res.write(': beat\n\n'); res.flush?.(); }, 20000);
    req.on('close', () => {
      clearInterval(beat);
      if (l.sides[side] === res) { l.sides[side] = null; if (LINKS.has(req.params.id)) push(l, other(side), { type: 'peer', side, online: false }); }
    });
  }));
  api.post('/link/:id/send', json, wrap(async (req, res) => {
    const l = getLink(req), side = okSide(req.body?.side);
    const msg = req.body?.msg;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') fail(400, 'Bad message.');
    res.json({ delivered: push(l, other(side), msg) });
  }));
  api.delete('/link/:id', wrap(async (req, res) => {
    const l = getLink(req);
    push(l, 'win', { type: 'closed' }); push(l, 'pane', { type: 'closed' });
    Object.values(l.sides).forEach(r => r?.end());
    LINKS.delete(req.params.id);
    res.json({ ok: true });
  }));
}

/**
 * Public route: the app window opens in the user's default browser, which has no session. The URL fragment holds the
 * link id and a one-time claim code (never sent to the server in the URL); the window posts them once, within five
 * minutes, and gets its own session for the same user.
 */
export function registerLinkClaim(app) {
  app.post('/api/link/claim', json, wrap(async (req, res) => {
    const l = LINKS.get(String(req.body?.id || ''));
    const code = String(req.body?.claim || '');
    const good = l && !l.claimed && Date.now() - l.created < CLAIM_MS && code.length === l.claimCode.length &&
      crypto.timingSafeEqual(Buffer.from(code), Buffer.from(l.claimCode));
    if (!good) return res.status(401).json({ error: 'This window link has expired. Open the app window again from the Excel task pane.' });
    l.claimed = true;
    const u = await one(`SELECT * FROM users WHERE id=$1 AND active`, [l.userId]);
    if (!u) return res.status(401).json({ error: 'Your account is not active.' });
    const token = await createSession(u.id, req.get('user-agent'), 1);
    await audit(u.id, null, 'link.window');
    res.json({ token, user: publicUser(u) });
  }));
}
export const _links = LINKS;           // tests
