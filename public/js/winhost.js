// The task pane side of the two app windows: the measurement window (viewer.html, CostX style) and the DWFx
// Schedules window (schedules.html). Three ways to open them: an Office dialog (Excel), a browser pop-up (add-in
// opened in a browser), or the app window: a normal browser window with real minimise / maximise, linked to this
// pane through the server (LinkChannel). Only one Office dialog can be open at a time, so the second window opens as an
// app window. Messages from a window go to the handlers registered with onWindow().
import { App, api, session, status } from './core.js';
import { LinkChannel } from './link.js';

const PAGES = { measure: 'viewer.html', schedules: 'schedules.html' };
const NAMES = { measure: 'measurement window', schedules: 'DWFx Schedules window' };
const WIN_SIZES = { normal: { height: 85, width: 80 }, max: { height: 99.5, width: 99.5 } };
const wins = {};                   // kind -> { office | browser | link, size, init }
const handlers = {};               // message type -> fn(kind, m)
let inExcel = false;

export function initWinHost(opts) {
  inExcel = Boolean(opts.inExcel);
  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin) return;
    const kind = Object.keys(wins).find(k => wins[k]?.browser && ev.source === wins[k].browser);
    if (kind) onMessage(kind, ev.data);
  });
  window.addEventListener('pagehide', () => { Object.values(wins).forEach(w => { if (w?.link) w.link.close(true); }); });
}
export const setInExcel = (v) => { inExcel = Boolean(v); };
/** Register a handler for a message type from the windows: fn(kind, message). */
export function onWindow(type, fn) { handlers[type] = fn; }
export const windowOpen = (kind) => Boolean(wins[kind]);
/** The data a window was opened with (and the model version it reported since). */
export const windowInit = (kind) => wins[kind]?.init || null;

/** Open (or re-open) a window. init: data for its first message (projectId, versionId, drawing, view, ...). */
export async function openWindow(kind, mode = 'normal', init = {}) {
  if (!App.currentProjectId?.()) { status('Open a project first (Projects tab).', 'bad'); App.selectTab?.('project'); return; }
  const prevInit = wins[kind]?.init || {};
  closeWindow(kind);
  const base = new URL(PAGES[kind], location.href).href;
  const initData = { ...prevInit, ...init };
  const officeBusy = Object.entries(wins).some(([k, w]) => k !== kind && w?.office);
  if (mode === 'app' || (officeBusy && inExcel)) return openAppWindow(kind, base, initData);
  if (typeof Office !== 'undefined' && Office.context?.ui?.displayDialogAsync && inExcel) {
    const size = mode === 'max' ? 'max' : 'normal';
    Office.context.ui.displayDialogAsync(`${base}?dlg=${size}`, { ...WIN_SIZES[size], displayInIframe: false }, (r) => {
      if (r.status !== Office.AsyncResultStatus.Succeeded) {
        // Office allows one dialog at a time: fall back to an app window
        if (r.error?.code === 12007) { openAppWindow(kind, base, initData); return; }
        status(`Could not open the ${NAMES[kind]}: ${r.error?.message || ''}`, 'bad'); return;
      }
      const dlg = r.value;
      wins[kind] = { office: dlg, size, init: initData };
      dlg.addEventHandler(Office.EventType.DialogMessageReceived, (m) => { try { onMessage(kind, JSON.parse(m.message)); } catch { /* ignore */ } });
      dlg.addEventHandler(Office.EventType.DialogEventReceived, () => { if (wins[kind]?.office === dlg) delete wins[kind]; });
    });
  } else {
    const w = window.open(base, 'dwfx-' + kind, 'width=1440,height=920');
    if (!w) { status('Your browser blocked the window. Allow pop-ups for this site.', 'bad'); return; }
    wins[kind] = { browser: w, init: initData };
  }
  status(`The ${NAMES[kind]} is opening. It stays linked with this pane and the workbook.`);
}
async function openAppWindow(kind, base, init) {
  let link;
  try { link = await api('POST', '/link'); } catch (err) { status(`Could not open the ${NAMES[kind]}: ${err.message}`, 'bad'); return; }
  const ch = new LinkChannel(link.id, 'pane', {
    onMessage: (m) => {
      if (m.type === 'peer') { if (m.side === 'win' && !m.online && wins[kind]?.link === ch) status(`The ${NAMES[kind]} is closed or offline. It reconnects by itself when it comes back.`); return; }
      onMessage(kind, m);
    },
    onState: (st) => { if (st === 'ended' && wins[kind]?.link === ch) delete wins[kind]; },
  });
  ch.start();
  wins[kind] = { link: ch, init };
  const url = `${base}?link=${encodeURIComponent(link.id)}&claim=${encodeURIComponent(link.claim)}`;
  try {
    if (typeof Office !== 'undefined' && Office.context?.ui?.openBrowserWindow && inExcel) Office.context.ui.openBrowserWindow(url);
    else if (!window.open(url, '_blank')) throw new Error('blocked');
    status(`The ${NAMES[kind]} is opening in your browser. You can minimise, maximise or move it to a second screen; it stays linked with Excel.`, 'ok');
  } catch {
    status('Could not open the browser. Allow pop-ups for this site, then try again.', 'bad'); ch.close(true); delete wins[kind];
  }
}
export function closeWindow(kind) {
  const w = wins[kind]; if (!w) return;
  try {
    if (w.office) w.office.close();
    else if (w.browser && !w.browser.closed) w.browser.close();
    else if (w.link) w.link.close(true);
  } catch { /* already closed */ }
  delete wins[kind];
}
export function closeAll() { Object.keys(wins).forEach(closeWindow); }
/** Send a message to one window (if it is open). */
export function sendTo(kind, msg) {
  const w = wins[kind]; if (!w) return;
  const text = JSON.stringify(msg);
  try {
    if (w.office) w.office.messageChild?.(text);
    else if (w.link) w.link.send(msg);
    else if (w.browser && !w.browser.closed) w.browser.postMessage(msg, location.origin);
    else delete wins[kind];
  } catch { /* window gone */ }
}
/** Send to every open window. */
export function broadcast(msg) { Object.keys(wins).forEach(k => sendTo(k, msg)); }

function onMessage(kind, m) {
  if (!m || typeof m !== 'object' || !m.type) return;
  if (m.type === 'ready') {
    const w = wins[kind];
    sendTo(kind, { type: 'init', token: session.get()?.token, projectId: App.currentProjectId?.(), inExcel,
      mode: w?.link ? 'app' : w?.office ? w.size : 'browser', ...(App.windowExtra?.(kind) || {}), ...(w?.init || {}) });
    if (w) w.init = { ...w.init, view: null, drawing: null };       // a carried view is used once
    return;
  }
  if (m.type === 'reopen') { openWindow(kind, m.mode, { view: m.view || null }); return; }
  if (m.type === 'closeMe') { closeWindow(kind); return; }
  if (m.type === 'openVersion' && wins[kind]) wins[kind].init = { ...wins[kind].init, versionId: m.versionId, label: m.label || '' };
  const h = handlers[m.type];
  if (h) Promise.resolve(h(kind, m)).catch(err => console.error(err));
}
