// AI assistant for QS measurement.
// - Provider switch (any OpenAI-compatible API), per-user daily limits, usage log, "AI off" per project.
// - Tool-using agent: searches the model, reads type details, tests its formulas on the real elements
//   and checks the QS knowledge base before it returns a plan. The add-in still does all the arithmetic.
// - Take-off checker and BOQ description writer.
import { q, one, audit } from './db.js';
import { evaluate, dimsOf, keyOf } from '../public/js/engine.js';
import { applyFilter, overview } from './modeldata.js';
import { QS_KNOWLEDGE } from '../public/js/rules.js';
import { ACTIONS_TEXT, cleanActions } from '../public/js/actdefs.js';

// ------------------------------------------------------------------ providers
export function providers() {
  const E = process.env, list = [];
  if (E.AI_API_KEY) list.push({ id: 'default', label: labelFor(E.AI_BASE_URL), base: E.AI_BASE_URL || 'https://api.deepseek.com', model: E.AI_MODEL || 'deepseek-chat', key: E.AI_API_KEY });
  if (E.DEEPSEEK_API_KEY) list.push({ id: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com', model: E.DEEPSEEK_MODEL || 'deepseek-chat', key: E.DEEPSEEK_API_KEY });
  if (E.OPENROUTER_API_KEY) list.push({ id: 'openrouter', label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: E.OPENROUTER_MODEL || 'meta-llama/llama-4-maverick', key: E.OPENROUTER_API_KEY });
  try { for (const p of JSON.parse(E.AI_PROVIDERS || '[]')) if (p.id && p.base && (p.key || E[p.keyEnv])) list.push({ ...p, key: p.key || E[p.keyEnv] }); } catch { /* bad JSON is ignored */ }
  return list.map(p => ({ ...p, base: String(p.base).replace(/\/+$/, '') }));
}
function labelFor(base = '') {
  if (/deepseek/.test(base)) return 'DeepSeek'; if (/openrouter/.test(base)) return 'OpenRouter'; if (/openai/.test(base)) return 'OpenAI';
  return base ? new URL(base).host : 'DeepSeek';
}
export async function aiConfig() {
  const s = (await one(`SELECT value FROM settings WHERE key='ai'`))?.value || {};
  const list = providers();
  const p = list.find(x => x.id === s.provider) || list[0] || null;
  return { provider: p ? { ...p, model: s.model || p.model } : null, providers: list, dailyLimit: Number(s.dailyLimit) || 200, enabled: s.enabled !== false };
}
// legacy export used by /health
export const AI = { get key() { return providers()[0]?.key || ''; }, get model() { return providers()[0]?.model || null; } };

async function guard(user, projectId) {
  const cfg = await aiConfig();
  if (!cfg.enabled) throw Object.assign(new Error('The AI assistant is switched off by your administrator.'), { status: 503 });
  if (!cfg.provider) throw Object.assign(new Error('AI is not set up on the server. Add AI_API_KEY in Railway.'), { status: 503 });
  if (projectId) {
    const p = await one(`SELECT ai_off FROM projects WHERE id=$1`, [projectId]);
    if (p?.ai_off) throw Object.assign(new Error('AI is switched off for this project (confidential).'), { status: 403 });
  }
  const used = (await one(`SELECT count(*)::int AS n FROM ai_usage WHERE user_id=$1 AND at > now() - interval '1 day'`, [user.id])).n;
  if (used >= cfg.dailyLimit) throw Object.assign(new Error(`You have reached today's AI limit (${cfg.dailyLimit} requests). Ask your admin to raise it.`), { status: 429 });
  return cfg;
}

/** One chat completion. Returns { message, usage }. */
async function chat(cfg, messages, { tools, json, user, projectId, kind, temperature = 0.1, timeout = 120000 } = {}) {
  const p = cfg.provider;
  const body = { model: p.model, temperature, messages };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  if (json && !tools) body.response_format = { type: 'json_object' };
  let ok = true, usage = {};
  try {
    const r = await fetch(p.base + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + p.key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { ok = false; const e = new Error('AI provider error: ' + (data.error?.message || r.statusText)); e.status = 502; e.providerStatus = r.status; throw e; }
    usage = data.usage || {};
    return { message: data.choices?.[0]?.message || {}, usage };
  } catch (err) {
    ok = false;
    if (err.name === 'TimeoutError') { const e = new Error('The AI took too long to answer. Try a shorter request.'); e.status = 504; throw e; }
    throw err;
  } finally {
    if (user) q(`INSERT INTO ai_usage (user_id, project_id, kind, provider, model, tokens_in, tokens_out, ok) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [user.id, projectId || null, kind || 'chat', p.id, p.model, usage.prompt_tokens || 0, usage.completion_tokens || 0, ok]).catch(() => {});
  }
}
const parseJSON = (text) => {
  const t = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(t); } catch { /* try the first {...} block */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('The AI answer was not valid JSON.');
};

// ------------------------------------------------------------------ knowledge base
export const DEFAULT_RULES = [
  ['Openings in finishes', 'House rule (check against your standard): do not deduct openings of 0.5 m2 or less from wall and ceiling finishes; deduct larger openings on each face that is finished.', 'finishes openings deduction walls plaster paint'],
  ['Beam formwork', 'Formwork to beams = soffit (width x length) + both sides (depth below slab x length). Sides are measured below the slab soffit where the slab is cast with the beam. Ground beams on blinding have no soffit formwork.', 'formwork beams soffit sides slab'],
  ['Column formwork', 'Formwork to columns = perimeter x height, measured between slab/beam soffits when asked; otherwise full column height.', 'formwork columns perimeter'],
  ['Wall formwork', 'Formwork to walls = both faces x length x height, plus ends where exposed. Deduct openings over 0.5 m2 if asked.', 'formwork walls faces'],
  ['Slab formwork', 'Slab soffit formwork = soffit area (bottom faces). Slab edge formwork = edge perimeter x slab thickness (vertical faces).', 'formwork slab soffit edge'],
  ['Reinforcement at early stages', 'At concept or schematic stage measure reinforcement by ratio: concrete volume x kg/m3 per element type. Keep the ratio as an assumption the QS can change.', 'reinforcement rebar ratio kg/m3'],
  ['Blinding', 'Blinding under foundations = plan (bottom) area x 50 mm unless the drawings say otherwise.', 'blinding foundations'],
  ['Waterproofing', 'Waterproofing / tanking = concrete surfaces in contact with the ground: underside and sides of foundations, ground beams and basement walls.', 'waterproofing tanking ground'],
  ['Exact geometry quantities', '"Geo ..." quantities are measured from the 3D geometry and are exact. Revit "Volume" and "Area" are rounded by the export. Prefer Geo values for formwork and areas when present.', 'geo geometry exact rounding'],
];
export async function seedRules() {
  const n = (await one(`SELECT count(*)::int AS n FROM kb_rules`)).n;
  if (n) return;
  for (const [title, body, tags] of DEFAULT_RULES) await q(`INSERT INTO kb_rules (scope, title, body, tags) VALUES ('company',$1,$2,$3)`, [title, body, tags]);
}
export async function searchRules(text, projectId, limit = 6) {
  const rows = await q(`SELECT id, scope, title, body, tags FROM kb_rules WHERE scope='company' OR project_id=$1`, [projectId || null]);
  const words = String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const scored = rows.map(r => {
    const hay = `${r.title} ${r.body} ${r.tags || ''}`.toLowerCase();
    return { ...r, score: words.reduce((s, w) => s + (hay.includes(w) ? (r.title.toLowerCase().includes(w) ? 3 : 1) : 0), 0) + (r.scope === 'project' ? 0.5 : 0) };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ title, body, scope }) => ({ title, body, scope }));
}

// ------------------------------------------------------------------ prompts
const PLAN_SCHEMA = `{"message": "short plain-English summary of what you measured and the key assumptions",
 "question": "only when the request is unclear or data is missing: ONE short question for the QS (then no groups and no write actions)",
 "actions": [{"do": "action name", "...": "arguments", "why": "short reason"}],
 "groups": [{
   "name": "schedule name, e.g. 'RC beams - First floor'",
   "filter": {"category": [], "family": [], "type": [], "type_contains": [], "type_excludes": [], "level": [], "use_ticked": false},
   "group_by": "type" | "level" | "zone" | "",
   "inputs": [ {"key": "L", "label": "Cut length", "unit": "m", "source": "property", "name": "Cut Length", "sum": true},
               {"key": "b", "label": "Width", "unit": "m", "source": "type_dim", "index": 0},
               {"key": "n", "label": "Count", "unit": "nr", "source": "count", "sum": true} ],
   "constants": [ {"key": "slab", "label": "Slab thickness deducted", "value": 0.2, "unit": "m"} ],
   "formulas": [ {"key": "FW", "label": "Formwork soffit + sides", "unit": "m2", "expr": "({b} + 2*MAX({h} - {slab}, 0)) * {L}"} ],
   "note": "method and assumptions the QS must check"
 }]}`;
const RULES = `Rules:
- input "source": "property" (name must be an exact quantity name of those elements), "type_dim" (index into the
  sizes parsed from the type name, metres, usually width then depth/height), "name_dim", or "count".
  Set "sum": true only for inputs that make sense to total (lengths, areas, volumes, counts), never for widths/depths.
- Quantities named "Geo ..." are measured exactly from the 3D geometry: "Geo volume", "Geo bottom area" (soffits,
  undersides), "Geo top area", "Geo side area" (all vertical faces), "Geo plan area", "Geo box length/width/height".
  Walls may have "Openings to deduct" (door/window area over the deduction threshold) and "Openings count".
- "expr" uses {key} of inputs, constants or earlier formulas, numbers, + - * / ( ), MAX, MIN, ABS, ROUND, SQRT, PI,
  IF(cond,a,b). Nothing else. Formula results are always totalled.
- Every assumption (slab thickness, wastage %, lap allowance, number of faces, ratios) goes in "constants" so the QS
  can change it in Excel. Never hide assumptions inside numbers in a formula.
- Use "use_ticked": true when the user says selected / ticked / these elements.
- Use only category, family, type, level and quantity names that exist in the model.
- If the request is unclear or the model lacks the data, return no groups and put ONE short question in "question".`;

const AGENT_SYSTEM = `You are a senior quantity surveyor working in the DWFx Schedules window of an Excel add-in that reads Revit
DWFx models. You select elements and build quantity SCHEDULES from the data each element really has (no measurement-standard
formats such as NRM or POMI). You can also run the app for the user: the 3D view, folders, dimension groups, zones, Excel and checks.
Work in steps with the tools: find the right elements, look at the quantities they really have, test before you answer (test_plan).
Fix the plan if something is wrong (zero elements, many missing values, unit mistakes, double counting).
Prefer exact "Geo" and "FW ..." geometry quantities. The add-in evaluates every formula per element and writes live Excel formulas;
you never invent numbers.
A schedule is one entry in "groups": the elements (filter), the quantities (inputs), assumptions (constants) and calculated
columns (formulas). Volume, formwork and reinforcement of the same elements go in ONE schedule as columns of the same table
(e.g. inputs Net volume and FW quantities; constant "Reinforcement rate" kg/m3; formulas Formwork = sum of the FW faces,
Reinforcement = {Net_volume} * {Rate}). NEVER make separate schedules for formwork or reinforcement of the same elements.
Export: when the user asks to export or add to Excel, add the action add_groups after the groups.
Actions (the user sees them as a checklist; view and read actions run at once, write and delete actions only after the user's OK):
${ACTIONS_TEXT}
Filters (in actions and groups): {"category": [], "family": [], "type": [], "type_contains": [], "type_excludes": [], "level": [],
"material": ["insitu|precast|steel|timber|masonry"], "qsKind": ["pile|pilecap|footing|raft|groundbeam|beam|column|slab|groundslab|roofslab|wall|stair"], "zone": [], "use_ticked": bool}.
Rules for actions:
- Only plan actions the user asked for, or that are needed for what they asked (e.g. a folder before the groups inside it).
- Refer to things created earlier in the same plan by name (folders, groups, zones); actions run in order.
- Never plan a delete unless the user clearly asked to delete or remove that thing.
- When data is missing (a rate, which elements are meant), ask ONE question in "question" and plan no write actions.
- Summary sheets and new sheets are built by formulas from the Take-off sheet; use build_summaries / new_sheet.
${QS_KNOWLEDGE}
When you are done, answer with ONLY this JSON (no tool call):
${PLAN_SCHEMA}
${RULES}`;

const TOOLS = [
  { type: 'function', function: { name: 'find_elements', description: 'Find elements with a filter. Returns counts by type and the levels found.',
    parameters: { type: 'object', properties: { filter: { type: 'object', description: 'category, family, type, type_contains, type_excludes, level (arrays), use_ticked (bool)' } }, required: ['filter'] } } },
  { type: 'function', function: { name: 'type_details', description: 'Quantities (with how many elements have them and sample values), sizes parsed from the type name, and main properties for one type or category.',
    parameters: { type: 'object', properties: { category: { type: 'string' }, type: { type: 'string' } } } } },
  { type: 'function', function: { name: 'test_plan', description: 'Evaluate one take-off group on the real elements. Returns element count, totals per column, missing values and the first rows.',
    parameters: { type: 'object', properties: { group: { type: 'object', description: 'one group in the plan format' } }, required: ['group'] } } },
  { type: 'function', function: { name: 'project_state', description: 'The project: assumptions (ground level, reinforcement rates), dimension-group folders and groups, zones, and the Excel workbook (sheets, take-off tables).',
    parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'search_rules', description: 'Search the QS knowledge base (house measurement rules) for a topic.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'list_templates', description: 'List saved measurement templates (approved methods), optionally for one discipline.',
    parameters: { type: 'object', properties: { discipline: { type: 'string' } } } } },
  { type: 'function', function: { name: 'get_template', description: 'Get one measurement template by name (a ready group you can adapt).',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
];

/** Convert a plan group into a take-off spec for the given elements (server copy of the add-in logic). */
export function specFromGroup(g, els) {
  const ids = els.map(e => e.id);
  const inputs = (g.inputs || []).map(i => ({ key: keyOf(i.key || i.name || i.label), label: i.label || i.name || i.key, unit: i.unit || (i.source === 'count' ? 'nr' : 'm'),
    source: i.source || 'property', name: i.name, index: i.index, sum: i.sum ?? (i.source === 'count') }));
  const constants = (g.constants || []).map(c => ({ key: keyOf(c.key || c.label), label: c.label || c.key, value: Number(c.value) || 0, unit: c.unit || '' }));
  const formulas = (g.formulas || []).map((f, i) => ({ key: keyOf(f.key || 'F' + (i + 1)), label: f.label || f.key, unit: f.unit || '', expr: f.expr }));
  return { name: g.name || 'Take-off group', ids, by: g.group_by ?? 'type', note: g.note || '', inputs, constants, formulas };
}

function toolRunner({ data, ticked, projectId, templates, state = {} }) {
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    project_state() { return state; },
    find_elements({ filter }) {
      const els = applyFilter(data.elements, filter || {}, ticked);
      const types = new Map();
      els.forEach(e => { const k = e.cat + ' | ' + e.fam + ' | ' + e.type; types.set(k, (types.get(k) || 0) + 1); });
      return { count: els.length, levels: [...new Set(els.map(e => e.level).filter(Boolean))].slice(0, 30),
        types: [...types].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, n]) => { const [category, family, type] = k.split(' | '); return { category, family, type, count: n }; }) };
    },
    type_details({ category, type }) {
      const els = data.elements.filter(e => (!category || e.cat.toLowerCase() === String(category).toLowerCase()) && (!type || e.type.toLowerCase() === String(type).toLowerCase()));
      if (!els.length) return { error: 'No elements with that category/type. Use find_elements first.' };
      const qn = {};
      els.forEach(e => Object.entries(e.q || {}).forEach(([n, [v, u]]) => { (qn[n] ||= { unit: u, count: 0, sample: r3(v), total: 0 }); qn[n].count++; qn[n].total += v; }));
      Object.values(qn).forEach(o => { o.total = r3(o.total); });
      const props = {}; Object.entries(els[0].props || {}).slice(0, 60).forEach(([k, v]) => { if (String(v).length < 80) props[k] = v; });
      return { elements: els.length, types: [...new Set(els.map(e => e.type))].slice(0, 20), type_name_sizes_m: dimsOf(els[0].type), quantities: qn, sample_properties: props };
    },
    test_plan({ group }) {
      try {
        const els = applyFilter(data.elements, group?.filter || {}, ticked);
        const spec = specFromGroup(group || {}, els);
        const { rows, tot, missing } = evaluate(spec, data.byId);
        const cols = [...spec.inputs, ...spec.formulas];
        return { elements: els.length, totals: Object.fromEntries(cols.map(c => [`${c.label} (${c.unit})`, tot[c.key] != null ? r3(tot[c.key]) : null])),
          missing: Object.fromEntries(Object.entries(missing).map(([k, n]) => [cols.find(c => c.key === k)?.label || k, n])),
          first_rows: rows.slice(0, 3).map(({ e, v }) => ({ id: e.id, type: e.type, level: e.level, values: Object.fromEntries(cols.map(c => [c.key, v[c.key] != null ? r3(v[c.key]) : null])) })) };
      } catch (err) { return { error: err.message }; }
    },
    async search_rules({ query }) { return { rules: await searchRules(query, projectId) }; },
    list_templates({ discipline }) {
      return { templates: templates.filter(t => !discipline || String(t.discipline || '').toLowerCase() === String(discipline).toLowerCase()).map(t => ({ name: t.name, discipline: t.discipline, description: t.description })) };
    },
    get_template({ name }) {
      const t = templates.find(x => x.name.toLowerCase() === String(name).toLowerCase());
      return t ? { name: t.name, group: { ...t.spec, filter: t.spec.filter } } : { error: 'No template with that name.' };
    },
  };
}

/**
 * Plan a take-off with the agent. data = processed model data (server), ticked = selected IDs.
 * Returns { plan, model, steps }.
 */
export async function runAgent({ user, projectId, request, data, ticked = [], templates = [], maxSteps = 10, cfg, state = {} }) {
  cfg = cfg || await guard(user, projectId);
  const rules = await searchRules(request, projectId, 5);
  const ov = overview(data, { maxTypes: 250 });
  const messages = [
    { role: 'system', content: AGENT_SYSTEM + (rules.length ? '\n\nHouse rules that may apply:\n' + rules.map(r => `- ${r.title}: ${r.body}`).join('\n') : '') },
    { role: 'user', content: `MODEL OVERVIEW:\n${JSON.stringify(ov)}\n\nPROJECT: ground level ${state.setup?.groundLevel ?? 'not set'}; ${(state.groups || []).length} dimension groups; ${(state.zones || []).length} zones; Excel: ${state.workbook?.inExcel ? `${(state.workbook.groups || []).length} take-off tables, sheets ${(state.workbook.sheets || []).join(', ')}` : 'not open'}\n\nSELECTED ELEMENTS: ${ticked.length}\n\nREQUEST:\n${String(request).slice(0, 2000)}` },
  ];
  const tools = toolRunner({ data, ticked, projectId, templates, state });
  const steps = [];
  let useTools = true;
  for (let i = 0; i < maxSteps; i++) {
    let res;
    try { res = await chat(cfg, messages, { tools: useTools ? TOOLS : undefined, json: !useTools, user, projectId, kind: 'agent' }); }
    catch (err) {
      if (useTools && err.providerStatus === 400 && i === 0) { useTools = false; i--; continue; }   // provider without tool support: one-shot mode
      throw err;
    }
    const m = res.message;
    if (m.tool_calls?.length && useTools) {
      messages.push({ role: 'assistant', content: m.content || '', tool_calls: m.tool_calls });
      for (const tc of m.tool_calls) {
        let args = {}; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* empty args */ }
        const fn = tools[tc.function?.name];
        const out = fn ? await fn(args) : { error: 'Unknown tool' };
        steps.push({ tool: tc.function?.name, args: summarizeArgs(args), result: summarizeResult(out) });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 12000) });
      }
      continue;
    }
    try { return { plan: normalizePlan(parseJSON(m.content)), model: cfg.provider.model, provider: cfg.provider.label, steps }; }
    catch {
      messages.push({ role: 'assistant', content: m.content || '' }, { role: 'user', content: 'Answer again with ONLY the JSON plan.' });
      useTools = false;
    }
  }
  const last = await chat(cfg, [...messages, { role: 'user', content: 'Stop using tools. Answer now with ONLY the JSON plan.' }], { json: true, user, projectId, kind: 'agent' });
  return { plan: normalizePlan(parseJSON(last.message.content)), model: cfg.provider.model, provider: cfg.provider.label, steps };
}
export function normalizePlan(p) {
  p = p && typeof p === 'object' ? p : {};
  if (!Array.isArray(p.groups)) p.groups = [];
  const { actions, dropped } = cleanActions(p.actions);
  p.actions = actions; if (dropped.length) p.dropped = dropped;
  if (p.question) p.actions = p.actions.filter(a => !['write', 'delete'].includes(ACTION_KIND(a)));      // ask first, act after the answer
  delete p.rules_used;
  if (p.question && !p.groups.length && !p.message) p.message = p.question;
  return p;
}
import { actionKind as ACTION_KIND } from '../public/js/actdefs.js';
const summarizeArgs = (a) => JSON.stringify(a).slice(0, 300);
const summarizeResult = (r) => {
  if (r?.error) return 'Error: ' + r.error;
  if ('elements' in (r || {}) && r.totals) return `${r.elements} elements; ` + Object.entries(r.totals).slice(0, 4).map(([k, v]) => `${k} ${v ?? '-'}`).join(', ');
  if ('count' in (r || {})) return `${r.count} elements in ${r.types?.length || 0} types`;
  if (r && 'setup' in r) return `${(r.groups || []).length} groups, ${(r.zones || []).length} zones`;
  if (r?.rules) return `${r.rules.length} rule(s)`;
  if (r?.templates) return `${r.templates.length} template(s)`;
  return JSON.stringify(r).slice(0, 160);
};

/** One-shot planning from a client-side summary (quick-open models that are not on the server). */
export async function runSummaryPlan({ user, request, summary }) {
  const cfg = await guard(user, null);
  const rules = await searchRules(request, null, 5);
  const res = await chat(cfg, [
    { role: 'system', content: `You are a senior quantity surveyor. Plan the take-off for the REQUEST from the model SUMMARY. Answer with ONLY this JSON:\n${PLAN_SCHEMA}\n${RULES}` +
      (rules.length ? '\n\nHouse rules:\n' + rules.map(r => `- ${r.title}: ${r.body}`).join('\n') : '') },
    { role: 'user', content: 'SUMMARY:\n' + JSON.stringify(summary).slice(0, 200000) + '\n\nREQUEST:\n' + String(request).slice(0, 2000) },
  ], { json: true, user, kind: 'plan' });
  return { plan: normalizePlan(parseJSON(res.message.content)), model: cfg.provider.model, provider: cfg.provider.label, steps: [] };
}

/** Review finished take-off groups for missing items, odd values, unit mistakes and double counting. */
export async function runCheck({ user, projectId, groups, overviewData }) {
  const cfg = await guard(user, projectId);
  const rules = await searchRules(groups.map(g => g.name).join(' '), projectId, 6);
  const res = await chat(cfg, [
    { role: 'system', content: `You are a senior quantity surveyor reviewing a take-off before it is priced, like a BOQ error review.
Look for: missing items a QS would expect for these elements (e.g. formwork without concrete, concrete without reinforcement,
foundations without blinding or waterproofing), odd values (rates per element far from normal, zero or negative totals,
huge outliers), unit mistakes (m vs mm, m2 vs m3), double counting (the same elements or quantity in two groups),
assumptions that look wrong, and elements in the model that are not measured at all.
Answer with ONLY JSON: {"summary": "one or two sentences", "findings": [{"severity": "high"|"medium"|"low", "group": "group name or ''",
"issue": "what is wrong", "suggestion": "what to do"}]}. Be specific and short. If everything looks right, return no findings.` +
      (rules.length ? '\n\nHouse rules:\n' + rules.map(r => `- ${r.title}: ${r.body}`).join('\n') : '') },
    { role: 'user', content: JSON.stringify({ model: overviewData, takeoff: groups }).slice(0, 180000) },
  ], { json: true, user, projectId, kind: 'check' });
  const out = parseJSON(res.message.content);
  return { summary: out.summary || '', findings: Array.isArray(out.findings) ? out.findings : [], model: cfg.provider.model };
}

/** Draft BOQ descriptions in house style for measured groups. */
export async function runDescribe({ user, projectId, items, style }) {
  const cfg = await guard(user, projectId);
  const res = await chat(cfg, [
    { role: 'system', content: `You write bill of quantities item descriptions for a quantity surveyor.
For each item write a clear, complete description: work section heading, item description with material, size or thickness,
location and the unit of measurement. Keep to the house style if given. Do not invent specifications that are not in the data:
write "[specification]" where the QS must fill in a detail.
Answer with ONLY JSON: {"items": [{"ref": "same ref as input", "heading": "work section / sub-heading", "description": "item text", "unit": "m2|m3|m|nr|kg|t|item"}]}` },
    { role: 'user', content: JSON.stringify({ house_style: style || 'Short, formal, UK QS English. Start with the element, then material and size, then location.', items }).slice(0, 120000) },
  ], { json: true, user, projectId, kind: 'describe', temperature: 0.2 });
  const out = parseJSON(res.message.content);
  return { items: Array.isArray(out.items) ? out.items : [], model: cfg.provider.model };
}

export { guard as aiGuard, chat as aiChat };
export async function aiUsage(userId) {
  return one(`SELECT count(*)::int AS requests, coalesce(sum(tokens_in),0)::int AS tokens_in, coalesce(sum(tokens_out),0)::int AS tokens_out
              FROM ai_usage WHERE user_id=$1 AND at > now() - interval '1 day'`, [userId]);
}
export async function logAI(user, projectId, request) { if (projectId) await audit(user.id, projectId, 'ai.request', { request: String(request || '').slice(0, 300) }); }
