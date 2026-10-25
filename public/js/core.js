// Shared helpers for the task pane modules: API client, session, small DOM helpers, app registry.
export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const App = {};             // modules register functions here (selectTab, openVersion, addToExcel, ...)

const KEY = 'dwfxSession';
let memory = null;                 // the app window keeps its own session in memory, so it never replaces the pane's
export const session = {
  get() { if (memory) return memory.v; try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } },
  set(v) { if (memory) { memory.v = v; return; } try { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); } catch { /* storage blocked */ } },
  useMemory(v) { memory = { v }; },
};

export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export async function api(method, url, body, { raw = false } = {}) {
  const s = session.get();
  const headers = s?.token ? { Authorization: 'Bearer ' + s.token } : {};
  let payload = body;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try { res = await fetch('api' + url, { method, headers, body: payload }); }
  catch { throw new ApiError(0, 'Cannot reach the server. Check your internet connection and try again.'); }
  if (res.status === 401 && url !== '/auth/login') { session.set(null); App.onSignedOut?.(); }
  if (raw && res.ok) return res;
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : {};
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status}).`);
  return data;
}

/** Upload with progress (fetch has no upload progress). onProgress(0..1). */
export function upload(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', 'api' + url);
    const s = session.get(); if (s?.token) x.setRequestHeader('Authorization', 'Bearer ' + s.token);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let data = {}; try { data = JSON.parse(x.responseText); } catch { /* not json */ }
      if (x.status === 401) { session.set(null); App.onSignedOut?.(); }
      x.status >= 200 && x.status < 300 ? resolve(data) : reject(new ApiError(x.status, data.error || `Upload failed (${x.status}).`));
    };
    x.onerror = () => reject(new ApiError(0, 'Upload failed: the connection was lost.'));
    x.send(form);
  });
}

/** Save a file from an authenticated URL. In Excel desktop, browser downloads are unreliable, so we fall back to a link. */
export async function downloadFile(url, fileName) {
  const O = typeof Office !== 'undefined' ? Office : null;
  const desktop = O?.context?.platform && O.context.platform !== O.PlatformType?.OfficeOnline && O.context.ui?.openBrowserWindow;
  if (desktop) {
    // Excel desktop's web view does not save downloads: open a one-time link in the user's browser instead
    const r = await api('POST', '/download-ticket', { path: url });
    O.context.ui.openBrowserWindow(new URL(r.url, location.href).href);
    return;
  }
  const res = await api('GET', url, null, { raw: true });
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = fileName; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

export const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
export const fmtDate = (d) => d ? new Date(d).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
export const fmtDay = (d) => d ? new Date(d).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '';

/** Toast-style status line at the bottom of the pane. kind: '' | 'ok' | 'warn' | 'bad'.
 * Plain and success messages clear themselves after a while; warnings and errors stay until replaced. */
let statusTimer = 0;
export function status(msg, kind = '') {
  const el = $('status'); if (!el) return;
  el.textContent = msg; el.className = kind;
  clearTimeout(statusTimer);
  if (msg && kind !== 'bad' && kind !== 'warn') statusTimer = setTimeout(() => { if (el.textContent === msg) { el.textContent = ''; el.className = ''; } }, 10000);
}

/** In-pane confirmation (Office add-ins cannot use window.confirm). Resolves true/false. */
export function confirmBox({ title, body, confirmLabel = 'Confirm', danger = false, typeToConfirm = '' }) {
  return new Promise((resolve) => {
    const d = $('dialog');
    d.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">
      <h2 id="dlgTitle">${esc(title)}</h2><div class="dlg-body">${body}</div>
      ${typeToConfirm ? `<label class="field">Type <strong>${esc(typeToConfirm)}</strong> to confirm<input id="dlgType" type="text" autocomplete="off"></label>` : ''}
      <div class="dlg-actions"><button id="dlgNo" class="btn">Cancel</button><button id="dlgYes" class="btn ${danger ? 'danger' : 'primary'}" ${typeToConfirm ? 'disabled' : ''}>${esc(confirmLabel)}</button></div></div>`;
    d.hidden = false;
    const back = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); return; }
      if (e.key !== 'Tab') return;
      const f = [...d.querySelectorAll('button:not(:disabled), input, select, textarea, a[href]')];       // keep Tab inside the dialog
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    const done = (v) => { document.removeEventListener('keydown', onKey, true); d.hidden = true; d.innerHTML = ''; try { back?.focus?.(); } catch { /* gone */ } resolve(v); };
    $('dlgNo').onclick = () => done(false);
    $('dlgYes').onclick = () => done(typeToConfirm ? $('dlgType').value : true);
    if (typeToConfirm) $('dlgType').oninput = (e) => { $('dlgYes').disabled = e.target.value !== typeToConfirm; };
    document.addEventListener('keydown', onKey, true);
    ($('dlgType') || $('dlgNo')).focus();
  });
}

/** Report unexpected browser errors to the server (Admin > Errors), at most a few per page load. */
const reported = new Map();
export function reportError(message, stack = '') {
  const msg = String(message || '').slice(0, 1000);
  if (!msg || /^Script error\.?$/i.test(msg) || /ResizeObserver loop/i.test(msg)) return;
  const n = (reported.get(msg) || 0) + 1; reported.set(msg, n);
  if (n > 2 || reported.size > 20) return;
  const s = session.get(); if (!s?.token) return;
  fetch('api/client-errors', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.token },
    body: JSON.stringify({ message: msg, stack: String(stack || '').slice(0, 6000), url: location.pathname, host: typeof Office !== 'undefined' && Office.context?.host || 'browser', version: '0.6' }) }).catch(() => {});
}
window.addEventListener('error', (e) => reportError(e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => reportError('Unhandled: ' + (e.reason?.message || e.reason), e.reason?.stack));
