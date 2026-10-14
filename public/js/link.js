// Message channel between the task pane and the app window through the server (see src/link.js).
import { session } from './core.js';

export class LinkChannel {
  /** side: 'pane' or 'win'. onMessage(msg) for messages from the other side; onState('online'|'offline'|'ended'). */
  constructor(id, side, { onMessage, onState } = {}) {
    Object.assign(this, { id, side, onMessage, onState, closed: false, ctrl: null, outbox: [], sending: false, tries: 0 });
  }
  headers() { const t = session.get()?.token; return t ? { Authorization: 'Bearer ' + t } : {}; }
  async start() {
    while (!this.closed) {
      this.ctrl = new AbortController();
      try {
        const res = await fetch(`api/link/${encodeURIComponent(this.id)}/stream?side=${this.side}`, { headers: this.headers(), signal: this.ctrl.signal, cache: 'no-store' });
        if (res.status === 404 || res.status === 401) { this.closed = true; this.onState?.('ended'); return; }
        if (!res.ok || !res.body) throw new Error('stream ' + res.status);
        this.tries = 0; this.onState?.('online');
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
            if (!data) continue;
            let msg; try { msg = JSON.parse(data); } catch { continue; }
            if (msg.type === 'closed') { this.closed = true; this.onState?.('ended'); }
            try { this.onMessage?.(msg); } catch (err) { console.error(err); }
          }
        }
      } catch { /* connection dropped: reconnect below */ }
      if (this.closed) return;
      this.onState?.('offline');
      await new Promise(r => setTimeout(r, Math.min(15000, 500 * 2 ** this.tries++)));
    }
  }
  /** Messages keep their order; failed sends are retried a few times. */
  send(msg) { if (!this.closed) { this.outbox.push(msg); this.flush(); } }
  async flush() {
    if (this.sending) return; this.sending = true;
    try {
      while (this.outbox.length && !this.closed) {
        const msg = this.outbox[0];
        let ok = false;
        for (let k = 0; k < 4 && !ok; k++) {
          try {
            const r = await fetch(`api/link/${encodeURIComponent(this.id)}/send`, { method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ side: this.side, msg }) });
            if (r.status === 404 || r.status === 401) { this.closed = true; this.onState?.('ended'); return; }
            ok = r.ok;
          } catch { /* retry */ }
          if (!ok) await new Promise(r => setTimeout(r, 400 * (k + 1)));
        }
        this.outbox.shift();
      }
    } finally { this.sending = false; }
  }
  close(end = false) {
    this.closed = true; this.ctrl?.abort();
    if (end) fetch(`api/link/${encodeURIComponent(this.id)}`, { method: 'DELETE', headers: this.headers(), keepalive: true }).catch(() => {});
  }
}
