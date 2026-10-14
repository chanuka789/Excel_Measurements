// AI plans in the app: the answer, the rules it used, a checklist of actions (run after the user's OK when they change
// anything), custom take-off tables, and Undo. Shared by the task pane and the 3D / app window through a host object:
// host = { E(), byId(), ticked(), zoneOf(), project(), onProjectChanged(p), versionId(), canEdit(), inExcel(),
//          select(ids, fit), isolate(ids), hide(ids), showAll(), setView(v), colorBy(mode), viewState(), restoreView(s),
//          addSpec(spec) -> Promise<ref>, excel(cmd, data) -> Promise, refreshTree(), refreshZones(), checks(kind), status(msg, kind),
//          saveTemplate?(spec, filter) }
import { esc, api } from './core.js';
import { evaluate, keyOf, fmt } from './engine.js';
import { qsSetup } from './rules.js';
import { ITEMS, itemIds, itemSpecs } from './qsitems.js';
import { filterIds, matchFilter } from './filter.js';
import { mergeList } from './dims.js';
import { ACTIONS, actionKind, actionText, describeFilter } from './actdefs.js';

export const stepLabel = (t) => ({ test_item: 'Tested a measure item by the rules:', rule_info: 'Read the measurement rules:', project_state: 'Read the project set-up:', find_elements: 'Searched the model:', type_details: 'Read the quantities of a type:', test_plan: 'Tested the method on the model:', search_rules: 'Checked the QS rules:', list_templates: 'Looked at saved methods:', get_template: 'Opened a saved method:' })[t] || t;
const KIND_LABEL = { view: 'View', read: 'Check', write: 'Change', delete: 'Delete' };
const ICON = { wait: '○', run: '…', ok: '✓', bad: '✕', skip: '–' };

/** Custom plan group -> take-off spec (same rules as the task pane's specFromPlanGroup). */
export function specFromGroup(g, host) {
  const E = host.E();
  const ids = filterIds(E, g.filter || {}, host.ticked(), host.zoneOf?.());
  const byId = host.byId();
  const unitOf = (n) => { for (const id of ids) { const q = byId.get(id)?.q?.[n]; if (q) return q[1]; } return ''; };
  let inputs = (g.inputs || []).map(i => ({ key: keyOf(i.key || i.name || i.label), label: i.label || i.name || i.key, unit: i.unit || (i.source === 'count' ? 'nr' : 'm'),
    source: i.source || 'property', name: i.name, index: i.index, sum: i.sum ?? (i.source === 'count') }));
  if (!inputs.length && g.quantities) inputs = g.quantities.map(q => (/^count$/i.test(q) ? { key: 'Count', label: 'Count', unit: 'nr', source: 'count', sum: true }
    : { key: keyOf(q), label: q, unit: unitOf(q), source: 'property', name: q, sum: true }));
  const constants = (g.constants || []).map(c => ({ key: keyOf(c.key || c.label), label: c.label || c.key, value: Number(c.value) || 0, unit: c.unit || '' }));
  const formulas = (g.formulas || []).map((f, i) => ({ key: keyOf(f.key || 'F' + (i + 1)), label: f.label || f.key, unit: f.unit || '', expr: f.expr }));
  const one = ids.length ? byId.get(ids[0]) : null;
  return { name: g.name || (one ? one.type : 'Take-off group'), ids, by: g.group_by ?? g.by ?? 'type', note: g.note || '', inputs, constants, formulas,
    filter: g.filter && !g.filter.use_ticked ? g.filter : undefined };
}

// ------------------------------------------------------------------ running one action
async function tree(host) { return api('GET', `/projects/${host.projectId()}/tree`); }
const byName = (list, name) => list.find(x => x.name.toLowerCase() === String(name || '').trim().toLowerCase());
const needProject = (host) => { if (!host.projectId()) throw new Error('Open a model from a project first.'); };
const needEdit = (host) => { needProject(host); if (!host.canEdit()) throw new Error('You need editor access to this project.'); };
const idsOf = (host, f) => { const ids = filterIds(host.E(), f || {}, host.ticked(), host.zoneOf?.()); if (!ids.length) throw new Error(`No elements match: ${describeFilter(f)}.`); return ids; };

async function saveQs(host, body) {
  const p = host.project(); needEdit(host);
  const r = await api('PATCH', `/projects/${host.projectId()}/qs`, body);
  p.project.settings = { ...(p.project.settings || {}), qs: r.qs };
  host.onProjectChanged?.(p);
  return r.qs;
}

/** Runs one action. Returns { text, undo? } or throws. ctx: { plan, specs (custom groups) } */
export async function runAction(a, host, ctx = {}) {
  switch (a.do) {
    case 'select': { const ids = idsOf(host, a.filter); host.select(ids, true); return { text: `${ids.length} selected` }; }
    case 'isolate': { const ids = idsOf(host, a.filter); host.isolate(ids); return { text: `${ids.length} shown` }; }
    case 'hide': { const ids = idsOf(host, a.filter); host.hide(ids); return { text: `${ids.length} hidden` }; }
    case 'show_all': host.showAll(); return { text: 'all shown' };
    case 'view': host.setView(['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'].includes(a.view) ? a.view : 'iso'); return { text: 'done' };
    case 'color_by': host.colorBy(String(a.mode || 'category')); return { text: 'done' };
    case 'run_checks': return { text: await host.checks(a.check === 'overlaps' ? 'overlaps' : 'missing') };
    case 'set_rules': {
      if (!['NRM2', 'POMI', 'NRM1'].includes(a.rule_set)) throw new Error('Unknown rule set.');
      const before = qsSetup(host.project()?.project?.settings).ruleSet;
      await saveQs(host, { ruleSet: a.rule_set });
      return { text: `now ${a.rule_set}`, undo: () => saveQs(host, { ruleSet: before }) };
    }
    case 'qs_setup': {
      const before = qsSetup(host.project()?.project?.settings);
      const map = { ground_level: 'groundLevel', wp_upturn: 'wpUpturn', roof_upturn: 'roofUpturn', wp_under_ground: 'wpUnderGround', wp_foundation_sides: 'wpFoundationSides', wp_roof: 'wpRoof', earth_faced: 'earthFaced' };
      const body = {};
      Object.entries(map).forEach(([k, v]) => { if (a[k] !== undefined) body[v] = a[k]; });
      if (a.rates && typeof a.rates === 'object') body.rates = { ...before.rates, ...a.rates };
      if (!Object.keys(body).length) throw new Error('Nothing to change.');
      await saveQs(host, body);
      const back = {}; Object.keys(body).forEach(k => { back[k] = before[k]; });
      return { text: 'saved', undo: () => saveQs(host, back) };
    }
    case 'create_folder': {
      needEdit(host);
      const t = await tree(host), dims = t.folders.filter(f => f.kind === 'dim');
      const parent = a.parent ? byName(dims, a.parent) : null;
      if (a.parent && !parent) throw new Error(`There is no folder "${a.parent}".`);
      const dup = dims.find(f => f.name.toLowerCase() === String(a.name).toLowerCase() && (f.parent_id || null) === (parent?.id || null));
      if (dup) return { text: 'already there' };
      const { folder } = await api('POST', `/projects/${host.projectId()}/folders`, { kind: 'dim', name: a.name, parentId: parent?.id || null });
      host.refreshTree?.();
      return { text: 'created', undo: async () => { await api('DELETE', `/folders/${folder.id}`); host.refreshTree?.(); } };
    }
    case 'create_dim_group': {
      needEdit(host);
      const t = await tree(host);
      const folder = a.folder ? byName(t.folders.filter(f => f.kind === 'dim'), a.folder) : null;
      if (a.folder && !folder) throw new Error(`There is no folder "${a.folder}".`);
      const mtype = ['Count', 'Length', 'Area', 'Volume'].includes(a.mtype) ? a.mtype : 'Count';
      const ids = a.filter ? idsOf(host, a.filter) : [];
      const { group } = await api('POST', `/projects/${host.projectId()}/dimgroups`, { name: a.name, mtype, folderId: folder?.id || null, props: { quantity: a.quantity || undefined, display: mtype } });
      if (ids.length) await api('POST', `/dimgroups/${group.id}/items`, { ids, versionId: host.versionId() });
      host.refreshTree?.();
      return { text: `created with ${ids.length} objects`, undo: async () => { await api('DELETE', `/dimgroups/${group.id}`); host.refreshTree?.(); } };
    }
    case 'import_objects': {
      needEdit(host);
      const g = byName((await tree(host)).groups, a.group); if (!g) throw new Error(`There is no dimension group "${a.group}".`);
      const had = new Set(g.items.map(i => i.element_id));
      const ids = idsOf(host, a.filter).filter(id => !had.has(id));
      if (!ids.length) return { text: 'already in the group' };
      await api('POST', `/dimgroups/${g.id}/items`, { ids, versionId: host.versionId() });
      host.refreshTree?.();
      return { text: `${ids.length} added`, undo: async () => { const t2 = await tree(host); const g2 = t2.groups.find(x => x.id === g.id); const rm = (g2?.items || []).filter(i => ids.includes(i.element_id)).map(i => i.id); if (rm.length) await api('POST', `/dimgroups/${g.id}/items/remove`, { ids: rm }); host.refreshTree?.(); } };
    }
    case 'create_zone': {
      needEdit(host);
      const ids = idsOf(host, a.filter);
      const { zones } = await api('GET', `/projects/${host.projectId()}/zones`);
      const old = byName(zones, a.name);
      const color = /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : undefined;
      const { zone } = await api('POST', `/projects/${host.projectId()}/zones`, { name: a.name, color, ids });
      host.refreshZones?.();
      return { text: `${ids.length} elements`, undo: async () => {
        if (old) await api('POST', `/projects/${host.projectId()}/zones`, { name: old.name, color: old.color, ids: old.ids }); else await api('DELETE', `/zones/${zone.id}`);
        host.refreshZones?.();
      } };
    }
    case 'measure_item': {
      const item = ITEMS.find(i => i.id === a.item); if (!item) throw new Error(`Unknown measure item "${a.item}".`);
      const E = host.E(), byId = host.byId(), setup = qsSetup(host.project()?.project?.settings);
      let ids = itemIds(item, E, (f) => filterIds(E, f, host.ticked(), host.zoneOf?.()));
      if (a.filter) { const keep = new Set(filterIds(E, a.filter, host.ticked(), host.zoneOf?.())); ids = ids.filter(id => keep.has(id)); }
      if (!ids.length) throw new Error(`No elements for "${item.name}"${a.filter ? ` with ${describeFilter(a.filter)}` : ''}.`);
      const specs = itemSpecs(item, ids, byId, { set: setup.ruleSet, setup: host.project()?.project?.settings?.qs || {}, elements: E });
      const refs = [];
      for (const sp of specs) { if (a.name) sp.name = `${a.name} - ${sp.name}`; refs.push(await host.addSpec(sp)); }
      return { text: `${specs.length} table${specs.length === 1 ? '' : 's'} (${[...new Set(refs.filter(Boolean))].join(', ') || 'list'})` };
    }
    case 'add_groups': {
      const specs = ctx.specs || [];
      if (!specs.length) throw new Error('This plan has no custom tables.');
      const refs = [];
      for (const sp of specs) { if (sp.ids.length) refs.push(await host.addSpec(sp)); }
      return { text: `${refs.length} table${refs.length === 1 ? '' : 's'}` };
    }
    case 'build_summaries': {
      const kinds = (Array.isArray(a.kinds) ? a.kinds : ['summary']).filter(k => ['summary', 'NRM2', 'POMI', 'NRM1'].includes(k));
      const before = new Set((await host.excel('workbook')).sheets || []);
      const r = await host.excel('buildSummaries', { kinds: kinds.length ? kinds : ['summary'], by: ['level', 'zone', 'none'].includes(a.by) ? a.by : 'level', gifa: Number(a.gifa) || null });
      const created = (r.sheets || []).filter(n => !before.has(n));
      return { text: `${(r.sheets || []).join(', ')}`, undo: created.length ? async () => { for (const n of created) await host.excel('deleteSheet', { name: n }); } : null };
    }
    case 'new_sheet': {
      const r = await host.excel('customSheet', { def: a.sheet || {} });
      return { text: `${r.sheet} (${r.rows} rows)`, undo: r.replaced ? null : () => host.excel('deleteSheet', { name: r.sheet }) };
    }
    case 'build_boq': { const r = await host.excel('buildBoq', { ai: Boolean(a.ai_descriptions) }); return { text: `${r.items} items` }; }
    case 'delete_folder': {
      needEdit(host);
      const f = byName((await tree(host)).folders.filter(x => x.kind === 'dim'), a.name); if (!f) throw new Error(`There is no folder "${a.name}".`);
      await api('DELETE', `/folders/${f.id}`); host.refreshTree?.();
      return { text: 'deleted', undo: async () => { await api('POST', `/projects/${host.projectId()}/folders`, { kind: 'dim', name: f.name, parentId: f.parent_id || null }); host.refreshTree?.(); } };
    }
    case 'delete_dim_group': {
      needEdit(host);
      const g = byName((await tree(host)).groups, a.name); if (!g) throw new Error(`There is no dimension group "${a.name}".`);
      await api('DELETE', `/dimgroups/${g.id}`); host.refreshTree?.();
      return { text: 'deleted', undo: async () => {
        const { group } = await api('POST', `/projects/${host.projectId()}/dimgroups`, { name: g.name, mtype: g.mtype, folderId: g.folder_id, props: g.props });
        const byVer = new Map(); g.items.forEach(i => { const k = `${i.version_id}|${i.sign}`; if (!byVer.has(k)) byVer.set(k, []); byVer.get(k).push(i.element_id); });
        for (const [k, ids] of byVer) { const [vid, sign] = k.split('|'); await api('POST', `/dimgroups/${group.id}/items`, { ids, versionId: vid === 'null' ? null : vid, sign: Number(sign) }); }
        host.refreshTree?.();
      } };
    }
    case 'delete_zone': {
      needEdit(host);
      const z = byName((await api('GET', `/projects/${host.projectId()}/zones`)).zones, a.name); if (!z) throw new Error(`There is no zone "${a.name}".`);
      await api('DELETE', `/zones/${z.id}`); host.refreshZones?.();
      return { text: 'deleted', undo: async () => { await api('POST', `/projects/${host.projectId()}/zones`, { name: z.name, color: z.color, ids: z.ids }); host.refreshZones?.(); } };
    }
    case 'delete_sheet': { await host.excel('deleteSheet', { name: a.name }); return { text: 'deleted (use Excel Undo to restore)' }; }
    default: throw new Error(`Unknown action ${a.do}.`);
  }
}

// ------------------------------------------------------------------ the plan card
/**
 * Render an AI answer into box. data: { plan, model, provider, steps }. Returns nothing; everything is wired here.
 */
export function renderPlan(box, data, host, { stepLabel = (t) => t, onAnswer = null } = {}) {
  const { plan = {}, model, provider, steps = [] } = data || {};
  box.innerHTML = '';
  const add = (html) => box.insertAdjacentHTML('beforeend', html);
  if (plan.message) add(`<div class="aimsg">${esc(plan.message)}</div>`);
  if (plan.question) {
    add(`<div class="msg ok"><strong>Question:</strong> ${esc(plan.question)}</div>`);
    if (onAnswer) {
      const f = document.createElement('form'); f.className = 'inline-form';
      f.innerHTML = '<input class="input" placeholder="Your answer" aria-label="Your answer" required><button class="btn primary">Answer</button>';
      f.onsubmit = (e) => { e.preventDefault(); onAnswer(f.querySelector('input').value.trim()); };
      box.append(f);
    }
  }
  if ((plan.rules_used || []).length) add(`<div class="card"><h3>Rules used</h3><ul class="rules-used">${plan.rules_used.map(r => `<li><span class="badge">${esc(r.ref)}</span> ${esc(r.use)}</li>`).join('')}</ul></div>`);
  if (steps.length) add(`<details class="box"><summary>How the AI worked it out (${steps.length} step${steps.length > 1 ? 's' : ''})</summary>
    <ol class="steps">${steps.map(s => `<li><strong>${esc(stepLabel(s.tool))}</strong> ${esc(s.result || '')}</li>`).join('')}</ol></details>`);
  const specs = mergeList((plan.groups || []).map(g => specFromGroup(g, host)));
  const actions = (plan.actions || []).filter(a => ACTIONS[a.do]).map(a => (a.do === 'measure_item' ? { ...a, itemName: ITEMS.find(i => i.id === a.item)?.name } : a));
  if (actions.length) renderActions(box, actions, host, { specs });
  specs.forEach(spec => groupCard(box, spec, host, { auto: actions.some(a => a.do === 'add_groups') }));
  if (!specs.length && !actions.length && !plan.message && !plan.question) add('<div class="aimsg">The AI did not return a plan. Describe what you want more clearly.</div>');
  if (plan.dropped?.length) add(`<div class="hint">Left out (not something the app can do): ${esc(plan.dropped.join(', '))}</div>`);
  if (model) add(`<div class="hint">AI: ${esc(provider || '')} ${esc(model)}. The AI chose the elements, the rules and the method; every number is calculated by the add-in from the model.</div>`);
}

function renderActions(box, actions, host, ctx) {
  const card = document.createElement('div'); card.className = 'card ai-actions'; box.append(card);
  const state = actions.map(() => ({ on: true, st: 'wait', note: '' }));
  const changes = actions.some(a => ['write', 'delete'].includes(actionKind(a)));
  const undos = [];
  let ran = false, running = false;
  const draw = () => {
    card.innerHTML = `<h3>Plan (${actions.length} step${actions.length === 1 ? '' : 's'})</h3>
      ${changes && !ran ? '<p class="hint">Untick a step to skip it. Nothing changes until you press Run.</p>' : ''}
      <ol class="plan">${actions.map((a, i) => { const k = actionKind(a), s = state[i]; return `<li class="pa ${k} ${s.st}">
        <label><input type="checkbox" data-pa="${i}" ${s.on ? 'checked' : ''} ${ran || running ? 'disabled' : ''} aria-label="Run this step">
        <span class="pi" aria-hidden="true">${ICON[s.st]}</span><span class="badge ${k === 'delete' ? 'bad' : k === 'write' ? '' : 'ok'}">${KIND_LABEL[k]}</span>
        <span class="pt">${esc(actionText(a))}</span></label>
        ${a.why || a.rule ? `<div class="hint">${esc(a.why || '')}${a.rule ? ` <span class="badge">${esc(a.rule)}</span>` : ''}</div>` : ''}
        ${s.note ? `<div class="hint ${s.st === 'bad' ? 'bad-text' : ''}">${esc(s.note)}</div>` : ''}</li>`; }).join('')}</ol>
      <div class="row">${!ran ? `<button class="btn primary" data-run ${running ? 'disabled' : ''}>${changes ? 'Run' : 'Run again'}</button>` : ''}
        ${ran && undos.length ? '<button class="btn" data-undo>Undo these changes</button>' : ''}</div>`;
    card.querySelectorAll('[data-pa]').forEach(c => c.onchange = () => { state[+c.dataset.pa].on = c.checked; });
    const run = card.querySelector('[data-run]'); if (run) run.onclick = go;
    const un = card.querySelector('[data-undo]'); if (un) un.onclick = undo;
  };
  async function go() {
    if (running) return; running = true; draw();
    let failed = false;
    for (let i = 0; i < actions.length; i++) {
      if (!state[i].on) { state[i].st = 'skip'; continue; }
      if (failed && ['write', 'delete'].includes(actionKind(actions[i]))) { state[i].st = 'skip'; state[i].note = 'Skipped because an earlier step failed.'; continue; }
      state[i].st = 'run'; draw();
      try {
        const r = await runAction(actions[i], host, ctx);
        state[i].st = 'ok'; state[i].note = r.text || '';
        if (r.undo) undos.push({ i, fn: r.undo });
      } catch (err) { state[i].st = 'bad'; state[i].note = err.message; failed = true; }
      draw();
    }
    running = false; ran = changes; draw();
    host.status(failed ? 'Some steps did not run. See the plan.' : 'Plan done.', failed ? 'bad' : 'ok');
  }
  async function undo() {
    const list = undos.splice(0).reverse();
    let bad = 0;
    for (const u of list) { try { await u.fn(); state[u.i].note += ' (undone)'; } catch (err) { bad++; state[u.i].note += ` (undo failed: ${err.message})`; } }
    draw(); host.status(bad ? 'Some changes could not be undone.' : 'Changes undone. Excel tables added to the take-off stay; use Excel Undo for those.', bad ? 'bad' : 'ok');
  }
  draw();
  if (!changes) go();
}

function groupCard(box, spec, host, { auto = false } = {}) {
  const card = document.createElement('div'); card.className = 'card ai-card'; box.append(card);
  const draw = () => {
    let ev, err = '';
    try { ev = evaluate(spec, host.byId()); } catch (e) { err = e.message; }
    const cols = [...spec.inputs, ...spec.formulas], first = ev?.rows[0];
    card.innerHTML = `<h3>${esc(spec.name)}</h3>
      <div>${spec.ids.length} element${spec.ids.length === 1 ? '' : 's'} found${spec.by ? ` · sub-totals by ${esc(spec.by)}` : ''}</div>
      ${(spec.parts || []).length > 1 ? `<div class="hint">One table for the same elements: ${spec.parts.map(esc).join(', ')}.</div>` : ''}
      ${spec.note ? `<div class="note">Method: ${esc(spec.note)}</div>` : ''}
      ${spec.formulas.map(f => `<div><code>${esc(f.label)} (${esc(f.unit)}) = ${esc(f.expr)}</code></div>`).join('')}
      ${spec.constants.length ? '<div class="note">Assumptions (you can also change them later in the yellow Excel cells):</div>' + spec.constants.map((c, i) =>
        `<div class="row"><label>${esc(c.label)} <input type="text" data-c="${i}" value="${c.value}" style="width:70px" aria-label="${esc(c.label)}"> ${esc(c.unit)}</label></div>`).join('') : ''}
      ${err ? `<div class="msg bad">${esc(err)}</div>` : `<table class="q"><thead><tr><th>Column</th><th style="text-align:right">Total</th><th style="text-align:right">1st element</th></tr></thead><tbody>
        ${cols.map(c => `<tr><td>${esc(c.label)} <span class="hint">${esc(c.unit)}</span>${ev.missing[c.key] ? ` <span class="hint">(${ev.missing[c.key]} missing)</span>` : ''}</td>
          <td class="v">${ev.tot[c.key] != null ? fmt(ev.tot[c.key], c.unit === 'nr' ? '' : c.unit) : ''}</td>
          <td class="v">${first && first.v[c.key] != null ? fmt(first.v[c.key], c.unit === 'nr' ? '' : c.unit) : ''}</td></tr>`).join('')}</tbody></table>`}
      <div class="row"><button data-a="tick">Show in model</button>${spec.ids.length && !err && !auto ? `<button class="primary" data-a="add">${host.inExcel() ? 'Add to Excel' : 'Add to list'}</button>` : ''}
        ${spec.ids.length && !err && host.saveTemplate ? '<button data-a="tpl" title="Save this method so the AI and the team can reuse it">Save as template</button>' : ''}</div>`;
    card.querySelectorAll('input[data-c]').forEach(inp => inp.onchange = () => { spec.constants[+inp.dataset.c].value = Number(inp.value) || 0; draw(); });
    card.querySelector('[data-a=tick]').onclick = () => host.select(spec.ids, true);
    const addB = card.querySelector('[data-a=add]');
    if (addB) addB.onclick = async () => { try { addB.disabled = true; await host.addSpec(spec); addB.textContent = 'Added'; } catch (e) { addB.disabled = false; host.status(e.message, 'bad'); } };
    const tpl = card.querySelector('[data-a=tpl]');
    if (tpl) tpl.onclick = async () => { try { await host.saveTemplate(spec); tpl.disabled = true; tpl.textContent = 'Saved'; } catch (e) { host.status(e.message, 'bad'); } };
  };
  draw();
}

/** Text answers for the checks action (shared). */
export function checksText(kind, E) {
  if (kind === 'overlaps') {
    const concrete = /structural (framing|columns|foundations)|^floors$|^walls$/i;
    const els = E.filter(e => e.bb && concrete.test(e.cat)).sort((a, b) => a.bb[0] - b.bb[0]);
    const vol = (b) => Math.max(b[3] - b[0], 0) * Math.max(b[4] - b[1], 0) * Math.max(b[5] - b[2], 0);
    let n = 0, same = 0;
    for (let i = 0; i < els.length && n < 500; i++) for (let j = i + 1; j < els.length && els[j].bb[0] <= els[i].bb[3]; j++) {
      const a = els[i], b = els[j]; let v = 1;
      for (let k = 0; k < 3; k++) { const d = Math.min(a.bb[k + 3], b.bb[k + 3]) - Math.max(a.bb[k], b.bb[k]); if (d <= 0.005) { v = 0; break; } v *= d; }
      const small = Math.min(vol(a.bb), vol(b.bb));
      if (v && small > 0.001 && v / small > 0.5) { n++; if (a.type === b.type) same++; }
    }
    return n ? `${n} pairs overlap heavily (${same} of the same type: possible duplicates). Net volumes already deduct overlaps.` : 'No heavy overlaps found.';
  }
  const noLevel = E.filter(e => !e.level).length, no3d = E.filter(e => !e.bb).length;
  const conc = E.filter(e => /structural (framing|columns|foundations)|^floors$|^walls$/i.test(e.cat));
  const noVol = conc.filter(e => !e.q?.Volume && !e.q?.['Geo volume'] && !e.q?.['Net volume']).length;
  return `${noLevel} without a level, ${no3d} without 3D geometry, ${noVol} concrete elements without a volume.`;
}
export { matchFilter };
