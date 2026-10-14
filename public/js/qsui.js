// "Measure items (QS rules)" panel: rule set picker, project QS setup and the measure items library with a
// preview of every column (rule reference, unit, total) before it goes to Excel. Shared by the task pane and the
// 3D window through a small context object.
import { esc, api } from './core.js';
import { evaluate, fmt } from './engine.js';
import { RULE_SETS, KIND_LABEL, DEFAULT_RATES, qsSetup, guessGroundLevel } from './rules.js';
import { ITEMS, itemIds, itemSpecs, LIMITS_TEXT } from './qsitems.js';

/** applyFilter over a list of elements (same rules as the task pane's). */
export function filterOn(E, f = {}, ticked = []) {
  if (f.use_ticked) return [...ticked];
  const lc = (x) => (Array.isArray(x) ? x : x ? [x] : []).map(s => String(s).toLowerCase());
  const [cat, fam, typ, inc, exc, lev] = [lc(f.category), lc(f.family), lc(f.type), lc(f.type_contains), lc(f.type_excludes), lc(f.level)];
  return E.filter(e => {
    const t = `${e.type} ${e.fam}`.toLowerCase();
    return (!cat.length || cat.includes(String(e.cat).toLowerCase())) && (!fam.length || fam.includes(String(e.fam).toLowerCase())) &&
      (!typ.length || typ.includes(String(e.type).toLowerCase())) && (!inc.length || inc.some(s => t.includes(s))) &&
      (!exc.length || !exc.some(s => t.includes(s))) && (!lev.length || lev.includes(String(e.level || '').toLowerCase()));
  }).map(e => e.id);
}

/**
 * ctx: { host, E(), byId(), ticked() -> ids, project() -> { project, my_role }, onProjectChanged(p),
 *        selectIds(ids), add(spec) -> Promise, status(msg, kind), inExcel }
 */
export function mountQs(ctx) {
  const st = { q: '', use: 'item', open: null, preview: null, setupOpen: false };
  const setup = () => qsSetup(ctx.project()?.project?.settings);
  const canEdit = () => ['owner', 'editor'].includes(ctx.project()?.my_role);
  const render = () => {
    const s = setup(), E = ctx.E();
    if (!E.length) { ctx.host.innerHTML = '<div class="empty">Open a model to use the measure items.</div>'; return; }
    const gl = s.groundLevel ?? guessGroundLevel(E);
    const groups = new Map();
    ITEMS.forEach(it => { if (!groups.has(it.discipline)) groups.set(it.discipline, []); groups.get(it.discipline).push(it); });
    const sel = ctx.ticked();
    ctx.host.innerHTML = `
      <div class="qs-head">
        <label class="field">Measurement rules<select class="input" id="qsSet" ${canEdit() ? '' : 'disabled'}>${Object.values(RULE_SETS).map(r => `<option value="${r.id}" ${r.id === s.ruleSet ? 'selected' : ''}>${esc(r.name)} · ${esc(r.use)}</option>`).join('')}</select></label>
        <button class="btn small" id="qsSetupBtn" aria-expanded="${st.setupOpen}">QS setup</button>
      </div>
      <p class="hint">${esc(RULE_SETS[s.ruleSet].full)}. ${esc(LIMITS_TEXT(s.ruleSet))}</p>
      ${st.setupOpen ? setupHtml(s, gl) : ''}
      <div class="row qs-use"><label><input type="radio" name="qsUse" value="item" ${st.use === 'item' ? 'checked' : ''}> Elements the item finds</label>
        <label><input type="radio" name="qsUse" value="sel" ${st.use === 'sel' ? 'checked' : ''} ${sel.length ? '' : 'disabled'}> The selection (${sel.length})</label></div>
      <input type="search" class="input" id="qsFind" placeholder="Search measure items" value="${esc(st.q)}" aria-label="Search measure items">
      <div id="qsList">${[...groups].map(([g, list]) => `<div class="tpl-group">${esc(g)}</div>` + list.map(it => {
        const n = itemIds(it, E, (f) => filterOn(E, f, sel)).length;
        return `<div class="tpl" data-name="${esc((it.name + ' ' + (it.description || '') + ' ' + it.discipline).toLowerCase())}" ${n || st.use === 'sel' ? '' : 'data-empty="1"'}>
          <div class="grow"><strong>${esc(it.name)}</strong><span>${esc(it.description || it.quantities?.join(', ') || '')} · ${n} element${n === 1 ? '' : 's'} in this model</span></div>
          <button class="btn small" data-qi="${it.id}" ${n || st.use === 'sel' ? '' : 'disabled'}>Preview</button></div>`;
      }).join('')).join('')}</div>
      <div id="qsPreview"></div>`;
    ctx.host.querySelector('#qsSet').onchange = (e) => saveSetup({ ruleSet: e.target.value });
    ctx.host.querySelector('#qsSetupBtn').onclick = () => { st.setupOpen = !st.setupOpen; render(); };
    ctx.host.querySelectorAll('input[name=qsUse]').forEach(r => r.onchange = () => { st.use = r.value; render(); });
    const find = ctx.host.querySelector('#qsFind');
    const filt = () => { st.q = find.value.toLowerCase(); ctx.host.querySelectorAll('#qsList .tpl').forEach(x => { x.hidden = !x.dataset.name.includes(st.q); }); };
    find.oninput = filt; filt();
    ctx.host.querySelectorAll('[data-qi]').forEach(b => b.onclick = () => preview(ITEMS.find(i => i.id === b.dataset.qi)));
    const f = ctx.host.querySelector('#qsSetupForm');
    if (f) f.onsubmit = (e) => {
      e.preventDefault();
      const v = (id) => f.querySelector('#' + id);
      const rates = {}; f.querySelectorAll('[data-rate]').forEach(i => { rates[i.dataset.rate] = Number(i.value) || 0; });
      saveSetup({ groundLevel: v('qsGL').value === '' ? null : Number(v('qsGL').value), wpUpturn: Number(v('qsUp').value), roofUpturn: Number(v('qsRoofUp').value),
        wpUnderGround: v('qsWpU').checked, wpFoundationSides: v('qsWpS').checked, wpRoof: v('qsWpR').checked, earthFaced: v('qsEarth').checked, rates });
    };
    if (st.open) preview(st.open, true);
  };
  const setupHtml = (s, gl) => `<form class="card form" id="qsSetupForm"><h3>QS setup for this project</h3>
      <p class="hint">These assumptions are written to Excel as yellow cells, so every take-off shows them and you can change them there too.</p>
      <div class="two"><label class="field">Ground level (model elevation, m)<input class="input" id="qsGL" type="number" step="any" value="${s.groundLevel ?? ''}" placeholder="${gl != null ? 'auto: ' + gl.toFixed(3) : 'auto'}" ${canEdit() ? '' : 'disabled'}></label>
        <label class="field">Waterproofing upturn above ground (m)<input class="input" id="qsUp" type="number" step="any" value="${s.wpUpturn}" ${canEdit() ? '' : 'disabled'}></label></div>
      <div class="two"><label class="field">Roof upturn at parapets (m)<input class="input" id="qsRoofUp" type="number" step="any" value="${s.roofUpturn}" ${canEdit() ? '' : 'disabled'}></label><span></span></div>
      <label class="check"><input type="checkbox" id="qsWpU" ${s.wpUnderGround ? 'checked' : ''} ${canEdit() ? '' : 'disabled'}> Waterproofing under foundations and ground slabs</label>
      <label class="check"><input type="checkbox" id="qsWpS" ${s.wpFoundationSides ? 'checked' : ''} ${canEdit() ? '' : 'disabled'}> Waterproofing to sides of foundations</label>
      <label class="check"><input type="checkbox" id="qsWpR" ${s.wpRoof ? 'checked' : ''} ${canEdit() ? '' : 'disabled'}> Waterproofing to exposed roof slabs</label>
      <label class="check"><input type="checkbox" id="qsEarth" ${s.earthFaced ? 'checked' : ''} ${canEdit() ? '' : 'disabled'}> Foundation sides cast against earth (no formwork)</label>
      <h4>Reinforcement allowances (kg per m³ of concrete)</h4>
      <div class="rates">${Object.keys(DEFAULT_RATES).map(k => `<label>${esc(KIND_LABEL[k] || k)}<input class="input" type="number" step="any" min="0" data-rate="${k}" value="${s.rates[k]}" ${canEdit() ? '' : 'disabled'}></label>`).join('')}</div>
      <p class="hint">Use your engineer's figures or your company rates. Until a bar bending schedule is available, reinforcement is shown as an allowance.</p>
      ${canEdit() ? '<div class="actions left"><button class="btn primary">Save QS setup</button></div>' : '<p class="hint">You need editor access to change these.</p>'}</form>`;
  async function saveSetup(body) {
    const p = ctx.project(); if (!p) return;
    try {
      const r = await api('PATCH', `/projects/${p.project.id}/qs`, body);
      p.project.settings = { ...(p.project.settings || {}), qs: r.qs };
      ctx.onProjectChanged?.(p); ctx.status('QS setup saved.', 'ok'); st.preview = null; render();
    } catch (err) { ctx.status(err.message, 'bad'); render(); }
  }
  function preview(item, quiet = false) {
    st.open = item;
    const box = ctx.host.querySelector('#qsPreview'); if (!box) return;
    const E = ctx.E(), byId = ctx.byId(), s = setup();
    const ids = st.use === 'sel' ? ctx.ticked().filter(id => byId.has(id)) : itemIds(item, E, (f) => filterOn(E, f, ctx.ticked()));
    if (!ids.length) { box.innerHTML = `<div class="msg bad">No elements for "${esc(item.name)}".</div>`; return; }
    let specs;
    try { specs = itemSpecs(item, ids, byId, { set: s.ruleSet, setup: s, elements: E }); } catch (err) { box.innerHTML = `<div class="msg bad">${esc(err.message)}</div>`; return; }
    st.preview = specs;
    box.innerHTML = `<h3>${esc(item.name)} · ${esc(s.ruleSet)}</h3>` + specs.map((spec, i) => {
      let ev; try { ev = evaluate(spec, byId); } catch (err) { return `<div class="msg bad">${esc(spec.name)}: ${esc(err.message)}</div>`; }
      const cols = spec.formulas.length ? spec.formulas : spec.inputs;
      return `<div class="card qs-card"><h3>${esc(spec.name)}</h3><div class="hint">${spec.ids.length} element${spec.ids.length === 1 ? '' : 's'} · ${esc(spec.note || '')}</div>
        ${spec.constants.length ? `<div class="qs-consts">${spec.constants.map((c, j) => `<label>${esc(c.label)} <input type="number" step="any" class="input" data-s="${i}" data-c="${j}" value="${c.value}" style="width:90px"> ${esc(c.unit)}</label>`).join('')}</div>` : ''}
        <table class="q"><thead><tr><th>Item</th><th>Rule</th><th style="text-align:right">Total</th></tr></thead><tbody>
        ${cols.map(c => `<tr><td>${esc(c.label)} <span class="hint">${esc(c.unit)}</span>${ev.missing[c.key] ? ` <span class="hint">(${ev.missing[c.key]} without data)</span>` : ''}</td>
          <td>${c.rule ? `<span class="badge ${c.rule.confirm ? '' : 'ok'}" title="${c.rule.confirm ? 'Written from secondary sources: confirm against your RICS copy' : 'Rule reference'}">${esc(c.rule.ref || c.rule.set)}${c.rule.confirm ? ' · to confirm' : ''}</span>${c.rule.allowance ? ' <span class="badge">allowance</span>' : ''}` : ''}</td>
          <td class="v">${ev.tot[c.key] != null ? fmt(ev.tot[c.key], c.unit === 'nr' ? '' : c.unit) : ''}</td></tr>`).join('')}
        </tbody></table>
        <div class="row"><button class="btn small" data-show="${i}">Show in model</button><button class="btn small primary" data-add="${i}">${ctx.inExcel ? 'Add to Excel' : 'Add to list'}</button></div></div>`;
    }).join('') + (specs.length > 1 ? `<div class="row"><button class="btn primary" id="qsAddAll">Add all ${specs.length} tables</button></div>` : '');
    box.querySelectorAll('input[data-c]').forEach(inp => inp.onchange = () => { specs[+inp.dataset.s].constants[+inp.dataset.c].value = Number(inp.value) || 0; });
    box.querySelectorAll('[data-show]').forEach(b => b.onclick = () => ctx.selectIds(specs[+b.dataset.show].ids));
    const add = async (list, btn) => {
      try { btn.disabled = true; for (const sp of list) await ctx.add(sp); btn.textContent = 'Added'; }
      catch (err) { btn.disabled = false; ctx.status(err.message, 'bad'); }
    };
    box.querySelectorAll('[data-add]').forEach(b => b.onclick = () => add([specs[+b.dataset.add]], b));
    const all = box.querySelector('#qsAddAll'); if (all) all.onclick = () => add(specs, all);
    if (!quiet) box.scrollIntoView({ block: 'nearest' });
  }
  return { render, preview: (id) => preview(ITEMS.find(i => i.id === id)) };
}
