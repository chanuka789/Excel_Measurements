// AI tab: ask the QS agent, show its working, the method, editable assumptions and the totals.
import { $, esc, App, api, status } from './core.js';
import { dimsOf } from './engine.js';
import { S } from './state.js';
import { renderPlan as renderPlanInto, stepLabel } from './actions.js';

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

let lastRequest = '';
async function ask() {
  const request = $('aiAsk').value.trim(); if (!request) { $('aiAsk').focus(); return; }
  lastRequest = request;
  const out = $('aiOut');
  out.innerHTML = `<div class="card"><div class="loading">The AI is planning the take-off: finding the elements, checking their quantities and testing the formulas on the model…</div><div class="progress indet"><div></div></div></div>`;
  $('aiGo').disabled = true;
  try {
    let workbook = null; try { workbook = await App.workbookState?.(); } catch { /* Excel busy */ }
    const body = S.versionId ? { request, versionId: S.versionId, ticked: [...S.ticked], workbook } : { request, summary: modelSummary() };
    const data = await api('POST', '/ai', body);
    renderPlan(data);
  } catch (err) { out.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; }
  finally { $('aiGo').disabled = false; refreshAIStatus(); }
}

export function renderPlan(data) {
  renderPlanInto($('aiOut'), data, App.paneHost, { stepLabel, onAnswer: (a) => { $('aiAsk').value = `${lastRequest}\nAnswer to your question: ${a}`; ask(); } });
}
export { stepLabel };

export function initAI() {
  $('aiGo').onclick = ask;
  $('aiAsk').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask(); });
  $('aiChips').addEventListener('click', (e) => { const b = e.target.closest('[data-ask]'); if (b) { $('aiAsk').value = b.dataset.ask; $('aiAsk').focus(); } });
  App.renderPlan = renderPlan;
}
