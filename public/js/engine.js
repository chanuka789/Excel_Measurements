// Measurement engine (pure, no DOM): shared by the task pane and the unit tests.
// A take-off group "spec": { name, ids, by, note, inputs[], constants[], formulas[] }.
export const DIM_RE = /(\d{2,4}(?:\.\d+)?)\s*[xX×*]\s*(\d{2,4}(?:\.\d+)?)(?:\s*[xX×*]\s*(\d{2,4}(?:\.\d+)?))?/;
export const dimsOf = (text) => { const m = DIM_RE.exec(text || ''); return m ? m.slice(1).filter(Boolean).map(v => +v / 1000) : []; };
export const keyOf = (s) => { const k = String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'q'; return /^\d/.test(k) ? 'q_' + k : k; };
export const FN = { MAX: Math.max, MIN: Math.min, ABS: Math.abs, SQRT: Math.sqrt, PI: () => Math.PI,
  ROUND: (x, n = 0) => Math.round(x * 10 ** n) / 10 ** n, IF: (c, a, b) => (c ? a : b) };
export const FN_RE = /\b(MAX|MIN|ABS|SQRT|PI|ROUND|IF)\b/g;

export function inputValue(e, inp) {
  if (inp.source === 'count') return 1;
  if (inp.source === 'type_dim') return dimsOf(e.type)[inp.index ?? 0] ?? null;
  if (inp.source === 'name_dim') return dimsOf(e.name)[inp.index ?? 0] ?? null;
  if (inp.source === 'first') { for (const n of inp.names || []) if (e.q?.[n]) return e.q[n][0]; return null; }   // first quantity the element has
  if (inp.source === 'map') return inp.map?.[e.id] ?? inp.default ?? null;                                          // per-element value, e.g. sign x multiplier
  const q = e.q[inp.name];
  return q ? q[0] : null;
}
export function compile(expr, keys) {
  const body = String(expr).replace(/\{([A-Za-z_]\w*)\}/g, (m, k) => {
    if (!keys.includes(k)) throw new Error(`Unknown column {${k}} in formula ${expr}`);
    return 'v.' + k;
  });
  const rest = body.replace(/v\.[A-Za-z_]\w*/g, '0').replace(FN_RE, '');
  if (/[^0-9.+\-*/()\s,<>=]/.test(rest)) throw new Error('Formula uses unsupported text: ' + expr);
  const js = body.replace(FN_RE, 'F.$1').replace(/<>/g, '!=').replace(/(?<![<>=!])=(?!=)/g, '==');
  return new Function('v', 'F', '"use strict"; return (' + js + ');');
}
export function evaluate(spec, byId) {
  const keys = [...spec.inputs, ...spec.constants, ...spec.formulas].map(c => c.key);
  const fns = spec.formulas.map(f => ({ ...f, fn: compile(f.expr, keys) }));
  const rows = [], tot = {}, missing = {};
  for (const id of spec.ids) {
    const e = byId.get(id); if (!e) continue;
    const v = {};
    spec.constants.forEach(c => { v[c.key] = Number(c.value) || 0; });
    spec.inputs.forEach(i => { v[i.key] = inputValue(e, i); if (v[i.key] == null) missing[i.key] = (missing[i.key] || 0) + 1; });
    fns.forEach(f => {
      // a formula has no value if anything it refers to (input or earlier formula) has no value
      const refs = [...String(f.expr).matchAll(/\{(\w+)\}/g)].map(m => m[1]);
      const ok = refs.every(k => v[k] != null);
      let r = null; if (ok) { try { r = f.fn(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x ?? 0])), FN); } catch { r = null; } }
      v[f.key] = typeof r === 'number' && isFinite(r) ? r : null;
    });
    rows.push({ e, v });
    [...spec.inputs.filter(i => i.sum), ...spec.formulas].forEach(c => { if (v[c.key] != null) tot[c.key] = (tot[c.key] || 0) + v[c.key]; });
  }
  return { rows, tot, missing };
}
export const unitFmt = (u) => u === 'nr' ? '#,##0' : u === 'm' || u === 't' ? '#,##0.000' : '#,##0.00';
export const fmt = (v, u) => (u === 'm' ? v.toFixed(3) : u === '' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v.toFixed(2))
  .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
