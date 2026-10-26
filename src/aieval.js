// QS test set for the AI: runs every request in tests/ai-eval.json against one model version and
// scores the plans. A provider or prompt change is accepted only if the score does not drop.
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { q, one } from './db.js';
import { versionProject } from './http.js';
import { loadModelData, applyFilter } from './modeldata.js';
import { runAgent, specFromGroup, aiConfig } from './ai.js';
import { templatesFor } from './features.js';
import { evaluate } from '../public/js/engine.js';
import { actionKind } from '../public/js/actdefs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function loadCases() {
  return JSON.parse(await fs.readFile(path.join(ROOT, 'tests', 'ai-eval.json'), 'utf8'));
}

/** Score one AI result. Returns { pass, reasons[] }. */
const WRITE = new Set(['write', 'delete']);
/** Does a plan action match an expected one? Strings match without case (or as a part), arrays match any value. */
function actionMatches(a, want, data, ticked) {
  if (a.do !== want.do) return false;
  for (const [k, v] of Object.entries(want)) {
    if (['do', 'categories', 'filter_levels'].includes(k)) continue;
    const got = a[k];
    if (Array.isArray(v)) { const g = Array.isArray(got) ? got.map(String) : [String(got ?? '')]; if (!v.some(x => g.some(y => y.toLowerCase() === String(x).toLowerCase()))) return false; }
    else if (typeof v === 'string') { if (!String(got ?? '').toLowerCase().includes(v.toLowerCase())) return false; }
    else if (typeof v === 'number') { if (Math.abs(Number(got) - v) > 1e-6) return false; }
    else if (typeof v === 'boolean') { if (Boolean(got) !== v) return false; }
  }
  if (want.categories) {
    const els = applyFilter(data.elements, a.filter || {}, ticked);
    if (!els.length || els.some(e => !want.categories.includes(e.cat))) return false;
  }
  return true;
}
function scoreActions(x, plan, data, ticked, why) {
  const acts = plan?.actions || [];
  // measuring structure into dimension groups is as good as a measure item (same rules, same quantities)
  const alias = (want) => (want.do === 'measure_item' && (!want.item || String(want.item).startsWith('st-')) ? [want, { do: 'create_structure_groups' }] : [want]);
  for (const want of x.actions || []) if (!alias(want).some(w => acts.some(a => actionMatches(a, w, data, ticked)))) why.push(`missing action ${want.do}${Object.keys(want).length > 1 ? ' ' + JSON.stringify(want) : ''}`);
  const structural = (x.items_any || []).some(i => i.startsWith('st-')) && acts.some(a => a.do === 'create_structure_groups');
  if (x.items_any && !structural && !acts.some(a => a.do === 'measure_item' && x.items_any.includes(a.item))) why.push('expected a measure item: ' + x.items_any.join(' / '));
  if (x.no_split_groups && acts.filter(a => a.do === 'create_dim_group' && /formwork|reinforc|rebar|waterproof/i.test(a.name || '')).length) why.push('made separate dimension groups for formwork / reinforcement / waterproofing');
  if (x.no_writes && acts.some(a => WRITE.has(actionKind(a)))) why.push('planned changes it should not make');
  if (x.no_deletes && acts.some(a => actionKind(a) === 'delete')) why.push('planned a delete that was not asked for');
  if (x.order) { const pos = x.order.map(d => { const i = acts.findIndex(a => a.do === d); return i < 0 && d === 'measure_item' ? acts.findIndex(a => a.do === 'create_structure_groups') : i; }); if (pos.some(p => p < 0) || pos.some((p, i) => i && p < pos[i - 1])) why.push('actions in the wrong order: expected ' + x.order.join(' > ')); }
  if (x.max_actions && acts.length > x.max_actions) why.push(`too many actions (${acts.length})`);
}
export function scoreCase(c, plan, data, ticked = []) {
  const x = c.expect || {}, why = [];
  const groups = plan?.groups || [];
  if (x.actions || x.items_any || x.no_writes || x.no_deletes || x.order) {
    scoreActions(x, plan, data, ticked, why);
    if (x.ask && !plan?.question) why.push('should have asked a question');
    if (!x.min_groups && !x.categories) return { pass: !why.length, reasons: why };
  }
  if (x.ask || x.no_groups) {
    if (groups.length && x.ask) why.push('should have asked a question instead of guessing');
    if (groups.length && x.no_groups) {
      // acceptable only if nothing in the model matches (the plan is empty in practice)
      const any = groups.some(g => applyFilter(data.elements, g.filter || {}, ticked).length);
      if (any) why.push('measured elements that do not answer the request');
    }
    if (!groups.length && !(plan?.message || plan?.question)) why.push('no explanation given');
    return { pass: !why.length, reasons: why };
  }
  if (groups.length < (x.min_groups || 1)) return { pass: false, reasons: ['no take-off groups returned' + (plan?.message ? `: ${plan.message}` : '')] };
  const cats = new Set(), inputNames = new Set(), exprs = [], consts = [];
  let formulas = 0;
  for (const g of groups) {
    const els = applyFilter(data.elements, g.filter || {}, ticked);
    if (!els.length) why.push(`group "${g.name}" matches no elements`);
    els.forEach(e => cats.add(e.cat));
    (g.inputs || []).forEach(i => inputNames.add(i.source === 'property' ? i.name : i.source));
    (g.formulas || []).forEach(f => exprs.push(String(f.expr || '') + ' ' + String(f.label || '')));
    (g.constants || []).forEach(k => consts.push(Number(k.value)));
    formulas += (g.formulas || []).length;
    try {
      const spec = specFromGroup(g, els);
      const { tot } = evaluate(spec, data.byId);
      if (els.length && !Object.values(tot).some(v => v != null && v !== 0)) why.push(`group "${g.name}" totals are all zero or empty`);
    } catch (err) { why.push(`group "${g.name}": ${err.message}`); }
    if (x.use_ticked && !g.filter?.use_ticked) why.push('did not use the selected elements');
    if (x.group_by && g.group_by !== x.group_by) why.push(`expected sub-totals by ${x.group_by}`);
  }
  if (x.categories) {
    const allowed = new Set(x.categories);
    const extra = [...cats].filter(cc => !allowed.has(cc));
    if (extra.length) why.push('measured other categories: ' + extra.join(', '));
    if (![...cats].some(cc => allowed.has(cc))) why.push('missed the expected category');
    if (x.min_cats && [...cats].filter(cc => allowed.has(cc)).length < x.min_cats) why.push(`expected at least ${x.min_cats} categories`);
  }
  for (const set of x.properties_any || []) if (!set.some(n => inputNames.has(n))) why.push('expected one of: ' + set.join(' / '));
  if (x.formula_any && !x.formula_any.some(re => exprs.some(e => new RegExp(re, 'i').test(e)))) why.push('formula does not follow the expected method');
  if (x.constant_any && !x.constant_any.some(v => consts.some(cv => Math.abs(cv - v) < 1e-9))) why.push('assumption value not kept as an editable constant: ' + x.constant_any.join(' or '));
  if (x.min_formulas && formulas < x.min_formulas) why.push(`expected at least ${x.min_formulas} formula columns`);
  return { pass: !why.length, reasons: why };
}

/** The project the test pretends to be in (set-up, folders, groups, zones, workbook). */
function evalState(c) {
  const st = c.state || {};
  return { setup: { groundLevel: st.groundLevel ?? null, wpUpturn: 0.15, roofUpturn: 0.3, wpUnderGround: true, wpFoundationSides: false, wpRoof: true, earthFaced: false, rates: {} },
    folders: st.folders || [], groups: st.groups || [], zones: st.zones || [], workbook: st.workbook || { inExcel: true, sheets: ['Take-off'], groups: st.tables || [] } };
}
/** Job handler: run the whole set and store the result in settings.ai_eval. */
export async function runEvaluation({ versionId, userId }) {
  const v = await versionProject(versionId);
  const user = await one(`SELECT id, name, email, role FROM users WHERE id=$1`, [userId]);
  const data = await loadModelData(v);
  const set = await loadCases();
  const cfg = await aiConfig();
  const templates = user ? await templatesFor(user, v.project_id) : [];
  const results = [];
  const save = (status) => q(`INSERT INTO settings (key, value) VALUES ('ai_eval',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [{
    status, versionId, model: `${v.model_name} v${v.version}`, provider: cfg.provider?.label, aiModel: cfg.provider?.model,
    total: set.cases.length, done: results.length, passed: results.filter(r => r.pass).length, finishedAt: status === 'done' ? new Date().toISOString() : null, results,
  }]);
  for (const c of set.cases) {
    const ticked = c.expect?.ticked ? data.elements.filter(e => e.cat === c.expect.ticked).map(e => e.id) : [];
    try {
      const out = await runAgent({ user, projectId: null, request: c.request, data, ticked, templates, cfg, state: evalState(c) });
      results.push({ id: c.id, request: c.request, ...scoreCase(c, out.plan, data, ticked), groups: (out.plan.groups || []).map(g => g.name), actions: (out.plan.actions || []).map(a => a.do), message: out.plan.message || '', steps: out.steps.length });
    } catch (err) {
      results.push({ id: c.id, request: c.request, pass: false, reasons: ['error: ' + err.message] });
    }
    if (results.length % 5 === 0) await save('running');
  }
  await save('done');
  return results;
}
