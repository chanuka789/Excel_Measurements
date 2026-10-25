// Compare two processed model versions element by element (matched by Revit element ID). Runs in the add-in (models
// kept on the computer) and on the server (models stored there, src/features.js).
const FIELDS = ['cat', 'fam', 'type', 'level', 'mark', 'material'];
const IGNORE_Q = /^Geo (surface area|top area|plan area)$/;   // derived duplicates of other values; kept out of the noise

export function compareModels(a, b, { max = 5000 } = {}) {
  const A = new Map(a.elements.map(e => [e.id, e])), B = new Map(b.elements.map(e => [e.id, e]));
  const brief = (e) => ({ id: e.id, cat: e.cat, fam: e.fam, type: e.type, level: e.level || '' });
  const added = [], removed = [], changed = [];
  let unchanged = 0;
  for (const [id, e] of B) if (!A.has(id)) added.push(brief(e));
  for (const [id, e] of A) if (!B.has(id)) removed.push(brief(e));
  for (const [id, eb] of B) {
    const ea = A.get(id); if (!ea) continue;
    const ch = [];
    for (const f of FIELDS) if ((ea[f] || '') !== (eb[f] || '')) ch.push({ field: f, from: ea[f] || '', to: eb[f] || '' });
    const names = new Set([...Object.keys(ea.q || {}), ...Object.keys(eb.q || {})]);
    for (const n of names) {
      if (IGNORE_Q.test(n)) continue;
      const va = ea.q?.[n]?.[0], vb = eb.q?.[n]?.[0];
      if (va == null && vb == null) continue;
      if (va == null || vb == null || Math.abs(va - vb) > Math.max(1e-3, 0.005 * Math.max(Math.abs(va), Math.abs(vb)))) {
        ch.push({ field: n, from: va ?? null, to: vb ?? null, unit: (eb.q?.[n] || ea.q?.[n])[1], delta: va != null && vb != null ? vb - va : null });
      }
    }
    if (ea.bb && eb.bb) {
      const moved = Math.max(...ea.bb.map((v, i) => Math.abs(v - eb.bb[i])));
      if (moved > 0.01) ch.push({ field: 'position', from: null, to: null, delta: Math.round(moved * 1000) / 1000, unit: 'm' });
    }
    if (ch.length) changed.push({ ...brief(eb), changes: ch }); else unchanged++;
  }
  const byCat = new Map();
  const bump = (list, k) => list.forEach(e => { if (!byCat.has(e.cat)) byCat.set(e.cat, { category: e.cat, added: 0, removed: 0, changed: 0 }); byCat.get(e.cat)[k]++; });
  bump(added, 'added'); bump(removed, 'removed'); bump(changed, 'changed');
  // quantity totals per category for the main measurable quantities
  const qtot = (els) => {
    const out = {};
    for (const e of els) for (const n of ['Volume', 'Area', 'Length', 'Geo volume']) {
      const v = e.q?.[n]?.[0]; if (v == null) continue;
      const k = e.cat + '|' + n; out[k] = (out[k] || 0) + v;
    }
    return out;
  };
  const qa = qtot(a.elements), qb = qtot(b.elements);
  const quantities = [...new Set([...Object.keys(qa), ...Object.keys(qb)])].sort().map(k => {
    const [cat, name] = k.split('|'); const from = qa[k] || 0, to = qb[k] || 0;
    return { category: cat, quantity: name, from: round(from), to: round(to), delta: round(to - from) };
  }).filter(r => Math.abs(r.delta) > 1e-6);
  return {
    summary: { added: added.length, removed: removed.length, changed: changed.length, unchanged },
    byCategory: [...byCat.values()].sort((x, y) => x.category.localeCompare(y.category)),
    quantities,
    added: added.slice(0, max), removed: removed.slice(0, max), changed: changed.slice(0, max),
    truncated: added.length > max || removed.length > max || changed.length > max,
  };
}
const round = (v) => Math.round(v * 1000) / 1000;
