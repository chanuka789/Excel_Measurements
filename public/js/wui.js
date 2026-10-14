// Small UI pieces for the 3D window: right-click menus (with sub-menus, shortcuts, disabled items) and dialogs.
import { esc } from './core.js';

let openMenu = null;
let hideTimer = 0;
export function closeMenu() { openMenu?.remove(); openMenu = null; document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onKey, true); }
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
function onKey(e) {
  if (!openMenu) return;
  const list = [...openMenu.querySelectorAll('.cm-list:not([hidden]) > .cm-item:not([aria-disabled="true"])')];
  const cur = document.activeElement?.closest?.('.cm-item');
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const sameList = cur ? [...cur.parentElement.querySelectorAll(':scope > .cm-item:not([aria-disabled="true"])')] : list;
    const i = sameList.indexOf(cur); const n = sameList[(i + (e.key === 'ArrowDown' ? 1 : -1) + sameList.length) % sameList.length];
    n?.focus(); return;
  }
  if (e.key === 'ArrowRight' && cur?.classList.contains('has-sub')) { e.preventDefault(); showSub(cur); cur.querySelector('.cm-list .cm-item')?.focus(); return; }
  if (e.key === 'ArrowLeft' && cur) { const parent = cur.parentElement.closest('.cm-item'); if (parent) { e.preventDefault(); cur.parentElement.hidden = true; parent.focus(); } return; }
  if ((e.key === 'Enter' || e.key === ' ') && cur) { e.preventDefault(); cur.click(); }
}
function showSub(item) {
  const sub = item.querySelector(':scope > .cm-list'); if (!sub) return;
  item.parentElement.querySelectorAll(':scope > .cm-item > .cm-list').forEach(l => { if (l !== sub) l.hidden = true; });
  sub.hidden = false;
  // open to the right, or to the left when there is no room (like the screenshots of CostX)
  sub.style.left = '100%'; sub.style.right = 'auto'; sub.style.top = '-4px';
  const r = sub.getBoundingClientRect();
  if (r.right > window.innerWidth - 4) { sub.style.left = 'auto'; sub.style.right = '100%'; }
  const r2 = sub.getBoundingClientRect();
  if (r2.bottom > window.innerHeight - 4) sub.style.top = `${Math.min(-4, window.innerHeight - 4 - r2.bottom)}px`;
}
function build(items) {
  const ul = document.createElement('div'); ul.className = 'cm-list'; ul.setAttribute('role', 'menu');
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { const s = document.createElement('div'); s.className = 'cm-sep'; s.setAttribute('role', 'separator'); ul.append(s); continue; }
    const b = document.createElement('div'); b.className = 'cm-item'; b.tabIndex = -1; b.setAttribute('role', 'menuitem');
    b.innerHTML = `<span class="cm-label">${esc(it.label)}</span>${it.key ? `<span class="cm-key">${esc(it.key)}</span>` : ''}${it.items ? '<span class="cm-arrow" aria-hidden="true">›</span>' : ''}`;
    if (it.title) b.title = it.title;
    if (it.disabled) b.setAttribute('aria-disabled', 'true');
    if (it.checked != null) b.setAttribute('aria-checked', String(Boolean(it.checked)));
    if (it.items) {
      b.classList.add('has-sub'); b.setAttribute('aria-haspopup', 'menu');
      const sub = build(it.items); sub.hidden = true; b.append(sub);
      b.addEventListener('pointerenter', () => { clearTimeout(hideTimer); showSub(b); });
      sub.addEventListener('pointerenter', () => clearTimeout(hideTimer));
      b.addEventListener('click', (e) => { if (e.target.closest('.cm-list') === sub) return; showSub(b); });
    } else {
      // close an open sub-menu only after a short pause, so a diagonal move towards it does not close it
      b.addEventListener('pointerenter', () => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => b.parentElement?.querySelectorAll(':scope > .cm-item > .cm-list').forEach(l => { l.hidden = true; }), 300);
      });
      b.addEventListener('click', (e) => { e.stopPropagation(); if (it.disabled) return; closeMenu(); it.run?.(); });
    }
    ul.append(b);
  }
  return ul;
}
/** items: [{ label, key, run, disabled, items:[...] } | '-'] shown at client x, y. */
export function menu(items, x, y) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'cmenu'; m.append(build(items));
  document.body.append(m); openMenu = m;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey, true); }, 0);
  m.querySelector('.cm-item:not([aria-disabled="true"])')?.focus();
  return m;
}

/**
 * Modal dialog. body: HTML string or element. buttons: [{ label, value, primary, danger }]. onOpen(root) wires fields.
 * Resolves with the clicked button's value (validate(root, value) can return an error text to keep it open), or null.
 */
export function dialog({ title, body, buttons = [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }], wide = false, side = false, onOpen, validate }) {
  return new Promise((resolve) => {
    const host = document.getElementById('dialog');
    host.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'dlg' + (wide ? ' wide' : '') + (side ? ' side-actions' : '');
    d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', title);
    d.innerHTML = `<div class="dlg-head"><h2>${esc(title)}</h2><button class="dlg-x" aria-label="Close" data-v="__close">×</button></div>
      <div class="dlg-main"><div class="dlg-body"></div><div class="dlg-actions">${buttons.map((b, i) =>
        `<button class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div></div>
      <div class="dlg-err" role="alert"></div>`;
    const bodyEl = d.querySelector('.dlg-body');
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
    host.append(d); host.hidden = false;
    const done = (v) => { host.hidden = true; host.innerHTML = ''; resolve(v); };
    d.querySelector('[data-v="__close"]').onclick = () => done(null);
    d.querySelectorAll('[data-i]').forEach(btn => btn.onclick = async () => {
      const b = buttons[+btn.dataset.i];
      if (b.value != null && validate) { const err = await validate(d, b.value); if (err) { d.querySelector('.dlg-err').textContent = err; return; } }
      done(b.value);
    });
    host.onkeydown = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') { e.preventDefault(); d.querySelector('.btn.primary')?.click(); }
    };
    onOpen?.(d);
    (d.querySelector('[autofocus]') || d.querySelector('input,select,textarea') || d.querySelector('.btn.primary'))?.focus();
  });
}
/** One text or number field. Resolves with the value, or null. */
export async function ask(title, label, value = '', { type = 'text', hint = '', okLabel = 'OK' } = {}) {
  let out = null;
  const r = await dialog({ title, body: `<label class="field">${esc(label)}<input class="input" id="askV" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${esc(value)}" autofocus></label>${hint ? `<p class="hint">${esc(hint)}</p>` : ''}`,
    buttons: [{ label: 'Cancel', value: null }, { label: okLabel, value: 'ok', primary: true }],
    validate: (d) => { const v = d.querySelector('#askV').value.trim(); if (!v) return 'Enter a value.'; if (type === 'number' && !Number.isFinite(Number(v))) return 'Enter a number.'; out = type === 'number' ? Number(v) : v; return ''; } });
  return r ? out : null;
}
export async function confirmIt(title, text, okLabel = 'Delete', danger = true) {
  return (await dialog({ title, body: `<p>${esc(text)}</p>`, buttons: [{ label: 'Cancel', value: null }, { label: okLabel, value: 'ok', primary: !danger, danger }] })) === 'ok';
}
