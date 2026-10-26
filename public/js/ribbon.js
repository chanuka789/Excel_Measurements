// A ribbon like CostX / Office: tabs, groups, large buttons and stacks of small buttons, toggles and drop-down
// buttons. Commands live in one registry (commands.js) so the ribbon, the right-click menus and the keys run the same
// code. Double-click a tab (or Ctrl+F1) to collapse the ribbon to its tab names.
import { esc } from './core.js';
import { icon } from './icons.js';
import { menu } from './wui.js';

/**
 * host: element. opts: { tabs: [{ id, label, groups: [{ label, items: ['cmd' | ['cmd', 'cmd', 'cmd']] }] }],
 *   cmds: { id: { label, icon, title, run(button), enabled(), checked(), menu() -> wui menu items } }, file: () => menu items, storageKey }
 */
export class Ribbon {
  constructor(host, opts) {
    this.host = host; this.o = opts; this.cmds = opts.cmds;
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(opts.storageKey || 'dwfxRibbon') || '{}'); } catch { /* storage blocked */ }
    this.tab = opts.tabs.some(t => t.id === saved.tab) ? saved.tab : opts.tabs[0].id;
    this.min = Boolean(saved.min);
    this.render();
    document.addEventListener('keydown', (e) => { if (e.key === 'F1' && e.ctrlKey) { e.preventDefault(); this.toggleMin(); } });
  }
  save() { try { localStorage.setItem(this.o.storageKey || 'dwfxRibbon', JSON.stringify({ tab: this.tab, min: this.min })); } catch { /* storage blocked */ } }
  /** Show a tab (or keep the current one) and draw it. */
  setTab(id) { if (this.o.tabs.some(t => t.id === id)) { this.tab = id; this.save(); this.render(); this.o.onTab?.(id); } }
  toggleMin() { this.min = !this.min; this.save(); this.render(); this.o.onResize?.(); }
  btn(id, size) {
    const c = this.cmds[id];
    if (!c) return `<button class="rb-b ${size}" disabled title="${esc(id)}">${icon('props', size === 'lg' ? 32 : 16)}<span>${esc(id)}</span></button>`;
    const caret = c.menu ? '<span class="rb-caret" aria-hidden="true">▾</span>' : '';
    return `<button class="rb-b ${size}" data-c="${esc(id)}" title="${esc(c.title || c.label)}" aria-label="${esc(c.label)}"${c.checked ? ' aria-pressed="false"' : ''}${c.menu ? ' aria-haspopup="menu"' : ''}>${icon(c.icon || 'props', size === 'lg' ? 32 : 16)}<span class="rb-l">${esc(c.label)}${caret}</span></button>`;
  }
  render() {
    const tabs = this.o.tabs, cur = tabs.find(t => t.id === this.tab) || tabs[0];
    this.host.className = 'rb' + (this.min ? ' min' : '');
    this.host.innerHTML = `<div class="rb-tabs" role="tablist" aria-label="Ribbon">
        ${this.o.file ? '<button class="rb-file" data-file>File</button>' : ''}
        ${tabs.map(t => `<button role="tab" class="rb-t" data-t="${esc(t.id)}" aria-selected="${t.id === cur.id}" tabindex="${t.id === cur.id ? 0 : -1}">${esc(t.label)}</button>`).join('')}
        <span class="rb-sp"></span><button class="rb-min" data-min title="${this.min ? 'Show the ribbon' : 'Collapse the ribbon'} (Ctrl+F1)" aria-label="${this.min ? 'Show the ribbon' : 'Collapse the ribbon'}">${this.min ? '⌄' : '⌃'}</button></div>
      <div class="rb-body" role="tabpanel" ${this.min ? 'hidden' : ''}>${cur.groups.map(g => `<div class="rb-grp" role="group" aria-label="${esc(g.label)}"><div class="rb-items">${g.items.map(it =>
        Array.isArray(it) ? `<div class="rb-stack">${it.map(id => this.btn(id, 'sm')).join('')}</div>` : this.btn(it, 'lg')).join('')}</div><div class="rb-gl">${esc(g.label)}</div></div>`).join('')}</div>`;
    this.host.querySelectorAll('[data-t]').forEach(b => {
      b.onclick = () => { if (this.min) { this.min = false; this.save(); } this.setTab(b.dataset.t); this.o.onResize?.(); };
      b.ondblclick = () => this.toggleMin();
    });
    this.host.querySelector('[role=tablist]').onkeydown = (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key) || !e.target.dataset.t) return;
      const i = tabs.findIndex(t => t.id === this.tab), n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      this.setTab(n.id); this.host.querySelector(`[data-t="${n.id}"]`)?.focus();
    };
    this.host.querySelector('[data-min]').onclick = () => this.toggleMin();
    const f = this.host.querySelector('[data-file]');
    if (f) f.onclick = () => { const r = f.getBoundingClientRect(); menu(this.o.file(), r.left, r.bottom + 2); };
    this.host.querySelectorAll('[data-c]').forEach(b => b.onclick = () => this.run(b.dataset.c, b));
    this.refresh();
  }
  /** Run a command by id (from a button, a menu or a key). */
  async run(id, btn = null) {
    const c = this.cmds[id]; if (!c) return;
    if (c.enabled && !c.enabled()) return;
    try {
      if (c.menu) { const r = (btn || this.host).getBoundingClientRect(); menu(c.menu(), r.left, r.bottom + 2); }
      else await c.run(btn);
    } catch (err) { this.o.onError?.(err); }
    this.refresh();
  }
  /** Update disabled and pressed states (cheap; call after anything changes). */
  refresh() {
    this.host.querySelectorAll('[data-c]').forEach(b => {
      const c = this.cmds[b.dataset.c]; if (!c) return;
      let on = true; try { on = c.enabled ? Boolean(c.enabled()) : true; } catch { on = false; }
      b.disabled = !on;
      if (c.checked) { let ck = false; try { ck = Boolean(c.checked()); } catch { /* not ready */ } b.setAttribute('aria-pressed', String(ck)); }
    });
  }
}
