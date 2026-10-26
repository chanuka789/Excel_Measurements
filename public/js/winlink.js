// The window side of the link with the Excel task pane, shared by the measurement window (viewer.html) and the
// DWFx Schedules window (schedules.html). Three ways to talk: an Office dialog (messageParent / messageChild),
// a browser pop-up (window.opener), or the app window (a normal browser window linked through the server).
// Only the task pane can write to the workbook, so the windows ask it (askPane) and it answers.
import { session } from './core.js';
import { LinkChannel } from './link.js';

// window settings come in the query string (Excel on the web can drop the #fragment) or, from older panes, the fragment
export const HASH = new URLSearchParams(location.search);
new URLSearchParams(location.hash.slice(1)).forEach((v, k) => { if (!HASH.has(k)) HASH.set(k, v); });
export const MODE = HASH.get('link') ? 'app' : HASH.get('dlg') ? 'dialog' : 'popup';

/**
 * opts: { onMessage(m), onPeer(online), onEnded(text) }
 * Returns { send, askPane, start(): Promise<bool>, get office(), get link() }
 */
export function createWinLink(opts) {
  let office = false, link = null;
  const pending = new Map(); let reqN = 0;
  function send(msg) {
    try {
      if (link) link.send(msg);
      else if (office) Office.context.ui.messageParent(JSON.stringify(msg));
      else window.opener?.postMessage(msg, location.origin);
    } catch { /* pane closed */ }
  }
  /** Ask the task pane to do something only it can do (write to Excel). Resolves with its answer. */
  function askPane(cmd, data = {}, timeout = 180000) {
    const id = ++reqN;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error('The task pane did not answer. Is the add-in still open in Excel?')); }, timeout);
      pending.set(id, { resolve, reject, t });
      send({ type: 'pane', id, cmd, ...data });
    });
  }
  function receive(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'paneReply' && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.t);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error || 'The task pane could not do that.'));
      return;
    }
    opts.onMessage?.(m);
  }
  /** The app window gets its own session from a one-time code in the address, then removes it from the address. */
  async function startLink() {
    const id = HASH.get('link'), claim = HASH.get('claim');
    session.useMemory(null);
    history.replaceState(null, '', location.pathname);      // the one-time code leaves the address bar
    const r = await fetch('api/link/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, claim }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { opts.onEnded?.(data.error || 'This window link has expired. Open the window again from the Excel task pane.'); return false; }
    session.set({ token: data.token, user: data.user });
    link = new LinkChannel(id, 'win', {
      onMessage: (m) => { if (m.type === 'peer') { if (m.side === 'pane') opts.onPeer?.(m.online); return; } receive(m); },
      onState: (st) => { if (st === 'ended') opts.onEnded?.('The link with Excel has ended. Open the window again from the task pane.'); },
    });
    link.start();
    return true;
  }
  async function start() {
    window.addEventListener('message', (ev) => { if (ev.origin === location.origin) receive(ev.data); });
    const ready = MODE !== 'app' && typeof Office !== 'undefined' ? Office.onReady().catch(() => ({})) : Promise.resolve({});
    await ready;
    if (MODE === 'app') { if (!(await startLink())) return false; }
    else {
      // In Excel on the web the dialog is a pop-up whose opener is Excel itself, not this pane, so a dialog always
      // talks through Office (messageParent / messageChild). A plain pop-up (add-in opened in a browser) uses the opener.
      const canOffice = typeof Office !== 'undefined' && Boolean(Office.context?.ui?.messageParent);
      office = canOffice && (MODE === 'dialog' || !window.opener);
      if (office) {
        try { Office.context.ui.addHandlerAsync(Office.EventType.DialogParentMessageReceived, (arg) => { try { receive(JSON.parse(arg.message)); } catch { /* ignore */ } }); } catch { /* DialogApi 1.2 missing */ }
      }
    }
    send({ type: 'ready' });
    return MODE === 'app' || office || Boolean(window.opener);
  }
  return { send, askPane, start, receive, get office() { return office; }, get link() { return link; } };
}

/** Maximise / Restore re-open the Office dialog at the other size (Office has no resize call); "App window" moves to a
 * normal browser window with minimise and maximise. carry() returns the view to restore in the new window. */
export function windowButtons(box, send, carry) {
  if (!box) return;
  const reopen = (mode) => { send({ type: 'reopen', mode, view: carry() }); };
  if (MODE === 'dialog') {
    const max = HASH.get('dlg') === 'max';
    box.innerHTML = `<button class="wb" id="wMax" title="${max ? 'Back to the normal size' : 'Fill the screen'}">${max ? 'Restore' : 'Maximise'}</button>
      <button class="wb" id="wApp" title="Open in a separate browser window that you can minimise, maximise and move to another screen">App window</button>`;
    box.querySelector('#wMax').onclick = () => reopen(max ? 'normal' : 'max');
    box.querySelector('#wApp').onclick = () => reopen('app');
  } else if (MODE === 'app') {
    box.innerHTML = `<button class="wb" id="wFull" title="Full screen (Esc to leave)">Full screen</button>`;
    box.querySelector('#wFull').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); };
  }
}
