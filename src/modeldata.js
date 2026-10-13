// Server-side access to a processed model version (element data), with a small in-memory cache.
import zlib from 'zlib';
import { promisify } from 'util';
import * as store from './storage.js';
import { dataKey } from './processing.js';

const gunzip = promisify(zlib.gunzip);
const cache = new Map();          // versionId -> { data, at }
const MAX = 4;

export async function loadModelData(v) {
  const hit = cache.get(v.id);
  const stamp = String(v.processed_at || '');
  if (hit && hit.stamp === stamp) { hit.at = Date.now(); return hit.data; }
  let buf = await store.getBuffer(dataKey(v.storage_key, 'model.json.gz'));
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = await gunzip(buf);
  const data = JSON.parse(buf.toString('utf8'));
  delete data.geometry;                       // older versions carried mesh data; the server never needs it
  data.byId = new Map(data.elements.map(e => [e.id, e]));
  cache.set(v.id, { data, at: Date.now(), stamp });
  if (cache.size > MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0][0];
    cache.delete(oldest);
  }
  return data;
}
export const forgetModelData = (vid) => cache.delete(vid);

/** Filter elements the same way the add-in does (used by the AI agent and templates). */
export function applyFilter(elements, f = {}, ticked = []) {
  if (f.use_ticked) { const t = new Set(ticked); return elements.filter(e => t.has(e.id)); }
  const lc = (a) => (Array.isArray(a) ? a : a ? [a] : []).map(s => String(s).toLowerCase());
  const [cat, fam, typ, inc, exc, lev] = [lc(f.category), lc(f.family), lc(f.type), lc(f.type_contains), lc(f.type_excludes), lc(f.level)];
  return elements.filter(e => {
    const t = String(e.type).toLowerCase();
    return (!cat.length || cat.includes(String(e.cat).toLowerCase())) && (!fam.length || fam.includes(String(e.fam).toLowerCase())) &&
      (!typ.length || typ.includes(t)) && (!inc.length || inc.some(s => t.includes(s))) &&
      (!exc.length || !exc.some(s => t.includes(s))) && (!lev.length || lev.includes(String(e.level || '').toLowerCase()));
  });
}

/** Compact model overview for the AI: categories, families, types with counts and quantity names. */
export function overview(data, { maxTypes = 400 } = {}) {
  const cats = new Map();
  for (const e of data.elements) {
    if (!cats.has(e.cat)) cats.set(e.cat, new Map());
    const k = e.fam + ' | ' + e.type;
    const t = cats.get(e.cat);
    if (!t.has(k)) t.set(k, { family: e.fam, type: e.type, count: 0, levels: new Set(), q: new Set() });
    const o = t.get(k); o.count++; if (e.level) o.levels.add(e.level); Object.keys(e.q || {}).forEach(n => o.q.add(n));
  }
  let left = maxTypes;
  return {
    file: data.fileName, units: 'metres (m, m2, m3)', up_axis: data.up || 'y',
    levels: [...new Set(data.elements.map(e => e.level).filter(Boolean))],
    categories: [...cats].map(([cat, types]) => {
      const list = [...types.values()].sort((a, b) => b.count - a.count);
      const take = Math.max(0, Math.min(list.length, 60, left)); left -= take;
      return {
        category: cat, count: list.reduce((s, o) => s + o.count, 0), types_total: list.length,
        types: list.slice(0, take).map(o => ({ family: o.family, type: o.type, count: o.count, levels: [...o.levels].slice(0, 12), quantities: [...o.q].slice(0, 40) })),
      };
    }),
  };
}
