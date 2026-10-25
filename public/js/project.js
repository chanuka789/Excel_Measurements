// Projects tab: list, create, details (models + versions, drawings, team, saved take-offs, activity, export, delete).
import { $, esc, App, api, downloadFile, fmtBytes, fmtDate, fmtDay, status, confirmBox, session } from './core.js';
import { openDrawing, canView } from './drawings.js';
import { DrawingTakeoff, canMeasure, measurableDrawings } from './takeoff2d.js';
import { TakeoffStore } from './tkstore.js';
import { S } from './state.js';
import { canProcessLocally, processLocally, LOCAL } from './localproc.js';
import { library, sha256 } from './localstore.js';
import { addModel, addDrawings, processHere, fileFor, versionMeta, keepVersionHere, keepDrawingHere, isLocal } from './localfiles.js';

const P = { list: [], detail: null, filter: '', poll: null, users: null, open: new Set(['models']) };
const DISCIPLINES = ['Architecture', 'Structure', 'Interiors', 'Mechanical', 'Electrical', 'Plumbing', 'Fire', 'Landscape', 'Other'];
const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
const can = (min) => ({ viewer: 1, editor: 2, owner: 3 }[P.detail?.my_role] || 0) >= ({ viewer: 1, editor: 2, owner: 3 }[min]);
/** Dimension groups and drawing settings of the open project, for on-screen take-off (drawings and 3D points). */
export const tkStore = new TakeoffStore({ projectId: () => P.detail?.project.id || null, canEdit: () => can('editor') });
App.tkStore = tkStore;                 // the 3D view uses it too (point measurement)
let tk2d = null;
/** Open a drawing to measure on it (CostX style); other file types open in the plain viewer. */
function openMeasure(d) {
  if (!d) return;
  if (d.kind !== 'sheet' && !canMeasure(d.name)) return openDrawing(d);
  const box = $('drawingViewer'); box.hidden = false;
  tk2d?.destroy();
  tk2d = new DrawingTakeoff(box, tkStore, { close: true, onClose: () => { box.hidden = true; tk2d = null; }, drawings: () => measurableDrawings(P.detail) });
  tk2d.open(d);
}
window.__tk2d = () => tk2d;                // used by the automated browser tests
const STATUS = { queued: ['Waiting', 'neutral'], processing: ['Processing', 'info'], local: ['On a computer', 'info'], ready: ['Ready', 'ok'], failed: ['Failed', 'bad'] };
const LOCAL_OK = canProcessLocally();
const box = () => $('projectBody');

// ---------------------------------------------------------------- list
export async function showProjects() {
  stopPoll(); P.detail = null; App.setContext?.();
  box().innerHTML = '<div class="loading">Loading projects…</div>';
  try { P.list = (await api('GET', '/projects')).projects; } catch (e) { box().innerHTML = `<div class="msg bad">${esc(e.message)}</div>`; return; }
  renderList();
}
function renderList() {
  const f = P.filter.toLowerCase();
  const rows = P.list.filter(p => !f || `${p.name} ${p.code || ''} ${p.client || ''}`.toLowerCase().includes(f));
  box().innerHTML = `
    <div class="toolbar">
      <h2 class="h">Projects</h2>
      <span class="grow"></span>
      <button class="btn primary" id="pNew">New project</button>
    </div>
    <div id="pNewForm"></div>
    ${P.list.length > 4 ? `<input type="search" id="pFilter" class="input" placeholder="Search projects" value="${esc(P.filter)}" aria-label="Search projects">` : ''}
    ${rows.length ? `<ul class="plist" role="list">${rows.map(p => `
      <li><button class="prow" data-id="${p.id}">
        <span class="pname">${esc(p.name)}${p.code ? ` <span class="muted">${esc(p.code)}</span>` : ''}</span>
        <span class="pmeta">${p.client ? esc(p.client) + ' · ' : ''}${p.models} model${p.models === 1 ? '' : 's'}, ${p.drawings} drawing${p.drawings === 1 ? '' : 's'}, ${p.takeoffs} take-off group${p.takeoffs === 1 ? '' : 's'}</span>
        <span class="pmeta">Updated ${fmtDay(p.updated_at)} · <span class="badge">${ROLE_LABEL[p.my_role] || ''}</span></span>
      </button></li>`).join('')}</ul>`
      : `<div class="empty-state"><p><strong>${P.list.length ? 'No projects match your search.' : 'No projects yet.'}</strong></p><p>${P.list.length ? 'Clear the search to see all projects.' : 'Create a project, then add DWFx models and drawings to it. The files stay on your computer; the project and your measurements are saved to your account.'}</p></div>`}
    <details class="quick"><summary>Open a DWFx without saving it</summary>
      <p class="muted">For a quick look only. The file is read and deleted straight away; nothing is stored.</p>
      <input type="file" id="quickFile" accept=".dwfx"></details>`;
  $('pNew').onclick = newProjectForm;
  $('pFilter') && ($('pFilter').oninput = (e) => { P.filter = e.target.value; renderList(); $('pFilter').focus(); });
  box().querySelectorAll('.prow').forEach(b => b.onclick = () => openProject(b.dataset.id));
  $('quickFile').onchange = (e) => e.target.files[0] && App.quickOpen(e.target.files[0]);
}
function newProjectForm() {
  $('pNewForm').innerHTML = `<form class="card form" id="npf">
    <h3>New project</h3>
    <label class="field">Project name<input class="input" id="npName" required maxlength="120" placeholder="e.g. Saadiyat Villas Phase 2"></label>
    <div class="two"><label class="field">Code<input class="input" id="npCode" maxlength="40" placeholder="e.g. P-2041"></label>
    <label class="field">Client<input class="input" id="npClient" maxlength="120"></label></div>
    <div class="actions"><button type="button" class="btn" id="npCancel">Cancel</button><button class="btn primary">Create project</button></div>
    <div id="npErr" class="msg bad" hidden></div></form>`;
  $('npName').focus();
  $('npCancel').onclick = () => { $('pNewForm').innerHTML = ''; };
  $('npf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const { project } = await api('POST', '/projects', { name: $('npName').value, code: $('npCode').value, client: $('npClient').value });
      status(`Project "${project.name}" created.`, 'ok');
      openProject(project.id);
    } catch (err) { $('npErr').hidden = false; $('npErr').textContent = err.message; }
  };
}

// ---------------------------------------------------------------- detail
export async function openProject(id, keepScroll = false, quiet = false) {
  const y = keepScroll ? box().scrollTop : 0;
  if (!keepScroll) box().innerHTML = '<div class="loading">Opening project…</div>';
  try { P.detail = await api('GET', '/projects/' + id); } catch (e) { P.detail = null; if (!quiet) status(e.message, 'bad'); return showProjects(); }
  try { localStorage.setItem('dwfxLastProject:' + (session.get()?.user?.id || ''), id); } catch { /* storage blocked */ }
  App.setContext?.(P.detail.project);
  applySettings();
  schedulePoll();
  renderDetail(); box().scrollTop = y;
}
export const currentProject = () => P.detail;
function applySettings() { S.settings = { openingThreshold: 0.5, ...(P.detail?.project?.settings || {}) }; }

function section(key, title, count, body, actions = '') {
  const open = P.open.has(key);
  return `<section class="sec">
    <div class="sec-h"><button class="sec-t" data-sec="${key}" aria-expanded="${open}"><span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span>${title}${count != null ? ` <span class="count">${count}</span>` : ''}</button>${actions}</div>
    ${open ? `<div class="sec-b">${body}</div>` : ''}</section>`;
}

function renderDetail() {
  const d = P.detail, p = d.project;
  const versionsTotal = d.models.reduce((n, m) => n + m.versions.length, 0);
  box().innerHTML = `
    <div class="crumbs"><button class="link" id="backList">Projects</button> <span aria-hidden="true">›</span> <span>${esc(p.name)}</span></div>
    <div class="phead">
      <div class="grow"><h2 class="h">${esc(p.name)}</h2>
        <div class="muted">${[p.code, p.client].filter(Boolean).map(esc).join(' · ') || 'No code or client yet'} · Your access: ${ROLE_LABEL[d.my_role]}</div></div>
      ${can('owner') ? '<button class="btn subtle" id="pEdit">Edit details</button>' : ''}
    </div>
    <div id="pEditForm"></div>
    ${section('models', 'Models', versionsTotal, modelsHtml(), can('editor') ? '<button class="btn small" id="upToggle">Add DWFx</button>' : '')}
    ${section('drawings', 'Drawings and documents', d.drawings.length, drawingsHtml(), can('editor') ? '<button class="btn small" id="drToggle">Add</button>' : '')}
    ${section('library', 'On this computer', null, '<div id="libBody" class="loading">Looking at this computer…</div>')}
    ${section('takeoffs', 'Saved take-off groups', d.takeoffs.length, takeoffsHtml())}
    ${section('team', 'Team', d.members.length, teamHtml())}
    ${section('settings', 'Project settings and QS rules', null, settingsHtml())}
    ${section('activity', 'Activity', null, '<div id="actList" class="loading">Loading…</div>')}
    ${section('manage', 'Export and delete', null, manageHtml())}`;
  wireDetail();
  markHere();
  if (P.open.has('library')) renderLibrary();
}

function modelsHtml() {
  const d = P.detail;
  const up = `<form class="card form" id="upForm" ${P.showUpload ? '' : 'hidden'}>
      <h3>Add a DWFx model</h3>
      <label class="field">DWFx file<input type="file" id="upFile" accept=".dwfx" required></label>
      <div class="two"><label class="field">Model name<input class="input" id="upName" list="modelNames" maxlength="80" placeholder="e.g. Architecture" required>
        <datalist id="modelNames">${d.models.map(m => `<option value="${esc(m.name)}">`).join('')}</datalist></label>
      <label class="field">Discipline<select class="input" id="upDisc"><option value="">Choose…</option>${DISCIPLINES.map(x => `<option>${x}</option>`).join('')}</select></label></div>
      <label class="field">Revision note (optional)<input class="input" id="upNote" maxlength="300" placeholder="e.g. IFC rev C, 12 Oct"></label>
      <p class="muted">Using an existing model name adds a new version of that model. A new name creates a new model.</p>
      <p class="muted small">${LOCAL_OK ? 'The file stays on this computer and is processed here, with this computer\'s power. Only its name, size and fingerprint go to the project, and your measurements are saved to the project as usual. Teammates open it by choosing the same file on their computer.' : 'This browser cannot process models. Use Excel on Windows or Mac, or a current browser.'}</p>
      <div class="progress" id="upProg" hidden><div></div></div>
      <div class="actions"><button type="button" class="btn" id="upCancel">Cancel</button><button class="btn primary" id="upGo" ${LOCAL_OK ? '' : 'disabled'}>Add and process</button></div>
      <div id="upErr" class="msg bad" hidden></div></form>`;
  if (!d.models.length) return up + `<div class="empty-state"><p><strong>No models yet.</strong></p><p>${can('editor') ? 'Add a DWFx exported from Revit. It stays on this computer and is processed here for 3D and measurement.' : 'An editor or owner can add models to this project.'}</p></div>`;
  return up + d.models.map(m => `<div class="model">
    <div class="model-h"><strong>${esc(m.name)}</strong>${m.discipline ? ` <span class="badge">${esc(m.discipline)}</span>` : ''}</div>
    <ul class="vlist" role="list">${m.versions.map(v => {
      const [label, tone] = STATUS[v.status] || [v.status, 'neutral'];
      const isOpen = App.currentVersionId?.() === v.id;
      return `<li class="vrow ${isOpen ? 'current' : ''}">
        <div class="vmain"><span class="vnum">v${v.version}</span> <span class="vfile" title="${esc(v.file_name)}">${esc(v.file_name)}</span>
          <span class="pill ${tone}">${label}</span>${isOpen ? ' <span class="pill brand">Open</span>' : ''} ${whereHtml(v)}</div>
        <div class="muted small">${fmtDate(v.created_at)} · ${esc(v.uploaded_by || '')} · ${fmtBytes(Number(v.size))}${v.stats ? ` · ${v.stats.elements} elements, ${v.stats.withGeometry} in 3D` : ''}${v.note ? ' · ' + esc(v.note) : ''}</div>
        ${v.status === 'processing' || v.status === 'queued' ? `<div class="muted small">${esc(v.progress || '')}</div><div class="progress indet"><div></div></div>` : ''}
        ${v.status === 'local' ? localHtml(v) : ''}
        ${v.status === 'failed' ? `<div class="msg bad small">${esc(v.error || 'Processing failed.')}</div>` : ''}
        <div class="vact">
          ${v.status === 'ready' ? `<button class="btn small primary" data-open="${v.id}">${isOpen ? 'Reload' : 'Open'}</button>` : ''}
          ${v.stats?.sheets?.length ? `<button class="btn small" data-sheets="${v.id}">2D sheets (${v.stats.sheets.length})</button>` : ''}
          ${isLocal(v) ? '' : `<button class="btn small" data-src="${v.id}" data-name="${esc(v.file_name)}">Download</button>`}
          ${v.status === 'failed' && can('editor') && !isLocal(v) ? `<button class="btn small" data-re="${v.id}">Try again on the server</button>` : ''}
          ${v.status === 'failed' && can('editor') && LOCAL_OK ? `<button class="btn small" data-here="${v.id}" data-name="${esc(v.file_name)}">Process on this computer</button>` : ''}
          ${v.status === 'local' && can('editor') && isLocal(v) && LOCAL_OK && !LOCAL.has(v.id) ? `<button class="btn small" data-here="${v.id}" data-name="${esc(v.file_name)}">Process here</button>` : ''}
          ${v.status === 'local' && can('editor') && !isLocal(v) ? `<button class="btn small" data-server="${v.id}">Process on the server instead</button>` : ''}
          ${v.status === 'ready' && can('owner') && !isLocal(v) ? `<button class="btn small" data-keep="${v.id}" data-label="${esc(m.name)} v${v.version}" title="Save the file here and delete the server copy">Keep on computers only</button>` : ''}
          ${can('owner') ? `<button class="btn small subtle danger-text" data-delv="${v.id}" data-label="${esc(m.name)} v${v.version}">Delete</button>` : ''}
        </div></li>`; }).join('')}</ul></div>`).join('');
}
/** A version processed on a computer: this one (live progress) or someone else's (the progress it reports). */
function localHtml(v) {
  const me = LOCAL.get(v.id);
  if (me) return `<div class="muted small">${esc(me.step)} · ${Math.round((Date.now() - me.started) / 1000)} s</div><div class="progress"><div style="width:${me.pct}%"></div></div>`;
  return `<div class="muted small">${esc(v.progress || 'Processing on the uploader\'s computer')}</div><div class="progress indet"><div></div></div>
    <div class="muted small">${isLocal(v) ? 'The file is kept on the computers, so a computer that has it finishes it. If that computer was closed, press "Process here" and choose the file.' : 'If that computer is closed, the server takes over after 10 minutes.'}</div>`;
}
/** Where the file is kept: on the computers (with "here" / "not here" filled in after the page shows) or on the server. */
function whereHtml(x) {
  if (!isLocal(x)) return '<span class="pill neutral" title="Added before files were kept on the computers. The owner can move it.">On the server</span>';
  return `<span class="pill neutral" data-here-sha="${esc(x.sha256 || '')}" title="Kept on the computers of the project team">On computers</span>`;
}
/** After rendering: mark the files this computer has. */
async function markHere() {
  const els = [...box().querySelectorAll('[data-here-sha]')];
  for (const el of els) {
    const has = el.dataset.hereSha && await library.hasFile(el.dataset.hereSha).catch(() => false);
    el.textContent = has ? 'On this computer' : 'Not on this computer yet';
    el.className = 'pill ' + (has ? 'ok' : 'warn');
  }
}
/** Process a version kept on the computers here (asks for the file if this computer does not have it). */
async function hereLocal(pid, vid, name) {
  let last = 0;
  try {
    const meta = await versionMeta(vid, { fresh: true });
    const blob = await fileFor(meta);
    status(`Processing ${name} on this computer…`, 'info'); openProject(pid, true);
    const r = processHere(meta, blob, { onUpdate: () => { if (Date.now() - last > 1000 && P.detail?.project.id === pid) { last = Date.now(); renderDetail(); } } });
    await r; status(`${name} is ready (processed on this computer).`, 'ok');
  } catch (err) { status(err.message, 'bad'); }
  finally { if (P.detail?.project.id === pid) openProject(pid, true); }
}

/** Run processLocally for a version and keep the page up to date; the server takes over if it fails. */
function runHere(pid, file, versionId) {
  let last = 0;
  processLocally(file, versionId, { onUpdate: () => { if (Date.now() - last > 1000 && P.detail?.project.id === pid) { last = Date.now(); renderDetail(); } } })
    .then(({ ms }) => { status(`${file.name} is ready (processed on this computer in ${Math.round(ms / 1000)} s).`, 'ok'); })
    .catch((err) => { console.warn('Local processing failed:', err); status(`Processing ${file.name} on the server instead (this computer could not do it). It will be ready in a moment.`, 'warn'); })
    .finally(() => { if (P.detail?.project.id === pid) openProject(pid, true); });
}

function drawingsHtml() {
  const d = P.detail;
  const up = `<form class="card form" id="drForm" ${P.showDrUpload ? '' : 'hidden'}>
    <h3>Add drawings and documents</h3>
    <label class="field">Files (PDF, DWFx, DWF, DWG, DXF, images, XLSX, DOCX; up to 50 at once)<input type="file" id="drFiles" multiple required></label>
    <p class="muted small">The files stay on this computer. Only their names, sizes and fingerprints go to the project; your measurements on them are saved to the project.</p>
    <div class="progress" id="drProg" hidden><div></div></div>
    <div class="actions"><button type="button" class="btn" id="drCancel">Cancel</button><button class="btn primary">Add</button></div>
    <div id="drErr" class="msg bad" hidden></div></form>`;
  if (!d.drawings.length) return up + '<div class="empty-state"><p>No drawings yet. Add the drawing set to measure on it. The files stay on this computer.</p></div>';
  return up + `<table class="tbl"><thead><tr><th>Name</th><th>Size</th><th>Added</th><th></th></tr></thead><tbody>${d.drawings.map(x => `
    <tr><td class="wrap">${esc(x.name)}<br>${whereHtml(x)}</td><td class="num">${fmtBytes(Number(x.size))}</td><td class="small">${fmtDay(x.created_at)}<br><span class="muted">${esc(x.uploaded_by || '')}</span></td>
    <td class="right">${canView(x.name) || canMeasure(x.name) ? `<button class="btn small" data-view="${x.id}" title="${canMeasure(x.name) ? 'Open the drawing to view and measure it' : 'Open the drawing'}">${canMeasure(x.name) ? 'Open &amp; measure' : 'View'}</button> ` : ''}${isLocal(x) ? '' : `<button class="btn small" data-dl="${x.id}" data-name="${esc(x.name)}">Download</button>`}${can('owner') && !isLocal(x) ? ` <button class="btn small" data-keepd="${x.id}" title="Save the file here and delete the server copy">Keep on computers only</button>` : ''}${can('editor') ? ` <button class="btn small subtle danger-text" data-deld="${x.id}" data-name="${esc(x.name)}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
}
function takeoffsHtml() {
  const d = P.detail;
  if (!d.takeoffs.length) return '<div class="empty-state"><p>No saved take-off groups yet. Groups you add to Excel while this project is open are saved here automatically, so you can rebuild the Take-off sheet in any workbook.</p></div>';
  const open = App.currentVersionId?.();
  return `<p class="muted small">Restore writes the groups into the open workbook's Take-off sheet with live formulas. Open the model version first so the elements can be matched.</p>
    <div class="actions left"><button class="btn small primary" id="toRestoreAll" ${open ? '' : 'disabled'}>Restore all to workbook</button></div>
    <table class="tbl"><thead><tr><th>Group</th><th>Elements</th><th>Saved</th><th></th></tr></thead><tbody>${d.takeoffs.map(t => `
    <tr><td class="wrap">${esc(t.name)}${t.version_id && t.version_id !== open ? ' <span class="pill neutral" title="Measured on a different model version">other version</span>' : ''}</td><td class="num">${t.elements}</td>
    <td class="small">${fmtDay(t.created_at)}<br><span class="muted">${esc(t.created_by || '')}</span></td>
    <td class="right"><button class="btn small" data-rest="${t.id}" ${open ? '' : 'disabled'}>Restore</button>${can('editor') ? ` <button class="btn small subtle danger-text" data-delt="${t.id}" data-name="${esc(t.name)}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
}
function teamHtml() {
  const d = P.detail; const me = session.get()?.user?.id;
  return `<table class="tbl"><thead><tr><th>Name</th><th>Access</th><th></th></tr></thead><tbody>${d.members.map(m => `
    <tr><td>${esc(m.name)}<br><span class="muted small">${esc(m.email)}</span></td>
    <td>${can('owner') ? `<select class="input small" data-role="${m.id}" aria-label="Access for ${esc(m.name)}">${['owner', 'editor', 'viewer'].map(r => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>` : ROLE_LABEL[m.role]}</td>
    <td class="right">${can('owner') && m.id !== me ? `<button class="btn small subtle danger-text" data-rm="${m.id}" data-name="${esc(m.name)}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table>
    ${can('owner') ? `<form class="inline-form" id="addMember">
      <input class="input" id="amEmail" list="dirUsers" placeholder="Colleague's email" required aria-label="Colleague's email">
      <datalist id="dirUsers"></datalist>
      <select class="input" id="amRole" aria-label="Access"><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="owner">Owner</option></select>
      <button class="btn">Add</button></form>
      <p class="muted small">Editors can add files and measure. Viewers can open. Owners also manage the team and can delete the project. Only people in your user list can be added.</p>` : ''}`;
}
function settingsHtml() {
  const p = P.detail.project, st = p.settings || {};
  return `${can('owner') ? `<form class="form" id="psForm">
      <label class="row"><input type="checkbox" id="psAiOff" ${p.ai_off ? 'checked' : ''}> Switch the AI off for this project (confidential work)</label>
      <label class="field">Do not deduct openings up to (m²)<input class="input" type="number" id="psThr" min="0" max="100" step="0.1" value="${st.openingThreshold ?? 0.5}"></label>
      <label class="field">BOQ house style for AI descriptions<textarea class="input" id="psStyle" maxlength="1000" placeholder="e.g. NRM2 style. Start with the work, then material, size and location. Use 'Ditto' for repeated headings.">${esc(st.houseStyle || '')}</textarea></label>
      <div class="actions left"><button class="btn primary">Save settings</button></div></form>`
    : `<p class="muted small">AI: ${p.ai_off ? 'off for this project' : 'on'} · openings up to ${st.openingThreshold ?? 0.5} m² are not deducted.</p>`}
    <h3 style="margin-top:12px">QS rules for this project</h3>
    <p class="muted small">The AI reads these rules (and your company rules) before it plans or checks a take-off. Example: "Measure formwork to ground beams on sides only".</p>
    <div id="kbList" class="loading">Loading…</div>
    ${can('editor') ? `<form class="form" id="kbForm"><label class="field">Rule title<input class="input" id="kbTitle" maxlength="160" required></label>
      <label class="field">Rule<textarea class="input" id="kbBody" maxlength="4000" required></textarea></label>
      <div class="actions left"><button class="btn">Add rule</button></div></form>` : ''}`;
}
async function loadKB() {
  const el = $('kbList'); if (!el) return;
  try {
    const { rules } = await api('GET', `/kb?projectId=${P.detail.project.id}`);
    const mine = rules.filter(r => r.scope === 'project');
    el.className = '';
    el.innerHTML = (mine.length ? `<ul class="check-list">${mine.map(r => `<li><span class="grow"><strong>${esc(r.title)}</strong><br><span class="muted small">${esc(r.body)}</span></span>${can('editor') ? `<button class="btn small subtle danger-text" data-kbd="${r.id}">Delete</button>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">No project rules yet.</p>') +
      `<p class="muted small">${rules.length - mine.length} company rule(s) also apply${App.isAdmin?.() ? ' (edit them in Admin)' : ''}.</p>`;
    el.querySelectorAll('[data-kbd]').forEach(b => b.onclick = async () => { try { await api('DELETE', `/kb/${b.dataset.kbd}`); loadKB(); } catch (err) { status(err.message, 'bad'); } });
  } catch (err) { el.textContent = err.message; }
}

/** "On this computer": the files and models kept here, which project items they belong to, and room left. */
async function renderLibrary() {
  const el = $('libBody'); if (!el) return;
  const d = P.detail;
  const items = [...d.models.flatMap(m => m.versions.map(v => ({ sha: v.sha256, label: `${m.name} v${v.version} · ${v.file_name}` }))), ...d.drawings.map(x => ({ sha: x.sha256, label: x.name }))].filter(x => x.sha);
  // copies of files still on the server, kept here after they were opened
  const copies = new Map([...d.models.flatMap(m => m.versions.map(v => [`cloud:v:${v.id}`, `${m.name} v${v.version} · ${v.file_name}`])), ...d.drawings.map(x => [`cloud:d:${x.id}`, x.name])]);
  let list, use;
  try { [list, use] = await Promise.all([library.list(), library.usage()]); } catch (err) { el.className = 'msg bad'; el.textContent = err.message; return; }
  const mine = list.filter(f => items.some(i => i.sha === f.key) || copies.has(f.key));
  const missing = items.filter(i => !list.some(f => f.key === i.sha));
  const total = (f) => (f.size || 0) + (f.model || 0) + (f.cad || 0);
  el.className = '';
  el.innerHTML = `<p class="muted small">Drawings and models are kept on this computer and processed here; the project on the server keeps only their names and fingerprints, and your measurements. ${use.quota ? `This computer's library uses ${fmtBytes(use.used)} of the ${fmtBytes(use.quota)} the browser allows.` : ''}</p>
    ${missing.length ? `<div class="msg warn small">This computer does not have ${missing.length} of this project's file${missing.length > 1 ? 's' : ''} yet: ${missing.slice(0, 6).map(i => esc(i.label)).join(', ')}${missing.length > 6 ? '…' : ''}. Add the files you received below, or open one and choose its file.</div>` : ''}
    <label class="field">Add files you received (they are matched to the project by their content)<input type="file" id="libAdd" multiple></label>
    ${mine.length ? `<table class="tbl"><thead><tr><th>File</th><th>On this computer</th><th></th></tr></thead><tbody>${mine.map(f => {
      const it = items.find(i => i.sha === f.key) || (copies.has(f.key) ? { label: copies.get(f.key) } : null);
      return `<tr><td class="wrap">${esc(it?.label || f.name)}${f.key.startsWith('cloud:') ? ' <span class="muted small">(copy of a file on the server)</span>' : ''}</td>
        <td class="small">${fmtBytes(total(f))}${f.model ? '<br><span class="muted">processed model kept</span>' : ''}</td>
        <td class="right">${f.model || f.cad ? `<button class="btn small subtle" data-libre="${esc(f.key)}" title="Remove the processed model or converted drawing; it is made again when needed">Clear processed</button> ` : ''}<button class="btn small subtle danger-text" data-librm="${esc(f.key)}" data-name="${esc(it?.label || f.name)}">Remove</button></td></tr>`; }).join('')}</tbody></table>` : '<p class="muted small">Nothing from this project is kept on this computer yet.</p>'}`;
  $('libAdd').onchange = async (e) => {
    const files = [...e.target.files]; let matched = 0, other = 0;
    status('Checking the files…');
    for (const f of files) {
      const sha = await sha256(f);
      if (items.some(i => i.sha === sha)) { await library.putFile(f, { name: f.name, key: sha }); matched++; } else other++;
    }
    status(`${matched} file${matched === 1 ? '' : 's'} matched this project and ${matched === 1 ? 'is' : 'are'} kept on this computer.${other ? ` ${other} did not match any file in this project (add new files under Models or Drawings).` : ''}`, matched ? 'ok' : 'warn');
    renderDetail();
  };
  el.querySelectorAll('[data-libre]').forEach(b => b.onclick = async () => { await library.removeDerived(b.dataset.libre); renderLibrary(); });
  el.querySelectorAll('[data-librm]').forEach(b => b.onclick = async () => {
    if (!await confirmBox({ title: `Remove ${b.dataset.name} from this computer?`, body: '<p>The file and what was made from it are removed from this computer only. The project and its measurements are not changed. To open it here again, choose the file.</p>', confirmLabel: 'Remove', danger: true })) return;
    await library.remove(b.dataset.librm); renderDetail();
  });
}

function manageHtml() {
  return `<div class="row-actions"><div><strong>Export project</strong><div class="muted small">A ZIP with every model version, drawing, saved take-off and the activity log.</div></div>
    <button class="btn" id="pExport">Export ZIP</button></div>
    ${can('owner') ? `<div class="row-actions danger-zone"><div><strong>Delete project</strong><div class="muted small">Deletes the project and all its files from the server. This cannot be undone.</div></div>
    <button class="btn danger" id="pDelete">Delete project</button></div>` : ''}`;
}

function wireDetail() {
  const d = P.detail, pid = d.project.id;
  $('backList').onclick = showProjects;
  box().querySelectorAll('[data-sec]').forEach(b => b.onclick = () => {
    P.open.has(b.dataset.sec) ? P.open.delete(b.dataset.sec) : P.open.add(b.dataset.sec); renderDetail();
  });
  if (P.open.has('activity')) loadActivity();
  if (P.open.has('settings')) {
    loadKB();
    $('psForm') && ($('psForm').onsubmit = async (e) => {
      e.preventDefault();
      await act(() => api('PATCH', `/projects/${pid}/settings`, { aiOff: $('psAiOff').checked, openingThreshold: Number($('psThr').value), houseStyle: $('psStyle').value }), 'Project settings saved.');
      applySettings(); App.computeDerived && S.data && App.computeDerived();
    });
    $('kbForm') && ($('kbForm').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', '/kb', { scope: 'project', projectId: pid, title: $('kbTitle').value, body: $('kbBody').value }); $('kbTitle').value = ''; $('kbBody').value = ''; loadKB(); status('Rule added.', 'ok'); }
      catch (err) { status(err.message, 'bad'); }
    });
  }
  box().querySelectorAll('[data-view]').forEach(b => b.onclick = () => openMeasure(d.drawings.find(x => x.id === b.dataset.view)));
  box().querySelectorAll('[data-sheets]').forEach(b => b.onclick = () => {
    const v = d.models.flatMap(m => m.versions).find(x => x.id === b.dataset.sheets);
    const list = v.stats.sheets;
    if (list.length === 1) return openMeasure({ kind: 'sheet', versionId: v.id, index: list[0].index, name: list[0].name });
    confirmBox({ title: '2D sheets', body: `<ul class="check-list">${list.map(sh => `<li><span class="grow">${esc(sh.name)}</span><button class="btn small" data-sh="${sh.index}">View</button></li>`).join('')}</ul>`, confirmLabel: 'Close' });
    document.querySelectorAll('#dialog [data-sh]').forEach(x => x.onclick = () => { $('dlgNo').click(); const sh = list.find(y => y.index === +x.dataset.sh); openMeasure({ kind: 'sheet', versionId: v.id, index: sh.index, name: sh.name }); });
  });
  $('pEdit') && ($('pEdit').onclick = editForm);
  // models
  $('upToggle') && ($('upToggle').onclick = () => { P.open.add('models'); P.showUpload = true; renderDetail(); $('upFile')?.focus(); });
  if ($('upForm')) {
    $('upCancel').onclick = () => { P.showUpload = false; renderDetail(); };
    $('upFile').onchange = (e) => { const f = e.target.files[0]; if (f && !$('upName').value) $('upName').value = f.name.replace(/\.dwfx$/i, '').slice(0, 80); };
    $('upForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = $('upFile').files[0]; if (!f) return;
      $('upGo').disabled = true; $('upErr').hidden = true; const bar = $('upProg'); bar.hidden = false; bar.classList.add('indet');
      let last = 0;
      try {
        await addModel(pid, f, { modelName: $('upName').value, discipline: $('upDisc').value, note: $('upNote').value,
          onUpdate: (st) => {
            if (st.step === 'Done') { status(`${f.name} is ready (processed on this computer).`, 'ok'); if (P.detail?.project.id === pid) openProject(pid, true); return; }
            if (Date.now() - last > 1000 && P.detail?.project.id === pid && !P.showUpload) { last = Date.now(); renderDetail(); }
          } });
        P.showUpload = false;
        status(`${f.name} added. Processing on this computer…`, 'info');
        await openProject(pid, true);
      } catch (err) { $('upErr').hidden = false; $('upErr').textContent = err.message; $('upGo').disabled = false; bar.hidden = true; }
    };
  }
  box().querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    const m = d.models.find(x => x.versions.some(v => v.id === b.dataset.open)), v = m.versions.find(x => x.id === b.dataset.open);
    App.openVersion(b.dataset.open, `${m.name} v${v.version} · ${v.file_name}`);
  });
  box().querySelectorAll('[data-src]').forEach(b => b.onclick = () => dl(`/versions/${b.dataset.src}/source`, b.dataset.name));
  box().querySelectorAll('[data-re]').forEach(b => b.onclick = async () => { await api('POST', `/versions/${b.dataset.re}/reprocess`); openProject(pid, true); });
  box().querySelectorAll('[data-server]').forEach(b => b.onclick = async () => {
    if (LOCAL.has(b.dataset.server)) { status('This computer is processing it now. Wait a little, or close this window and the server takes over.', 'info'); return; }
    await act(() => api('POST', `/versions/${b.dataset.server}/server`, { reason: 'asked by a user' }), 'The server is processing it now.');
  });
  box().querySelectorAll('[data-here]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    const v = d.models.flatMap(m => m.versions).find(x => x.id === b.dataset.here);
    if (isLocal(v)) { await hereLocal(pid, v.id, v.file_name); return; }
    try {
      await api('POST', `/versions/${b.dataset.here}/local-start`);
      status(`Downloading ${b.dataset.name} to process it here…`);
      const res = await api('GET', `/versions/${b.dataset.here}/source`, null, { raw: true });
      const file = new File([await res.blob()], b.dataset.name);
      runHere(pid, file, b.dataset.here); openProject(pid, true);
    } catch (err) { status(err.message, 'bad'); b.disabled = false; }
  });
  box().querySelectorAll('[data-keep]').forEach(b => b.onclick = async () => {
    if (!await confirmBox({ title: `Keep ${b.dataset.label} on the computers only?`, body: '<p>The file and its processed model are saved on this computer, then the copy on the server is deleted. Your measurements stay in the project.</p><p>Teammates then open it by choosing the same file on their computer, so send them the file first.</p>', confirmLabel: 'Move it here' })) return;
    b.disabled = true; status('Saving the file and its model on this computer…');
    await act(() => keepVersionHere(b.dataset.keep), `${b.dataset.label} is now kept on the computers only.`);
  });
  box().querySelectorAll('[data-delv]').forEach(b => b.onclick = async () => {
    const v = d.models.flatMap(m => m.versions).find(x => x.id === b.dataset.delv);
    if (!await confirmBox({ title: `Delete ${b.dataset.label}?`, body: isLocal(v) ? '<p>The version is removed from the project. Saved take-off groups stay but lose the link to this version. The file stays on the computers that have it (remove it under "On this computer").</p>' : '<p>The DWFx file and its processed data are deleted from the server. Saved take-off groups stay but lose the link to this version.</p>', confirmLabel: 'Delete version', danger: true })) return;
    await act(() => api('DELETE', `/versions/${b.dataset.delv}`), `${b.dataset.label} deleted.`);
  });
  // drawings
  $('drToggle') && ($('drToggle').onclick = () => { P.open.add('drawings'); P.showDrUpload = true; renderDetail(); $('drFiles')?.focus(); });
  if ($('drForm')) {
    $('drCancel').onclick = () => { P.showDrUpload = false; renderDetail(); };
    $('drForm').onsubmit = async (e) => {
      e.preventDefault();
      const files = [...$('drFiles').files]; if (!files.length) return;
      const bar = $('drProg'); bar.hidden = false; bar.classList.add('indet'); $('drErr').hidden = true;
      try {
        await addDrawings(pid, files);
        P.showDrUpload = false; status(`${files.length} file${files.length > 1 ? 's' : ''} added. ${files.length > 1 ? 'They stay' : 'It stays'} on this computer.`, 'ok'); openProject(pid, true);
      } catch (err) { $('drErr').hidden = false; $('drErr').textContent = err.message; bar.hidden = true; }
    };
  }
  box().querySelectorAll('[data-dl]').forEach(b => b.onclick = () => dl(`/drawings/${b.dataset.dl}/file`, b.dataset.name));
  box().querySelectorAll('[data-keepd]').forEach(b => b.onclick = async () => {
    const x = d.drawings.find(y => y.id === b.dataset.keepd);
    if (!await confirmBox({ title: `Keep ${x.name} on the computers only?`, body: '<p>The file is saved on this computer, then the copy on the server is deleted. Measurements on it stay in the project. Teammates then open it by choosing the same file.</p>', confirmLabel: 'Move it here' })) return;
    b.disabled = true;
    await act(() => keepDrawingHere(x), `${x.name} is now kept on the computers only.`);
  });
  box().querySelectorAll('[data-deld]').forEach(b => b.onclick = async () => {
    const x = d.drawings.find(y => y.id === b.dataset.deld);
    if (!await confirmBox({ title: `Delete ${b.dataset.name}?`, body: isLocal(x) ? '<p>The drawing is removed from the project. The file stays on the computers that have it.</p>' : '<p>The file is deleted from the server.</p>', confirmLabel: 'Delete', danger: true })) return;
    await act(() => api('DELETE', `/drawings/${b.dataset.deld}`), 'Drawing deleted.');
  });
  // take-offs
  $('toRestoreAll') && ($('toRestoreAll').onclick = () => restore(d.takeoffs.map(t => t.id)));
  box().querySelectorAll('[data-rest]').forEach(b => b.onclick = () => restore([b.dataset.rest]));
  box().querySelectorAll('[data-delt]').forEach(b => b.onclick = async () => {
    if (!await confirmBox({ title: `Delete saved group "${b.dataset.name}"?`, body: '<p>This removes the saved copy only. Rows already in your workbook are not changed.</p>', confirmLabel: 'Delete', danger: true })) return;
    await act(() => api('DELETE', `/takeoffs/${b.dataset.delt}`), 'Saved group deleted.');
  });
  // team
  box().querySelectorAll('[data-role]').forEach(s => s.onchange = async () => {
    const m = d.members.find(x => String(x.id) === s.dataset.role);
    await act(() => api('POST', `/projects/${pid}/members`, { email: m.email, role: s.value }), `${m.name} is now ${ROLE_LABEL[s.value]}.`);
  });
  box().querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => {
    if (!await confirmBox({ title: `Remove ${b.dataset.name}?`, body: '<p>They will no longer see this project.</p>', confirmLabel: 'Remove', danger: true })) return;
    await act(() => api('DELETE', `/projects/${pid}/members/${b.dataset.rm}`), `${b.dataset.name} removed.`);
  });
  if ($('addMember')) {
    loadDirectory();
    $('addMember').onsubmit = async (e) => {
      e.preventDefault();
      await act(() => api('POST', `/projects/${pid}/members`, { email: $('amEmail').value, role: $('amRole').value }), 'Team member added.');
    };
  }
  // manage
  $('pExport') && ($('pExport').onclick = () => dl(`/projects/${pid}/export`, `${d.project.name.replace(/[^\w.-]+/g, '_')}_export.zip`, 'Preparing the export. Large projects can take a minute…'));
  $('pDelete') && ($('pDelete').onclick = async () => {
    const typed = await confirmBox({ title: 'Delete this project?', body: `<p>All models, drawings and saved take-offs of <strong>${esc(d.project.name)}</strong> are deleted from the server. Workbooks you already made are not changed.</p>`, confirmLabel: 'Delete project', danger: true, typeToConfirm: d.project.name });
    if (!typed) return;
    try { await api('DELETE', `/projects/${pid}`, { confirm: typed }); P.detail = null; stopPoll(); App.setContext?.(); App.closeModel?.(); status('Project deleted.', 'ok'); showProjects(); }
    catch (err) { status(err.message, 'bad'); }
  });
}

async function act(fn, okMsg) {
  try { await fn(); status(okMsg, 'ok'); await openProject(P.detail.project.id, true); }
  catch (err) { status(err.message, 'bad'); }
}
async function dl(url, name, wait) {
  status(wait || `Downloading ${name}…`);
  try { await downloadFile(url, name); status(`${name} downloaded.`, 'ok'); } catch (err) { status(err.message, 'bad'); }
}
async function loadDirectory() {
  try { P.users ||= (await api('GET', '/users/directory')).users; } catch { P.users = []; }
  const have = new Set(P.detail.members.map(m => m.email));
  const dl = $('dirUsers'); if (dl) dl.innerHTML = P.users.filter(u => !have.has(u.email)).map(u => `<option value="${esc(u.email)}">${esc(u.name)}</option>`).join('');
}
async function loadActivity() {
  try {
    const { activity } = await api('GET', `/projects/${P.detail.project.id}/activity`);
    const el = $('actList'); if (!el) return;
    el.className = '';
    el.innerHTML = activity.length ? `<ul class="act" role="list">${activity.slice(0, 30).map(a => `<li><span class="muted small">${fmtDate(a.at)}</span> ${esc(a.name || 'System')} ${esc(describe(a))}</li>`).join('')}</ul>` : '<p class="muted">No activity yet.</p>';
  } catch (err) { $('actList').textContent = err.message; }
}
const describe = (a) => {
  const d = a.detail || {};
  return ({
    'project.create': `created the project`, 'project.update': 'edited the project details', 'project.export': 'exported the project',
    'model.upload': `uploaded ${d.model} v${d.version} (${d.file})`, 'model.delete_version': `deleted ${d.model} v${d.version}`,
    'drawing.upload': `uploaded ${(d.files || []).length} drawing(s)`, 'drawing.delete': `deleted ${d.name}`,
    'model.add_local': `added ${d.model} v${d.version} (${d.file}, kept on the computers)`, 'drawing.add_local': `added ${(d.files || []).length} drawing(s) (kept on the computers)`,
    'model.processed_locally': `processed v${d.version} on a computer${d.ms ? ` in ${Math.round(d.ms / 1000)} s` : ''}`,
    'model.keep_local': `moved ${d.model} v${d.version} from the server to the computers`, 'drawing.keep_local': `moved ${d.name} from the server to the computers`,
    'takeoff.save': `saved take-off "${d.name}" (${d.elements} elements)`, 'takeoff.delete': `deleted take-off "${d.name}"`,
    'member.set': `gave ${d.email} ${d.role} access`, 'member.remove': 'removed a team member', 'ai.request': `asked the AI: "${d.request}"`,
  })[a.action] || a.action;
};
function editForm() {
  const p = P.detail.project;
  $('pEditForm').innerHTML = `<form class="card form" id="pef"><h3>Project details</h3>
    <label class="field">Project name<input class="input" id="peName" required maxlength="120" value="${esc(p.name)}"></label>
    <div class="two"><label class="field">Code<input class="input" id="peCode" maxlength="40" value="${esc(p.code || '')}"></label>
    <label class="field">Client<input class="input" id="peClient" maxlength="120" value="${esc(p.client || '')}"></label></div>
    <label class="field">Description<textarea class="input" id="peDesc" maxlength="1000">${esc(p.description || '')}</textarea></label>
    <div class="actions"><button type="button" class="btn" id="peCancel">Cancel</button><button class="btn primary">Save</button></div></form>`;
  $('peCancel').onclick = () => { $('pEditForm').innerHTML = ''; };
  $('pef').onsubmit = async (e) => { e.preventDefault();
    await act(() => api('PATCH', `/projects/${p.id}`, { name: $('peName').value, code: $('peCode').value, client: $('peClient').value, description: $('peDesc').value }), 'Project details saved.'); };
}

async function restore(ids) {
  const all = (await api('GET', `/projects/${P.detail.project.id}/takeoffs`)).takeoffs;
  const list = all.filter(t => ids.includes(t.id));
  let n = 0;
  for (const t of list) { try { await App.addToExcel(t.spec, { save: false, takeoffId: t.id }); n++; } catch (err) { status(`"${t.name}": ${err.message}`, 'bad'); return; } }
  status(`${n} group${n === 1 ? '' : 's'} restored to the Take-off sheet.`, 'ok');
}

// poll while a version is processing
function schedulePoll() {
  stopPoll();
  const busy = P.detail?.models.some(m => m.versions.some(v => ['queued', 'processing', 'local'].includes(v.status)));
  if (busy) P.poll = setTimeout(() => P.detail && openProject(P.detail.project.id, true), LOCAL.size ? 5000 : 2500);
}
function stopPoll() { if (P.poll) clearTimeout(P.poll); P.poll = null; }
export function resetProjects() { stopPoll(); P.detail = null; P.list = []; P.users = null; P.filter = ''; App.setContext?.(); }
export const refreshProject = () => P.detail && openProject(P.detail.project.id, true);
