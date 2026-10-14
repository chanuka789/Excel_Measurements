// Pure schedules. Quantities are summed only when all grouped members have compatible numeric values.
import { elementKey, naturalCompare, pricingSignature } from './standards.js';
export const BUILTIN_COLUMNS = [
  ['category', 'Category'], ['family', 'Family'], ['type', 'Type'], ['mark', 'Mark'], ['level', 'Level'], ['zone', 'Zone'], ['id', 'Element ID'], ['guid', 'GUID'], ['count', 'Count'],
].map(([key, label]) => ({ key, label, source: 'identity', unit: key === 'count' ? 'nr' : '' }));
export function parameterColumns(elements) {
  const found = new Map(BUILTIN_COLUMNS.map(c => [c.key, { ...c, available: 0 }]));
  for (const e of elements) {
    for (const c of BUILTIN_COLUMNS) if (valueOf(e, c) != null && valueOf(e, c) !== '') found.get(c.key).available++;
    for (const [name, q] of Object.entries(e.q || {})) {
      const unit = q[1] || '', key = `q:${JSON.stringify([name, unit])}`;
      if (!found.has(key)) found.set(key, { key, name, label: name, unit, source: 'quantity', available: 0 });
      if (Number.isFinite(q[0])) found.get(key).available++;
    }
    for (const [name, value] of Object.entries(e.props || {})) {
      const key = `p:${name}`;
      if (!found.has(key)) found.set(key, { key, name, label: name, unit: '', source: 'property', available: 0 });
      if (value != null && value !== '') found.get(key).available++;
    }
  }
  return [...found.values()];
}
export function valueOf(e, col, zoneOf = new Map()) {
  if (col.source === 'quantity') { const q = e.q?.[col.name]; return q && q[1] === col.unit && Number.isFinite(q[0]) ? q[0] : null; }
  if (col.source === 'property') return e.props?.[col.name] ?? null;
  return ({ category: e.cat, family: e.fam, type: e.type, mark: e.mark, level: e.level, zone: zoneOf.get(e.id), id: e.id, guid: e.guid || e.props?.Guid, count: 1 })[col.key] ?? null;
}
export function isAdditive(col) {
  return col.key === 'count' || (col.source === 'quantity' && !/width|height|thickness|diameter|radius|level|elevation|size|mass per|weight per|rating|temperature|flow|capacity|pressure/i.test(col.name));
}
export function buildSchedule(elements, columns, { mode = 'itemized', groupBy = ['type', 'mark'], zoneOf = new Map(), context = {} } = {}) {
  if (!columns.length) throw new Error('Select at least one schedule column.');
  if (!['itemized', 'grouped'].includes(mode)) throw new Error('Unknown schedule mode.');
  const buckets = new Map();
  for (const e of elements) {
    const values = columns.map(c => valueOf(e, c, zoneOf));
    // Include all selected non-quantity columns. Identical marks cannot merge incompatible specifications.
    const key = mode === 'itemized' ? elementKey(e, context) : JSON.stringify([e.cat, e.fam, pricingSignature(e), ...groupBy.map(k => valueOf(e, { key: k, source: 'identity' }, zoneOf)), ...values.filter((v, i) => !isAdditive(columns[i]))]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ e, values });
  }
  return [...buckets.entries()].map(([key, members]) => ({ key, ids: members.map(m => m.e.id), links: members.map(m => elementKey(m.e, context)), values: columns.map((c, i) => {
    const v = members.map(m => m.values[i]);
    if (isAdditive(c)) return v.every(Number.isFinite) ? v.reduce((s, n) => s + n, 0) : null;
    return v[0];
  }), missing: columns.map((c, i) => members.filter(m => m.values[i] == null).length) })).sort((a, b) => naturalCompare(a.key, b.key));
}
export function csvText(rows) {
  const cell = value => { let v = String(value ?? ''); if (typeof value === 'string' && /^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return '\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n');
}
