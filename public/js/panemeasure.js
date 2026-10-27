// Measurements tab of the task pane: the project's dimension folders and groups with their totals, their
// dimensions, and the links to workbook cells. Measuring is done in the measurement window; this list follows it.
import { $, esc, App, status } from './core.js';
import { fmt } from './engine.js';
import { displayUnit, dimQuantity } from './dims.js';
import * as CX from './cxlinks.js';

const M = { open: new Set(), sel: null, filter: '' };
const nice = (v, u) => (v == null ? '' : fmt(v, u === 'nr' ? '' : u));

export function renderMeasurements() {
  const box = $('measBody'); if (!box) return;
  const pid = App.currentProjectId?.();
  if (!pid) { box.innerHTML = '<div class="empty">Open a project in the Projects tab. Its dimension groups and measurements show here.</div>'; return; }
  const t = CX.tree();
  const inExcel = App.inExcel?.();
  const links = CX.links();
  const linkCount = (gid) => links.filter(l => l.gid === gid).length;
  const head = `<div class="row meas-tools">
      <button class="btn primary" id="mmOpen" title="Open the measurement window (ribbon, drawings, 3D model, dimension groups)">Open measurement window</button>
      <button class="btn" id="mmSched" title="DWFx quantity schedules from the model data (separate from measuring)">DWFx Schedules</button></div>
    <div class="row meas-tools">
      <button class="btn small" id="mmLink" ${M.sel && inExcel ? '' : 'disabled'} title="Write a live formula into the selected Excel cell">Link to selected cell</button>
      <button class="btn small" id="mmShow" ${M.sel ? '' : 'disabled'} title="Show where it was measured, in the measurement window">Show in drawing</button>
      <button class="btn small" id="mmCells" ${M.sel && inExcel ? '' : 'disabled'} title="Select the linked cells in Excel">Linked cells</button>
      <label class="check follow"><input type="checkbox" id="mmFollow" ${CX.following() ? 'checked' : ''}> Follow Excel</label>
      <button class="btn small subtle" id="mmRefresh" title="Read the measurements and the linked cells again">Refresh</button></div>
    ${inExcel ? `<div class="row meas-tools">
      <button class="btn small" id="mmShare" title="For people without the add-in: the linked cells become plain numbers; the formulas are kept in the workbook">Share copy</button>
      <button class="btn small" id="mmRestore" title="Make the links live again after sharing">Restore links</button></div>` : ''}
    <div class="dropbar" id="mmDrop" hidden>Drop here to link to the selected Excel cell</div>
    <input type="search" class="input" id="mmFind" placeholder="Click to filter" value="${esc(M.filter)}" aria-label="Filter dimension groups">`;
  if (!t) { box.innerHTML = head + '<div class="loading">Reading the measurements…</div>'; wire(box); return; }
  const folders = t.folders.filter(f => f.kind === 'dim');
  const f = M.filter.toLowerCase();
  const show = (g) => !f || g.name.toLowerCase().includes(f);
  const row = (g, depth) => {
    const total = CX.linkValue(g), u = displayUnit(g), n = (g.props?.measured || []).length + (g.items || []).length, lc = linkCount(g.id);
    const open = M.open.has(g.id);
    let html = `<div class="mrow grp ${M.sel?.gid === g.id && !M.sel.mid ? 'sel' : ''}" data-g="${g.id}" draggable="true" style="padding-left:${6 + depth * 14}px" title="${esc(g.name)} · ${n} dimension(s)${lc ? ` · linked to ${lc} cell(s)` : ''}">
      <span class="tw" data-tw="${g.id}">${n ? (open ? '▾' : '▸') : ''}</span><span class="sw" style="background:${esc(g.props?.color || '#8a9aa6')}"></span>
      <span class="lbl">${esc(g.name)}</span>${lc ? `<span class="lk" aria-label="linked">⛓${lc > 1 ? lc : ''}</span>` : ''}<span class="v">${esc(nice(total, u))}</span><span class="u">${esc(u)}</span></div>`;
    if (open) {
      for (const m of g.props?.measured || []) {
        const q = dimQuantity(g, m.value, m), lk = links.some(l => l.mid === m.id);
        html += `<div class="mrow dim ${M.sel?.mid === m.id ? 'sel' : ''}" data-g="${g.id}" data-m="${m.id}" draggable="true" style="padding-left:${24 + depth * 14}px">
          <span class="lbl">${esc(m.label)}${m.src?.name ? ` <span class="hint">· ${esc(m.src.name)}</span>` : ''}</span>${lk ? '<span class="lk">⛓</span>' : ''}<span class="v">${esc(nice(q, u))}</span><span class="u">${esc(u)}</span></div>`;
      }
      if ((g.items || []).length) html += `<div class="mrow dim muted" style="padding-left:${24 + depth * 14}px"><span class="lbl">${g.items.length} model object(s)</span><span class="v"></span><span class="u"></span></div>`;
    }
    return html;
  };
  const folderHtml = (parent, depth) => {
    let html = '';
    for (const fo of folders.filter(x => (x.parent_id || null) === parent).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      const inner = folderHtml(fo.id, depth + 1) + t.groups.filter(g => g.folder_id === fo.id && show(g)).map(g => row(g, depth + 1)).join('');
      if (f && !inner) continue;
      const open = !M.open.has('f:' + fo.id);
      html += `<div class="mrow fold" data-f="${fo.id}" style="padding-left:${6 + depth * 14}px"><span class="tw">${open ? '▾' : '▸'}</span><span class="lbl">📁 ${esc(fo.name)}</span></div>${open ? inner : ''}`;
    }
    return html;
  };
  const body = folderHtml(null, 0) + t.groups.filter(g => !g.folder_id && show(g)).map(g => row(g, 0)).join('');
  box.innerHTML = head + `<div class="mtree" role="tree" aria-label="Dimension groups">${body || '<div class="empty">No dimension groups yet. Open the measurement window to create folders and dimension groups and to measure drawings and models.</div>'}</div>
    <p class="hint">${inExcel ? 'Select a cell in Excel, then drag a group or a dimension onto the drop bar (or press Link to selected cell). The cell gets a live formula such as =CX.QTY("1a2b3c4d") that follows every change. With Follow Excel on, a click on a linked cell shows the measurement.' : 'Open this add-in in Excel to link measurements to cells.'}</p>`;
  wire(box);
}

function wire(box) {
  $('mmOpen').onclick = () => App.openMeasureWindow?.();
  $('mmSched').onclick = () => App.openSchedulesWindow?.();
  $('mmRefresh').onclick = async () => { await CX.loadTree(); if (App.inExcel?.()) await CX.broadcastLinks({ rescan: true }).catch(() => {}); status('Measurements and linked cells read again.', 'ok'); };
  $('mmFollow').onchange = (e) => { CX.setFollow(e.target.checked); App.sendToWindow?.('measure', { type: 'paneEvent', what: 'follow', on: e.target.checked }); };
  $('mmFind').oninput = (e) => { M.filter = e.target.value; renderMeasurements(); const i = $('mmFind'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); };
  $('mmLink').onclick = () => link(M.sel);
  if ($('mmShare')) $('mmShare').onclick = () => App.shareCopy?.();
  if ($('mmRestore')) $('mmRestore').onclick = () => App.restoreLinks?.();
  $('mmShow').onclick = () => { if (M.sel) App.focusInWindow?.({ ...M.sel, force: true }); };
  $('mmCells').onclick = async () => { if (!M.sel) return; const n = await CX.selectLinked(M.sel).catch(() => 0); if (!n) status('Not linked to any cell yet.'); };
  const tr = box.querySelector('.mtree'); if (!tr) return;
  tr.onclick = (e) => {
    const tw = e.target.closest('[data-tw]');
    if (tw) { M.open.has(tw.dataset.tw) ? M.open.delete(tw.dataset.tw) : M.open.add(tw.dataset.tw); return renderMeasurements(); }
    const fo = e.target.closest('[data-f]');
    if (fo) { const k = 'f:' + fo.dataset.f; M.open.has(k) ? M.open.delete(k) : M.open.add(k); return renderMeasurements(); }
    const r = e.target.closest('[data-g]'); if (!r) return;
    M.sel = { gid: r.dataset.g, mid: r.dataset.m || null };
    renderMeasurements();
    if (CX.following()) CX.selectLinked(M.sel).catch(() => {});
  };
  tr.ondblclick = (e) => { const r = e.target.closest('[data-g]'); if (r) link({ gid: r.dataset.g, mid: r.dataset.m || null }); };
  const drop = $('mmDrop');
  tr.ondragstart = (e) => {
    const r = e.target.closest('[data-g]'); if (!r) return;
    e.dataTransfer.setData('text/plain', JSON.stringify({ gid: r.dataset.g, mid: r.dataset.m || null }));
    if (App.inExcel?.()) drop.hidden = false;
  };
  tr.ondragend = () => { drop.hidden = true; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); drop.hidden = true; try { link(JSON.parse(e.dataTransfer.getData('text/plain'))); } catch { /* not ours */ } };
}
async function link(item) {
  if (!item) return;
  try { const r = await CX.linkCell(item); status(`Linked ${r.address}: ${r.text}.`, 'ok'); }
  catch (err) { status(err.message, 'bad'); }
}
export function initMeasurements() { App.onMeasurements = () => { if (document.getElementById('tab-meas')?.classList.contains('on')) renderMeasurements(); }; }
