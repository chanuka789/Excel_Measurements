// Security middleware: rate limits, login throttling, security headers (with a Content Security Policy).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ------------------------------------------------------------------ rate limiting (single instance, in memory)
const buckets = new Map();
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();
function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return { ok: b.n <= limit, retry: Math.ceil((b.reset - now) / 1000) };
}
export const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

/** General API limit per signed-in user (or IP before sign-in). */
export function apiLimit({ perMinute = Number(process.env.RATE_LIMIT_PER_MIN) || 600 } = {}) {
  return (req, res, next) => {
    const who = req.user ? 'u' + req.user.id : 'ip' + clientIp(req);
    const r = hit('api:' + who, perMinute, 60000);
    if (r.ok) return next();
    res.set('Retry-After', String(r.retry)).status(429).json({ error: `Too many requests. Wait ${r.retry} seconds and try again.` });
  };
}

/** Login throttling: per IP (20 tries / 15 min) and per email (8 failed tries / 15 min, then locked for 15 min). */
export function loginGuard(req, res, next) {
  const ip = hit('login-ip:' + clientIp(req), Number(process.env.LOGIN_LIMIT_PER_IP) || 20, 15 * 60000);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const fails = buckets.get('login-fail:' + email);
  if (!ip.ok || (fails && fails.n >= 8 && fails.reset > Date.now())) {
    const retry = !ip.ok ? ip.retry : Math.ceil((fails.reset - Date.now()) / 1000);
    return res.set('Retry-After', String(retry)).status(429).json({ error: `Too many sign-in attempts. Try again in ${Math.ceil(retry / 60)} minute(s).` });
  }
  next();
}
export const loginFailed = (email) => hit('login-fail:' + String(email || '').trim().toLowerCase(), 1e9, 15 * 60000);
export const loginSucceeded = (email) => buckets.delete('login-fail:' + String(email || '').trim().toLowerCase());
export const resetLimits = () => buckets.clear();

// ------------------------------------------------------------------ security headers
/** sha256 hashes of inline <script> blocks (the import maps), so the CSP can allow exactly those. */
function inlineHashes(publicDir) {
  const out = new Set();
  for (const f of fs.readdirSync(publicDir).filter(n => n.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(publicDir, f), 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) out.add(`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  }
  return [...out];
}
/**
 * CSP_MODE = enforce (default) | report | off. Office pages run inside Microsoft's own frames, so framing is
 * not restricted; scripts come only from this server and Microsoft's Office.js host.
 */
export function securityHeaders(publicDir) {
  const mode = (process.env.CSP_MODE || 'enforce').toLowerCase();
  const ms = 'https://appsforoffice.microsoft.com https://*.microsoft.com https://*.office.com https://*.office.net https://*.officeapps.live.com https://*.live.com https://*.msocdn.com';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-eval' ${inlineHashes(publicDir).join(' ')} ${ms}`,
    `style-src 'self' 'unsafe-inline' ${ms}`,
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${ms}`,
    "worker-src 'self' blob:",
    `frame-src 'self' ${ms} https://*.oaspapps.com`,                  // Office telemetry frame
    "font-src 'self' data: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  return (req, res, next) => {
    // Office only shows ribbon icons that can be cached ("must support caching", no no-cache/no-store),
    // and Excel on the web loads them from Microsoft's own site, so /assets/ is cacheable and cross-origin.
    const assets = req.path.startsWith('/assets/');
    res.setHeader('Cache-Control', assets || req.path.startsWith('/vendor/') || req.path.startsWith('/help/media/') ? 'public, max-age=86400' : 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    res.setHeader('Cross-Origin-Resource-Policy', assets ? 'cross-origin' : 'same-site');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (mode === 'enforce') res.setHeader('Content-Security-Policy', csp);
    else if (mode === 'report') res.setHeader('Content-Security-Policy-Report-Only', csp);
    next();
  };
}
