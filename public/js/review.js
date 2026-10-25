// Review tab: model checks, measured status, AI take-off check, revision compare and take-off update,
// BOQ sheet, audit PDF and exports.
import { $, esc, App, api, status, downloadFile, fmtBytes, fmtDate, confirmBox } from './core.js';
import { fmt } from './engine.js';
import { S } from './state.js';
import { evaluate, missingDataReport, overlapReport, applyFilter } from './measure.js';
import { selectIds, setColorMode, update, viewer } from './model.js';
import { readGroups, updateGroupInPlace, writeChangeLog, buildBOQ, addToExcel, loadMeasured } from './excel.js';

const R = { open: new Set(['checks']), compare: null, checkResult: null, overlaps: null };

export function renderReview() {
  const box = $('reviewBody');
  const sec = (key, title, body) => `<section class="sec"><div class="sec-h"><button class="sec-t" data-rsec="${key}" aria-expanded="${R.open.has(key)}"><span class="chev" aria-hidden="true">${R.open.has(key) ? '▾' : '▸'}</span>${title}</button></div>${R.open.has(key) ? `<div class="sec-b" id="rs-${key}">${body}</div>` : ''}</section>`;
  if (!S.data) { box.innerHTML = '<div class="empty">Open a model in Project &amp; Models to check, compare and report the take-off.</div>'; return; }
  box.innerHTML = sec('checks', 'Model checks and measured status', checksHtml()) +
    sec('aicheck', 'AI take-off check', aiCheckHtml()) +
    sec('revisions', 'Revisions: compare and update', '<div class="loading">Loading versions…</div>') +
    sec('output', 'Output: BOQ sheet and audit PDF', '<div class="loading">Loading…</div>');
  box.querySelectorAll('[data-rsec]').forEach(b => b.onclick = () => { R.open.has(b.dataset.rsec) ? R.open.delete(b.dataset.rsec) : R.open.add(b.dataset.rsec); renderReview(); });
  if (R.open.has('checks')) wireChecks();
  if (R.open.has('aicheck')) wireAICheck();
  if (R.open.has('revisions')) renderRevisions();
  if (R.open.has('output')) renderOutput();
}

// ================================================================== checks
function checksHtml() {
  const rep = missingDataReport();
  return `<h3>Missing data</h3><ul class="check-list">${rep.map((r, i) => `<li><span class="pill ${r.ids.length ? 'neutral' : 'ok'}">${r.ids.length}</span><span class="grow" title="${esc(r.hint)}">${esc(r.label)}</span>${r.ids.length ? `<button class="btn small" data-miss="${i}">Select</button>` : ''}</li>`).join('')}</ul>
    <h3 style="margin-top:12px">Measured status</h3>
    <p class="hint">Colours the model from the ${S.inExcel ? 'Take-off sheet' : 'take-off list'}: green measured once, purple measured twice or more (possible double count), red not measured.</p>
    <div class="row"><button class="btn" id="msShow">Colour by measured status</button><button class="btn" id="msNot">Select not measured</button><button class="btn" id="msTwice">Select measured twice</button></div>
    <div id="msOut"></div>
    <h3 style="margin-top:12px">Overlapping concrete</h3>
    <p class="hint">Finds beams, columns, slabs, walls and foundations whose boxes mostly overlap: duplicates in the model or elements that would be counted twice.</p>
    <div class="row"><button class="btn" id="ovRun">Run overlap check</button></div><div id="ovOut"></div>`;
}
function wireChecks() {
  const rep = missingDataReport();
  document.querySelectorAll('[data-miss]').forEach(b => b.onclick = () => selectIds(rep[+b.dataset.miss].ids));
  const ms = async () => { await loadMeasured(); const m = S.measured; let once = 0, twice = 0; S.E.forEach(e => { const n = m.get(e.id) || 0; if (n === 1) once++; else if (n > 1) twice++; });
    $('msOut').innerHTML = `<div class="kpis"><div class="kpi add"><b>${once}</b><span>measured once</span></div><div class="kpi chg"><b>${twice}</b><span>twice or more</span></div><div class="kpi rem"><b>${S.E.length - once - twice}</b><span>not measured</span></div></div>`; };
  $('msShow').onclick = async () => { await setColorMode('measured'); await ms(); };
  $('msNot').onclick = async () => { await ms(); selectIds(S.E.filter(e => !S.measured.get(e.id)).map(e => e.id)); };
  $('msTwice').onclick = async () => { await ms(); selectIds(S.E.filter(e => (S.measured.get(e.id) || 0) > 1).map(e => e.id)); };
  $('ovRun').onclick = () => {
    R.overlaps = overlapReport();
    $('ovOut').innerHTML = R.overlaps.length ? `<p class="hint">${R.overlaps.length} pair${R.overlaps.length > 1 ? 's' : ''} found${R.overlaps.length >= 200 ? ' (first 200)' : ''}. Same-type pairs first: those are usually duplicates.</p>
      <ul class="check-list">${R.overlaps.slice(0, 200).map((o, i) => `<li><span class="pill ${o.same ? 'bad' : 'neutral'}">${Math.round(o.share * 100)}%</span><span class="grow" title="${esc(o.label)}">${esc(o.label)}</span><button class="btn small" data-ov="${i}">Show</button></li>`).join('')}</ul>`
      : '<div class="msg ok">No overlapping concrete elements found.</div>';
    $('ovOut').querySelectorAll('[data-ov]').forEach(b => b.onclick = () => { const o = R.overlaps[+b.dataset.ov]; selectIds([o.a, o.b]); });
  };
}

// ================================================================== AI check
function aiCheckHtml() {
  return `<p class="hint">The AI reviews the take-off like a BOQ error review: missing items, odd values, unit mistakes, double counting and unmeasured elements. It sees names, totals and assumptions, never the file.</p>
    <div class="row"><button class="btn primary" id="acRun">Check the take-off</button></div><div id="acOut">${R.checkResult ? findingsHtml(R.checkResult) : ''}</div>`;
}
function findingsHtml(r) {
  return `${r.summary ? `<p>${esc(r.summary)}</p>` : ''}${r.findings.length ? r.findings.map(f => `<div class="finding ${esc(f.severity || 'low')}"><strong>${esc(f.issue)}</strong>${f.group ? ` <span class="muted">· ${esc(f.group)}</span>` : ''}<div class="muted">${esc(f.suggestion || '')}</div></div>`).join('') : '<div class="msg ok">No problems found.</div>'}`;
}
function wireAICheck() {
  $('acRun').onclick = async () => {
    const out = $('acOut'); out.innerHTML = '<div class="loading">Reviewing the take-off…</div><div class="progress indet"><div></div></div>';
    try {
      const groups = await getGroups();
      if (!groups.length) { out.innerHTML = '<div class="msg bad">There are no take-off groups yet.</div>'; return; }
      const payload = groups.map(g => ({ ref: g.ref, name: g.name, elements: g.ids.length, categories: cats(g.ids), types: types(g.ids), note: g.method?.note || '',
        formulas: (g.method?.formulas || []).map(f => `${f.label} (${f.unit}) = ${f.expr}`), assumptions: g.constants.map(c => `${c.label} = ${c.value} ${c.unit}`),
        totals: Object.entries(g.totals).map(([l, v]) => `${l}: ${typeof v === 'number' ? +v.toFixed(3) : v}`) }));
      const measured = new Set(groups.flatMap(g => g.ids));
      const unmeasured = {}; S.E.filter(e => !measured.has(e.id)).forEach(e => { unmeasured[e.cat] = (unmeasured[e.cat] || 0) + 1; });
      R.checkResult = await api('POST', '/ai/check', { versionId: S.versionId, groups: [...payload, { ref: 'model', name: 'Elements not in any group (count by category)', unmeasured }] });
      out.innerHTML = findingsHtml(R.checkResult);
    } catch (err) { out.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; }
  };
}
const cats = (ids) => [...new Set(ids.map(id => S.byId.get(id)?.cat).filter(Boolean))].join(', ');
const types = (ids) => [...new Set(ids.map(id => S.byId.get(id)?.type).filter(Boolean))].slice(0, 12).join(', ');

/** Groups from the Take-off sheet (Excel) or the take-off list (browser), in one shape. */
export async function getGroups() {
  if (S.inExcel) return (await readGroups()).map(g => ({ ...g, method: g.meta?.method || null }));
  return S.takeoff.map((spec, i) => {
    const { tot, missing } = evaluate(spec);
    const cols = [...spec.inputs, ...spec.formulas];
    const totals = {}, units = {};
    cols.forEach(c => { const l = `${c.label} (${c.unit})`; if (tot[c.key] != null) totals[l] = tot[c.key]; units[l] = c.unit; });
    return { ref: 'G' + (i + 1), name: spec.name, ids: spec.ids, labels: Object.keys(units), totals, units, constants: spec.constants.map(c => ({ ...c })), method: spec, missing };
  });
}

// ================================================================== revisions
async function renderRevisions() {
  const box = $('rs-revisions'); if (!box) return;
  const p = App.currentProject?.();
  if (!p || !S.versionId) { box.innerHTML = '<p class="hint">Revisions work with models saved in a project. Upload each revision as a new version of the same model.</p>'; return; }
  const versions = p.models.flatMap(m => m.versions.filter(v => v.status === 'ready').map(v => ({ id: v.id, label: `${m.name} v${v.version} · ${v.file_name}`, model: m.id, n: v.version })));
  const cur = versions.find(v => v.id === S.versionId);
  const prev = versions.filter(v => v.model === cur?.model && v.n < cur.n).sort((a, b) => b.n - a.n)[0];
  const opt = (sel) => versions.map(v => `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
  box.innerHTML = `<div class="two"><label class="field">From (older)<select class="input" id="cmpFrom">${opt(prev?.id || versions[0]?.id)}</select></label>
    <label class="field">To (newer)<select class="input" id="cmpTo">${opt(S.versionId)}</select></label></div>
    <div class="row"><button class="btn primary" id="cmpRun" ${versions.length > 1 ? '' : 'disabled'}>Compare</button>${versions.length > 1 ? '' : '<span class="hint">Upload a second version of the model to compare.</span>'}</div>
    <div id="cmpOut">${R.compare ? compareHtml(R.compare) : ''}</div>
    <h3 style="margin-top:14px">Update the take-off to the open version</h3>
    <p class="hint">Re-measures groups made on an older version, by Revit ID: removed elements drop out, changed ones are re-measured, and new elements are added when the group was made from a template or the AI (it keeps its filter). Formulas and your assumption values are kept, and a Change log sheet records the difference.</p>
    <div id="updOut"><div class="loading">Looking for groups…</div></div>`;
  $('cmpRun').onclick = async () => {
    const from = $('cmpFrom').value, to = $('cmpTo').value;
    if (from === to) { status('Choose two different versions.', 'bad'); return; }
    $('cmpOut').innerHTML = '<div class="loading">Comparing…</div>';
    try { R.compare = await api('GET', `/compare?from=${from}&to=${to}`); S.compare = R.compare; $('cmpOut').innerHTML = compareHtml(R.compare); wireCompare(); }
    catch (err) { $('cmpOut').innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; }
  };
  if (R.compare) wireCompare();
  renderUpdateList();
}
function compareHtml(c) {
  const s = c.summary;
  return `<div class="kpis"><div class="kpi add"><b>${s.added}</b><span>added</span></div><div class="kpi rem"><b>${s.removed}</b><span>removed</span></div><div class="kpi chg"><b>${s.changed}</b><span>changed</span></div><div class="kpi"><b>${s.unchanged}</b><span>unchanged</span></div></div>
    <p class="hint">${esc(c.from.label)} → ${esc(c.to.label)}</p>
    <div class="row"><button class="btn" id="cmpColor">Colour the model by changes</button>${S.versionId === c.to.id ? '<button class="btn" id="cmpSelAdd">Select added</button><button class="btn" id="cmpSelChg">Select changed</button>' : ''}${S.versionId === c.from.id ? '<button class="btn" id="cmpSelRem">Select removed</button>' : ''}</div>
    ${c.byCategory.length ? `<table class="tbl"><thead><tr><th>Category</th><th class="num">Added</th><th class="num">Removed</th><th class="num">Changed</th></tr></thead><tbody>${c.byCategory.map(r => `<tr><td>${esc(r.category)}</td><td class="num">${r.added}</td><td class="num">${r.removed}</td><td class="num">${r.changed}</td></tr>`).join('')}</tbody></table>` : ''}
    ${c.quantities.length ? `<h4>Quantity differences</h4><div class="tscroll"><table class="tbl"><thead><tr><th>Category</th><th>Quantity</th><th class="num">Before</th><th class="num">After</th><th class="num">Change</th></tr></thead><tbody>${c.quantities.slice(0, 80).map(r => `<tr><td>${esc(r.category)}</td><td>${esc(r.quantity)}</td><td class="num">${fmt(r.from)}</td><td class="num">${fmt(r.to)}</td><td class="num" style="color:${r.delta > 0 ? 'var(--ok)' : 'var(--bad)'}">${r.delta > 0 ? '+' : ''}${fmt(r.delta)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${c.changed.length ? `<details class="box"><summary>Changed elements (${c.changed.length})</summary><ul class="check-list">${c.changed.slice(0, 150).map(x => `<li><span class="grow" title="${esc(x.changes.map(ch => ch.field).join(', '))}">${esc(x.type)} [${x.id}] · ${esc(x.changes.slice(0, 3).map(ch => ch.field + (ch.delta != null ? ` ${ch.delta > 0 ? '+' : ''}${fmt(ch.delta)}` : '')).join('; '))}</span>${S.byId.has(x.id) ? `<button class="btn small" data-show="${x.id}">Show</button>` : ''}</li>`).join('')}</ul></details>` : ''}
    ${c.added.length ? `<details class="box"><summary>Added elements (${c.added.length})</summary><ul class="check-list">${c.added.slice(0, 150).map(x => `<li><span class="grow">${esc(x.cat)} · ${esc(x.type)} [${x.id}] ${esc(x.level)}</span>${S.byId.has(x.id) ? `<button class="btn small" data-show="${x.id}">Show</button>` : ''}</li>`).join('')}</ul></details>` : ''}
    ${c.removed.length ? `<details class="box"><summary>Removed elements (${c.removed.length})</summary><ul class="check-list">${c.removed.slice(0, 150).map(x => `<li><span class="grow">${esc(x.cat)} · ${esc(x.type)} [${x.id}] ${esc(x.level)}</span>${S.byId.has(x.id) ? `<button class="btn small" data-show="${x.id}">Show</button>` : ''}</li>`).join('')}</ul></details>` : ''}`;
}
function wireCompare() {
  const c = R.compare;
  $('cmpColor') && ($('cmpColor').onclick = () => setColorMode('revision'));
  $('cmpSelAdd') && ($('cmpSelAdd').onclick = () => selectIds(c.added.map(x => x.id).filter(id => S.byId.has(id))));
  $('cmpSelChg') && ($('cmpSelChg').onclick = () => selectIds(c.changed.map(x => x.id).filter(id => S.byId.has(id))));
  $('cmpSelRem') && ($('cmpSelRem').onclick = () => selectIds(c.removed.map(x => x.id).filter(id => S.byId.has(id))));
  document.querySelectorAll('#cmpOut [data-show]').forEach(b => b.onclick = () => selectIds([+b.dataset.show]));
}
async function renderUpdateList() {
  const out = $('updOut'); if (!out) return;
  const p = App.currentProject();
  let items = [];
  try {
    if (S.inExcel) {
      const groups = await readGroups();
      items = groups.filter(g => g.meta?.method).map(g => ({ kind: 'sheet', ref: g.ref, name: g.name, versionId: g.meta.versionId, takeoffId: g.meta.takeoffId, method: g.meta.method, ids: g.ids, totals: g.totals }));
    } else {
      const all = (await api('GET', `/projects/${p.project.id}/takeoffs`)).takeoffs;
      items = all.map(t => ({ kind: 'server', ref: '', name: t.name, versionId: t.version_id, takeoffId: t.id, method: t.spec, ids: t.spec.ids || [], totals: {} }));
    }
  } catch (err) { out.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; return; }
  const stale = items.filter(i => i.versionId && i.versionId !== S.versionId);
  const label = (vid) => { for (const m of p.models) { const v = m.versions.find(x => x.id === vid); if (v) return `${m.name} v${v.version}`; } return 'another version'; };
  if (!stale.length) { out.innerHTML = `<div class="msg ok">${items.length ? 'Every group is already measured on the open version.' : 'No take-off groups made from a project model yet.'}</div>`; return; }
  out.innerHTML = `<ul class="check-list">${stale.map((it, i) => `<li><input type="checkbox" data-up="${i}" checked aria-label="Update ${esc(it.name)}"><span class="grow">${esc(it.ref ? it.ref + ' ' : '')}${esc(it.name)} <span class="muted">· ${esc(label(it.versionId))}${it.method.filter ? ' · keeps filter' : ''}</span></span></li>`).join('')}</ul>
    <div class="row"><button class="btn primary" id="updRun">Update selected groups</button></div>`;
  $('updRun').onclick = async () => {
    const chosen = [...out.querySelectorAll('[data-up]:checked')].map(c => stale[+c.dataset.up]);
    if (!chosen.length) return;
    if (!await confirmBox({ title: `Update ${chosen.length} group${chosen.length > 1 ? 's' : ''}?`, body: `<p>Each group is re-measured on <strong>${esc(S.label)}</strong>. ${S.inExcel ? 'The rows on the Take-off sheet are replaced in place; your assumption values are kept and BOQ links keep working.' : 'The saved copies are updated.'}</p>`, confirmLabel: 'Update' })) return;
    const log = [];
    for (const it of chosen) {
      try {
        const keep = it.ids.filter(id => S.byId.has(id));
        const fromFilter = it.method.filter ? applyFilter(it.method.filter) : [];
        const ids = [...new Set([...keep, ...fromFilter])];
        const spec = { ...it.method, ids, name: it.name };
        const added = ids.filter(id => !it.ids.includes(id)).length, removed = it.ids.length - keep.length;
        const changedSet = new Set((S.compare && S.compare.to.id === S.versionId ? S.compare.changed : []).map(x => x.id));
        const changed = keep.filter(id => changedSet.has(id)).length;
        if (it.kind === 'sheet') {
          await updateGroupInPlace(it.ref, spec, { takeoffId: it.takeoffId });
          const after = (await readGroups()).find(g => g.ref === it.ref);
          const cols = Object.keys(after?.totals || {});
          const date = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
          if (!cols.length) log.push([date, `${it.ref} ${it.name}`, S.label, added, removed, changed, '', '', '', '']);
          cols.forEach(cn => { const b = Number(it.totals[cn]) || 0, a = Number(after.totals[cn]) || 0; log.push([date, `${it.ref} ${it.name}`, S.label, added, removed, changed, cn, b, a, a - b]); });
        }
        if (it.takeoffId) await api('PATCH', `/takeoffs/${it.takeoffId}`, { spec, versionId: S.versionId, log: { added, removed, changed } });
      } catch (err) { status(`"${it.name}": ${err.message}`, 'bad'); return; }
    }
    if (log.length) await writeChangeLog(log);
    await App.refreshSummaries?.().catch(() => {});
    status(`${chosen.length} group${chosen.length > 1 ? 's' : ''} updated${log.length ? '; see the Change log sheet' : ''}.`, 'ok');
    App.refreshProject?.(); renderUpdateList();
  };
}

// ================================================================== output
async function renderOutput() {
  const box = $('rs-output'); if (!box) return;
  const p = App.currentProject?.();
  let groups = [];
  try { groups = await getGroups(); } catch (err) { box.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; return; }
  box.innerHTML = `<h3>Summary sheets</h3>
    ${S.inExcel ? (groups.length ? `<p class="hint">All built with formulas from the take-off: a Quantities register (SUMIFS), then the summaries you tick. Rates, allowances and GIFA you type are kept when you rebuild.</p>
      <div class="row wrap"><label><input type="checkbox" data-sm="summary" checked> Summary by level / zone</label>
        <label><input type="checkbox" data-sm="NRM2"> NRM2 summary</label><label><input type="checkbox" data-sm="POMI"> POMI summary</label>
        <label><input type="checkbox" data-sm="NRM1"> NRM1 elemental summary</label></div>
      <div class="row wrap"><label>Split by <select class="input" id="smBy" style="width:auto"><option value="level" ${S.summaryBy !== 'zone' && S.summaryBy !== 'none' ? 'selected' : ''}>Level</option><option value="zone" ${S.summaryBy === 'zone' ? 'selected' : ''}>Zone (tables with a Zone column)</option><option value="none" ${S.summaryBy === 'none' ? 'selected' : ''}>No split</option></select></label>
        <label>GIFA m² <input class="input" id="smGifa" type="number" min="0" step="any" style="width:100px" placeholder="optional"></label></div>
      <div class="row"><button class="btn primary" id="smRun">Build summary sheets</button></div>` : '<p class="hint">Add take-off groups first.</p>')
      : '<p class="hint">Summary sheets are built inside Excel.</p>'}
    <h3 style="margin-top:14px">BOQ sheet</h3>
    ${S.inExcel ? (groups.length ? `<p class="hint">Choose the quantities that become BOQ items. Each quantity links to its take-off total, so the BOQ updates when the take-off changes. Rates you have typed are kept when you rebuild.</p>
      <div class="tscroll"><ul class="check-list">${groups.map((g, gi) => g.labels.filter(l => g.totals[l] != null).map((l, li) => `<li><input type="checkbox" data-bq="${gi}|${li}" ${defaultTick(g, l) ? 'checked' : ''} aria-label="${esc(g.ref + ' ' + l)}">
        <span class="grow">${esc(g.ref)} ${esc(g.name)} · <strong>${esc(l)}</strong></span><span class="muted small">${fmt(Number(g.totals[l]) || 0)}</span></li>`).join('')).join('')}</ul></div>
      <label class="row"><input type="checkbox" id="bqAI"> Write the descriptions with the AI (house style from the project settings)</label>
      <div class="row"><button class="btn primary" id="bqRun">Build BOQ sheet</button></div>` : '<p class="hint">Add take-off groups first.</p>')
      : '<p class="hint">The BOQ sheet is built inside Excel. Open the add-in in Excel to use it.</p>'}
    <h3 style="margin-top:14px">Audit PDF</h3>
    <p class="hint">A PDF with the method, assumptions, element counts, totals and a 3D picture for every group, saved to the project for the team.</p>
    <label class="row"><input type="checkbox" id="apPics" checked> Include a 3D picture of each group</label>
    <div class="row"><button class="btn primary" id="apRun" ${groups.length && p ? '' : 'disabled'}>Create audit PDF</button>${p ? '' : '<span class="hint">Open a model from a project to save reports.</span>'}</div>
    <div id="apOut"></div>
    ${p ? '<h4>Saved reports</h4><div id="exList" class="loading">Loading…</div>' : ''}`;
  $('bqRun') && ($('bqRun').onclick = async () => {
    const picks = [...box.querySelectorAll('[data-bq]:checked')].map(c => c.dataset.bq.split('|').map(Number));
    if (!picks.length) { status('Tick at least one quantity.', 'bad'); return; }
    try { await boqFrom(groups, picks, $('bqAI').checked); } catch (err) { status(err.message, 'bad'); }
  });
  $('smRun') && ($('smRun').onclick = async () => {
    const kinds = [...box.querySelectorAll('[data-sm]:checked')].map(c => c.dataset.sm);
    const by = $('smBy').value; S.summaryBy = by;
    const gifa = Number($('smGifa').value) || null;
    $('smRun').disabled = true;
    try { await App.buildSummaries({ kinds, by, gifa }); } catch (err) { status(err.message, 'bad'); } finally { $('smRun').disabled = false; }
  });
  $('apRun') && ($('apRun').onclick = () => auditPdf(groups, $('apPics').checked));
  if (p) loadExports();
}
/** BOQ items from ticked group columns ([groupIndex, labelIndex]); optional AI descriptions. */
async function boqFrom(groups, picks, ai) {
  const items = picks.map(([gi, li], k) => {
    const g = groups[gi], l = g.labels.filter(x => g.totals[x] != null)[li];
    const mcols = [...(g.method?.inputs || []), ...(g.method?.formulas || [])];
    const byPos = mcols[g.labels.indexOf(l)];       // headings follow the method's column order
    const col = byPos && `${byPos.label} (${byPos.unit})` === l ? byPos : mcols.find(c => `${c.label} (${c.unit})` === l);
    const unit = (g.units[l] || '').replace('m2', 'm²').replace('m3', 'm³');
    return { item: `${g.ref}.${String.fromCharCode(97 + picks.filter(([x], j) => x === gi && j < k).length)}`, group: g, label: l, unit, heading: g.name,
      nameKey: col ? `TO_${g.ref}_${col.key}`.replace(/[^A-Za-z0-9_]/g, '_') : `'Take-off'!$${colLetter((g.dataStart ?? 7) + g.labels.indexOf(l))}$${g.totalRow}`,
      description: `${g.name}: ${l.replace(/ \([^)]*\)$/, '')}${col?.rule?.ref ? ` (${col.rule.ref})` : ''}` };
  });
  if (ai) {
    status('The AI is writing the BOQ descriptions…');
    const res = await api('POST', '/ai/describe', { projectId: App.currentProjectId?.(), items: items.map(it => ({ ref: it.item, group: it.group.name, quantity: it.label, unit: it.unit, categories: cats(it.group.ids), types: types(it.group.ids), method: it.group.method?.note || '', assumptions: it.group.constants.map(c => `${c.label} ${c.value} ${c.unit}`) })) });
    const by = new Map(res.items.map(x => [String(x.ref), x]));
    items.forEach(it => { const d = by.get(it.item); if (d) { it.description = d.description || it.description; it.heading = d.heading || it.heading; } });
  }
  await buildBOQ(items);
  status(`BOQ sheet built with ${items.length} item${items.length > 1 ? 's' : ''}, linked to the take-off totals.`, 'ok');
  return { items: items.length };
}
/** BOQ with the default choice of quantities (final results only); used by the 3D window and the AI. */
export async function buildBoqDefault({ ai = false } = {}) {
  if (!S.inExcel) throw new Error('The BOQ sheet is built inside Excel.');
  const groups = await getGroups();
  const picks = [];
  groups.forEach((g, gi) => g.labels.filter(l => g.totals[l] != null).forEach((l, li) => { if (defaultTick(g, l)) picks.push([gi, li]); }));
  if (!picks.length) throw new Error('There are no take-off totals for a BOQ yet.');
  return boqFrom(groups, picks, ai);
}
const colLetter = (n) => { let s = ''; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };
/** Tick final results only: formula columns no other formula uses (soffit + sides = total: only the total), or
 * the main summable quantities when the group has no formulas. Avoids double counting in the BOQ. */
function defaultTick(g, l) {
  const fs = g.method?.formulas || [];
  if (fs.length) {
    const f = fs.find(x => `${x.label} (${x.unit})` === l); if (!f) return false;
    return !fs.some(o => o !== f && String(o.expr).includes('{' + f.key + '}'));
  }
  return !/\(nr\)$/.test(l) && g.labels.filter(x => g.totals[x] != null && !/\(nr\)$/.test(x))[0] === l;
}
const isFormula = (g, l) => (g.method?.formulas || []).some(f => `${f.label} (${f.unit})` === l);

async function auditPdf(groups, pics) {
  const out = $('apOut'); const V = viewer();
  out.innerHTML = '<div class="loading">Preparing the report…</div><div class="progress indet"><div></div></div>';
  const saved = { ticked: new Set(S.ticked), isolated: S.isolated, view: V.getViewState() };
  try {
    const items = [];
    for (const g of groups) {
      let image = null;
      const inModel = g.ids.filter(id => V.hasGeometry(id));
      if (pics && inModel.length) {
        S.ticked = new Set(inModel); S.isolated = false; update(); V.fit(inModel);
        await new Promise(r => setTimeout(r, 120)); image = V.screenshot(1100);
      }
      items.push({ ref: g.ref, name: g.name, count: g.ids.length, categories: cats(g.ids), by: g.method?.by || '', note: g.method?.note || '',
        formulas: (g.method?.formulas || []).map(f => ({ label: f.label, unit: f.unit, expr: f.expr })),
        constants: g.constants.map(c => ({ label: c.label, value: c.value, unit: c.unit })),
        totals: g.labels.map(l => ({ label: l.replace(/ \([^)]*\)$/, ''), unit: g.units[l] || '', value: g.totals[l] ?? null })), image });
    }
    const checks = missingDataReport().filter(r => r.ids.length).map(r => `${r.label}: ${r.ids.length}`);
    const { export: x } = await api('POST', `/projects/${App.currentProjectId()}/exports/audit`, { model: S.label, groups: items, checks });
    out.innerHTML = `<div class="msg ok">Report saved: ${esc(x.name)}</div>`;
    loadExports();
    await downloadFile(`/exports/${x.id}/file`, x.name).catch(() => {});
  } catch (err) { out.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; }
  finally { S.ticked = saved.ticked; S.isolated = saved.isolated; update(); V.setViewState(saved.view); }
}
async function loadExports() {
  const el = $('exList'); if (!el) return;
  try {
    const { exports } = await api('GET', `/projects/${App.currentProjectId()}/exports`);
    el.className = '';
    el.innerHTML = exports.length ? `<table class="tbl"><tbody>${exports.map(x => `<tr><td class="wrap">${esc(x.name)}<br><span class="muted small">${fmtDate(x.created_at)} · ${esc(x.created_by || '')} · ${fmtBytes(Number(x.size))}</span></td>
      <td class="right"><button class="btn small" data-exd="${x.id}" data-name="${esc(x.name)}">Download</button> <button class="btn small subtle danger-text" data-exx="${x.id}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<p class="hint">No reports yet.</p>';
    el.querySelectorAll('[data-exd]').forEach(b => b.onclick = () => downloadFile(`/exports/${b.dataset.exd}/file`, b.dataset.name).catch(err => status(err.message, 'bad')));
    el.querySelectorAll('[data-exx]').forEach(b => b.onclick = async () => { try { await api('DELETE', `/exports/${b.dataset.exx}`); loadExports(); } catch (err) { status(err.message, 'bad'); } });
  } catch (err) { el.textContent = err.message; }
}

export function initReview() {
  App.renderReview = renderReview;
  App.addGroupToExcel = addToExcel;
  App.buildBoqDefault = buildBoqDefault;
}
