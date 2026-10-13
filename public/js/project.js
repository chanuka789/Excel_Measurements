// Projects tab: list, create, details (models + versions, drawings, team, saved take-offs, activity, export, delete).
import { $, esc, App, api, upload, downloadFile, fmtBytes, fmtDate, fmtDay, status, confirmBox, session } from './core.js';
import { openDrawing, canView } from './drawings.js';
import { S } from './state.js';

const P = { list: [], detail: null, filter: '', poll: null, users: null, open: new Set(['models']) };
const DISCIPLINES = ['Architecture', 'Structure', 'Interiors', 'Mechanical', 'Electrical', 'Plumbing', 'Fire', 'Landscape', 'Other'];
const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
const can = (min) => ({ viewer: 1, editor: 2, owner: 3 }[P.detail?.my_role] || 0) >= ({ viewer: 1, editor: 2, owner: 3 }[min]);
const STATUS = { queued: ['Waiting', 'neutral'], processing: ['Processing', 'info'], ready: ['Ready', 'ok'], failed: ['Failed', 'bad'] };
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
      : `<div class="empty-state"><p><strong>${P.list.length ? 'No projects match your search.' : 'No projects yet.'}</strong></p><p>${P.list.length ? 'Clear the search to see all projects.' : 'Create a project, then upload DWFx models and drawings to it. Everything is saved to your account.'}</p></div>`}
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
    ${section('models', 'Models', versionsTotal, modelsHtml(), can('editor') ? '<button class="btn small" id="upToggle">Upload DWFx</button>' : '')}
    ${section('drawings', 'Drawings and documents', d.drawings.length, drawingsHtml(), can('editor') ? '<button class="btn small" id="drToggle">Upload</button>' : '')}
    ${section('takeoffs', 'Saved take-off groups', d.takeoffs.length, takeoffsHtml())}
    ${section('team', 'Team', d.members.length, teamHtml())}
    ${section('settings', 'Project settings and QS rules', null, settingsHtml())}
    ${section('activity', 'Activity', null, '<div id="actList" class="loading">Loading…</div>')}
    ${section('manage', 'Export and delete', null, manageHtml())}`;
  wireDetail();
}

function modelsHtml() {
  const d = P.detail;
  const up = `<form class="card form" id="upForm" ${P.showUpload ? '' : 'hidden'}>
      <h3>Upload a DWFx model</h3>
      <label class="field">DWFx file<input type="file" id="upFile" accept=".dwfx" required></label>
      <div class="two"><label class="field">Model name<input class="input" id="upName" list="modelNames" maxlength="80" placeholder="e.g. Architecture" required>
        <datalist id="modelNames">${d.models.map(m => `<option value="${esc(m.name)}">`).join('')}</datalist></label>
      <label class="field">Discipline<select class="input" id="upDisc"><option value="">Choose…</option>${DISCIPLINES.map(x => `<option>${x}</option>`).join('')}</select></label></div>
      <label class="field">Revision note (optional)<input class="input" id="upNote" maxlength="300" placeholder="e.g. IFC rev C, 12 Oct"></label>
      <p class="muted">Using an existing model name adds a new version of that model. A new name creates a new model.</p>
      <div class="progress" id="upProg" hidden><div></div></div>
      <div class="actions"><button type="button" class="btn" id="upCancel">Cancel</button><button class="btn primary" id="upGo">Upload and process</button></div>
      <div id="upErr" class="msg bad" hidden></div></form>`;
  if (!d.models.length) return up + `<div class="empty-state"><p><strong>No models yet.</strong></p><p>${can('editor') ? 'Upload a DWFx exported from Revit. It is saved in this project and processed for 3D and measurement.' : 'An editor or owner can upload models to this project.'}</p></div>`;
  return up + d.models.map(m => `<div class="model">
    <div class="model-h"><strong>${esc(m.name)}</strong>${m.discipline ? ` <span class="badge">${esc(m.discipline)}</span>` : ''}</div>
    <ul class="vlist" role="list">${m.versions.map(v => {
      const [label, tone] = STATUS[v.status] || [v.status, 'neutral'];
      const isOpen = App.currentVersionId?.() === v.id;
      return `<li class="vrow ${isOpen ? 'current' : ''}">
        <div class="vmain"><span class="vnum">v${v.version}</span> <span class="vfile" title="${esc(v.file_name)}">${esc(v.file_name)}</span>
          <span class="pill ${tone}">${label}</span>${isOpen ? ' <span class="pill brand">Open</span>' : ''}</div>
        <div class="muted small">${fmtDate(v.created_at)} · ${esc(v.uploaded_by || '')} · ${fmtBytes(Number(v.size))}${v.stats ? ` · ${v.stats.elements} elements, ${v.stats.withGeometry} in 3D` : ''}${v.note ? ' · ' + esc(v.note) : ''}</div>
        ${v.status === 'processing' || v.status === 'queued' ? `<div class="muted small">${esc(v.progress || '')}</div><div class="progress indet"><div></div></div>` : ''}
        ${v.status === 'failed' ? `<div class="msg bad small">${esc(v.error || 'Processing failed.')}</div>` : ''}
        <div class="vact">
          ${v.status === 'ready' ? `<button class="btn small primary" data-open="${v.id}">${isOpen ? 'Reload' : 'Open'}</button>` : ''}
          ${v.stats?.sheets?.length ? `<button class="btn small" data-sheets="${v.id}">2D sheets (${v.stats.sheets.length})</button>` : ''}
          <button class="btn small" data-src="${v.id}" data-name="${esc(v.file_name)}">Download</button>
          ${v.status === 'failed' && can('editor') ? `<button class="btn small" data-re="${v.id}">Try again</button>` : ''}
          ${can('owner') ? `<button class="btn small subtle danger-text" data-delv="${v.id}" data-label="${esc(m.name)} v${v.version}">Delete</button>` : ''}
        </div></li>`; }).join('')}</ul></div>`).join('');
}
function drawingsHtml() {
  const d = P.detail;
  const up = `<form class="card form" id="drForm" ${P.showDrUpload ? '' : 'hidden'}>
    <h3>Upload drawings and documents</h3>
    <label class="field">Files (PDF, DWFx, DWF, DWG, DXF, images, XLSX, DOCX; up to 20 at once)<input type="file" id="drFiles" multiple required></label>
    <div class="progress" id="drProg" hidden><div></div></div>
    <div class="actions"><button type="button" class="btn" id="drCancel">Cancel</button><button class="btn primary">Upload</button></div>
    <div id="drErr" class="msg bad" hidden></div></form>`;
  if (!d.drawings.length) return up + '<div class="empty-state"><p>No drawings yet. Upload the drawing set so the team keeps everything for this project in one place.</p></div>';
  return up + `<table class="tbl"><thead><tr><th>Name</th><th>Size</th><th>Uploaded</th><th></th></tr></thead><tbody>${d.drawings.map(x => `
    <tr><td class="wrap">${esc(x.name)}</td><td class="num">${fmtBytes(Number(x.size))}</td><td class="small">${fmtDay(x.created_at)}<br><span class="muted">${esc(x.uploaded_by || '')}</span></td>
    <td class="right">${canView(x.name) ? `<button class="btn small" data-view="${x.id}">View</button> ` : ''}<button class="btn small" data-dl="${x.id}" data-name="${esc(x.name)}">Download</button>${can('editor') ? ` <button class="btn small subtle danger-text" data-deld="${x.id}" data-name="${esc(x.name)}">Delete</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
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
      <p class="muted small">Editors can upload and measure. Viewers can open and download. Owners also manage the team and can delete the project. Only people in your user list can be added.</p>` : ''}`;
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
  box().querySelectorAll('[data-view]').forEach(b => b.onclick = () => openDrawing(d.drawings.find(x => x.id === b.dataset.view)));
  box().querySelectorAll('[data-sheets]').forEach(b => b.onclick = () => {
    const v = d.models.flatMap(m => m.versions).find(x => x.id === b.dataset.sheets);
    const list = v.stats.sheets;
    if (list.length === 1) return openDrawing({ kind: 'sheet', versionId: v.id, index: list[0].index, name: list[0].name });
    confirmBox({ title: '2D sheets', body: `<ul class="check-list">${list.map(sh => `<li><span class="grow">${esc(sh.name)}</span><button class="btn small" data-sh="${sh.index}">View</button></li>`).join('')}</ul>`, confirmLabel: 'Close' });
    document.querySelectorAll('#dialog [data-sh]').forEach(x => x.onclick = () => { $('dlgNo').click(); const sh = list.find(y => y.index === +x.dataset.sh); openDrawing({ kind: 'sheet', versionId: v.id, index: sh.index, name: sh.name }); });
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
      const fd = new FormData(); fd.append('model', f, f.name); fd.append('modelName', $('upName').value); fd.append('discipline', $('upDisc').value); fd.append('note', $('upNote').value);
      $('upGo').disabled = true; $('upErr').hidden = true; const bar = $('upProg'); bar.hidden = false;
      try {
        await upload(`/projects/${pid}/models`, fd, (x) => { bar.firstElementChild.style.width = Math.round(x * 100) + '%'; });
        P.showUpload = false; status(`${f.name} uploaded. Processing has started.`, 'ok'); await openProject(pid, true);
      } catch (err) { $('upErr').hidden = false; $('upErr').textContent = err.message; $('upGo').disabled = false; bar.hidden = true; }
    };
  }
  box().querySelectorAll('[data-open]').forEach(b => b.onclick = () => {
    const m = d.models.find(x => x.versions.some(v => v.id === b.dataset.open)), v = m.versions.find(x => x.id === b.dataset.open);
    App.openVersion(b.dataset.open, `${m.name} v${v.version} · ${v.file_name}`);
  });
  box().querySelectorAll('[data-src]').forEach(b => b.onclick = () => dl(`/versions/${b.dataset.src}/source`, b.dataset.name));
  box().querySelectorAll('[data-re]').forEach(b => b.onclick = async () => { await api('POST', `/versions/${b.dataset.re}/reprocess`); openProject(pid, true); });
  box().querySelectorAll('[data-delv]').forEach(b => b.onclick = async () => {
    if (!await confirmBox({ title: `Delete ${b.dataset.label}?`, body: '<p>The DWFx file and its processed data are deleted from the server. Saved take-off groups stay but lose the link to this version.</p>', confirmLabel: 'Delete version', danger: true })) return;
    await act(() => api('DELETE', `/versions/${b.dataset.delv}`), `${b.dataset.label} deleted.`);
  });
  // drawings
  $('drToggle') && ($('drToggle').onclick = () => { P.open.add('drawings'); P.showDrUpload = true; renderDetail(); $('drFiles')?.focus(); });
  if ($('drForm')) {
    $('drCancel').onclick = () => { P.showDrUpload = false; renderDetail(); };
    $('drForm').onsubmit = async (e) => {
      e.preventDefault();
      const files = [...$('drFiles').files]; if (!files.length) return;
      const fd = new FormData(); files.forEach(f => fd.append('files', f, f.name));
      const bar = $('drProg'); bar.hidden = false; $('drErr').hidden = true;
      try {
        await upload(`/projects/${pid}/drawings`, fd, (x) => { bar.firstElementChild.style.width = Math.round(x * 100) + '%'; });
        P.showDrUpload = false; status(`${files.length} file${files.length > 1 ? 's' : ''} uploaded.`, 'ok'); openProject(pid, true);
      } catch (err) { $('drErr').hidden = false; $('drErr').textContent = err.message; bar.hidden = true; }
    };
  }
  box().querySelectorAll('[data-dl]').forEach(b => b.onclick = () => dl(`/drawings/${b.dataset.dl}/file`, b.dataset.name));
  box().querySelectorAll('[data-deld]').forEach(b => b.onclick = async () => {
    if (!await confirmBox({ title: `Delete ${b.dataset.name}?`, body: '<p>The file is deleted from the server.</p>', confirmLabel: 'Delete', danger: true })) return;
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
  const busy = P.detail?.models.some(m => m.versions.some(v => ['queued', 'processing'].includes(v.status)));
  if (busy) P.poll = setTimeout(() => P.detail && openProject(P.detail.project.id, true), 2500);
}
function stopPoll() { if (P.poll) clearTimeout(P.poll); P.poll = null; }
export function resetProjects() { stopPoll(); P.detail = null; P.list = []; P.users = null; P.filter = ''; App.setContext?.(); }
export const refreshProject = () => P.detail && openProject(P.detail.project.id, true);
