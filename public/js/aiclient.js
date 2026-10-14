// AI tab: ask the QS agent, show its working, the method, editable assumptions and the totals.
import { $, esc, App, api, status } from './core.js';
import { dimsOf, fmt } from './engine.js';
import { S } from './state.js';
import { evaluate, specFromPlanGroup } from './measure.js';
import { mergeList } from './dims.js';
import { selectIds } from './model.js';

/** Small client-side summary, only used for quick-open models that are not on the server. */
function modelSummary() {
  const items = [];
  for (const [cat, fams] of S.tree) for (const [fam, types] of fams) for (const [typ, ids] of types) {
    const qn = {};
    ids.slice(0, 50).forEach(id => Object.entries(S.byId.get(id).q).forEach(([k, [v, u]]) => { if (!(k in qn)) qn[k] = { unit: u, sample: +v.toFixed(3) }; }));
    items.push({ category: cat, family: fam, type: typ, count: ids.length, levels: [...new Set(ids.map(id => S.byId.get(id).level).filter(Boolean))], type_name_sizes_m: dimsOf(typ), quantities: qn });
  }
  return { file: S.data.fileName, units: 'metres (m, m2, m3)', levels: [...new Set(S.E.map(e => e.level).filter(Boolean))], ticked_now: S.ticked.size, items: items.slice(0, 2500) };
}

export async function refreshAIStatus() {
  try {
    const s = await api('GET', '/ai/status');
    $('aiStatus').textContent = s.enabled
      ? `AI: ${s.provider.label} (${s.provider.model}) · ${s.usage.requests} of ${s.dailyLimit} requests used today. The add-in calculates every number from the model.`
      : 'The AI assistant is not set up on the server.';
    $('aiGo').disabled = !s.enabled;
  } catch { /* status line is optional */ }
}

async function ask() {
  const request = $('aiAsk').value.trim(); if (!request) { $('aiAsk').focus(); return; }
  const out = $('aiOut');
  out.innerHTML = `<div class="card"><div class="loading">The AI is planning the take-off: finding the elements, checking their quantities and testing the formulas on the model…</div><div class="progress indet"><div></div></div></div>`;
  $('aiGo').disabled = true;
  try {
    const body = S.versionId ? { request, versionId: S.versionId, ticked: [...S.ticked] } : { request, summary: modelSummary() };
    const data = await api('POST', '/ai', body);
    renderPlan(data);
  } catch (err) { out.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; }
  finally { $('aiGo').disabled = false; refreshAIStatus(); }
}

export function renderPlan({ plan = {}, model, provider, steps = [] }) {
  const out = $('aiOut'); out.innerHTML = '';
  if (plan.message) out.insertAdjacentHTML('beforeend', `<div class="aimsg">${esc(plan.message)}</div>`);
  if (plan.question && !(plan.groups || []).length) out.insertAdjacentHTML('beforeend', `<div class="msg ok">${esc(plan.question)}</div>`);
  if (steps.length) out.insertAdjacentHTML('beforeend', `<details class="box"><summary>How the AI worked it out (${steps.length} step${steps.length > 1 ? 's' : ''})</summary>
    <ol class="steps">${steps.map(s => `<li><strong>${esc(stepLabel(s.tool))}</strong> ${esc(s.result || '')}</li>`).join('')}</ol></details>`);
  const groups = plan.groups || [];
  // concrete, formwork, reinforcement, waterproofing... of the same elements become one table
  const specs = mergeList(groups.map(g => specFromPlanGroup(g)));
  specs.forEach((spec) => {
    const g = { filter: spec.filter };
    const card = document.createElement('div'); card.className = 'card ai-card'; out.append(card);
    const draw = () => {
      let ev, err = '';
      try { ev = evaluate(spec); } catch (e) { err = e.message; }
      const cols = [...spec.inputs, ...spec.formulas];
      const first = ev?.rows[0];
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
            <td class="v">${first && first.v[c.key] != null ? fmt(first.v[c.key], c.unit === 'nr' ? '' : c.unit) : ''}</td></tr>`).join('')}
          </tbody></table>`}
        <div class="row"><button data-a="tick">Show in model</button>${spec.ids.length && !err ? `<button class="primary" data-a="add">${S.inExcel ? 'Add to Excel' : 'Add to list'}</button>` : ''}
          ${spec.ids.length && !err ? '<button data-a="tpl" title="Save this method so the AI and the team can reuse it">Save as template</button>' : ''}</div>`;
      card.querySelectorAll('input[data-c]').forEach(inp => inp.onchange = () => { spec.constants[+inp.dataset.c].value = Number(inp.value) || 0; draw(); });
      card.querySelector('[data-a=tick]').onclick = () => selectIds(spec.ids);
      const add = card.querySelector('[data-a=add]');
      if (add) add.onclick = async () => {
        try {
          if (S.inExcel) await App.addToExcel(spec); else await App.addToList(spec);
          add.disabled = true; add.textContent = 'Added';
        } catch { /* status already shows the error */ }
      };
      const tpl = card.querySelector('[data-a=tpl]');
      if (tpl) tpl.onclick = async () => {
        try {
          await api('POST', '/templates', { name: spec.name, discipline: guessDiscipline(spec), description: spec.note, scope: App.currentProjectId?.() ? 'project' : 'user', projectId: App.currentProjectId?.(),
            spec: { name: spec.name, filter: g.filter, by: spec.by, note: spec.note, inputs: spec.inputs, constants: spec.constants, formulas: spec.formulas } });
          tpl.disabled = true; tpl.textContent = 'Saved'; status('Saved to the method library (Measure > Templates).', 'ok');
        } catch (err2) { status(err2.message, 'bad'); }
      };
    };
    draw();
  });
  if (!groups.length && !plan.message && !plan.question) out.innerHTML = '<div class="aimsg">The AI did not return a plan. Describe the elements and what to measure more clearly.</div>';
  if (model) out.insertAdjacentHTML('beforeend', `<div class="hint">AI: ${esc(provider || '')} ${esc(model)}. The AI chose the elements and the method; every number above is calculated by the add-in from the model.</div>`);
}
const stepLabel = (t) => ({ find_elements: 'Searched the model:', type_details: 'Read the quantities of a type:', test_plan: 'Tested the method on the model:', search_rules: 'Checked the QS rules:', list_templates: 'Looked at saved methods:', get_template: 'Opened a saved method:' })[t] || t;
const guessDiscipline = (spec) => {
  const cats = spec.ids.slice(0, 50).map(id => S.byId.get(id)?.cat || '').join(' ');
  return /structural|foundation/i.test(cats) ? 'Structure' : /pipe|duct|cable|conduit|mechanical|electrical|plumbing/i.test(cats) ? 'MEP' : /furniture|casework/i.test(cats) ? 'Interiors' : 'Architecture';
};

export function initAI() {
  $('aiGo').onclick = ask;
  $('aiAsk').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask(); });
  $('aiChips').addEventListener('click', (e) => { const b = e.target.closest('[data-ask]'); if (b) { $('aiAsk').value = b.dataset.ask; $('aiAsk').focus(); } });
  App.renderPlan = renderPlan;
}
