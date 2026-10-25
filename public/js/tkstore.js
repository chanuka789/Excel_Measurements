// On-screen take-off data: the project's dimension groups (with their measured dimensions) and the drawing settings
// (scale per page, drawing multiplier, markups). Used by the 2D drawing measure tool and by 3D point measurement.
// In the 3D window the groups belong to the project tree (wtree.js), which passes itself in as the "source";
// in the task pane the store keeps its own copy.
import { api, status } from './core.js';
import { measure2d, shapeFor } from './geom2d.js';
import { UNIT } from './dims.js';

/** d:<drawing id> or s:<version id>:<sheet> (one key per drawing; pages live inside its settings). */
export const drawingKey = (d) => (d.kind === 'sheet' ? `s:${d.versionId}:${d.index}` : `d:${d.id}`);
export const newId = () => Math.random().toString(36).slice(2, 10);

export class TakeoffStore {
  /** opts: { projectId, canEdit(), source?: { groups(), current(), setCurrent(id), replace(group), reload() }, api? (tests) } */
  constructor(opts) {
    this.o = opts; this.own = { groups: [], current: null }; this.settings = {}; this.listeners = new Set();
    this.api = opts.api || api; this.queues = new Map();
  }
  /** Run saves of one group one after another: each starts from the group as the previous save left it,
   * so quick clicks (counts, faces) never overwrite each other's dimensions. */
  serial(gid, job) {
    const run = (this.queues.get(gid) || Promise.resolve()).catch(() => {}).then(job);
    this.queues.set(gid, run);
    run.finally(() => { if (this.queues.get(gid) === run) this.queues.delete(gid); }).catch(() => {});
    return run;
  }
  get projectId() { return this.o.projectId(); }
  canEdit() { return Boolean(this.o.canEdit?.()); }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what) { this.listeners.forEach(f => { try { f(what); } catch (err) { console.error(err); } }); }

  async load() {
    const pid = this.projectId; if (!pid) return;
    const [t, s] = await Promise.all([this.o.source ? null : this.api('GET', `/projects/${pid}/tree`), this.api('GET', `/projects/${pid}/drawing-settings`)]);
    if (t) { this.own.groups = t.groups; if (this.own.current && !this.group(this.own.current)) this.own.current = null; }
    this.settings = s.settings || {};
    this.emit('load');
  }
  groups() { return this.o.source ? this.o.source.groups() : this.own.groups; }
  group(id) { return this.groups().find(g => g.id === id) || null; }
  currentId() { return this.o.source ? this.o.source.current() : this.own.current; }
  current() { return this.group(this.currentId()); }
  setCurrent(id) { if (this.o.source) this.o.source.setCurrent(id); else this.own.current = id; this.emit('current'); }
  replace(g) {
    const old = this.group(g.id);
    const full = { ...g, items: g.items || old?.items || [] };
    if (this.o.source) this.o.source.replace(full);
    else { const i = this.own.groups.findIndex(x => x.id === g.id); if (i >= 0) this.own.groups[i] = full; else this.own.groups.push(full); }
    return full;
  }

  // ---------------------------------------------------------------- dimension groups
  async createGroup({ name, mtype, folderId = null, props = {} }) {
    const r = await this.api('POST', `/projects/${this.projectId}/dimgroups`, { name, mtype, folderId,
      props: { posColor: randomColor(), negColor: '#d13438', ...props } });
    const g = this.replace({ ...r.group, items: [] });
    this.setCurrent(g.id); this.emit('groups');
    return g;
  }
  /** Save a group's measured dimensions as given (the server keeps the other properties). Prefer addMeasured / updateDims. */
  saveMeasured(gid, measured) { return this.serial(gid, () => this.put(gid, measured)); }
  async put(gid, measured) {
    const r = await this.api('PATCH', `/dimgroups/${gid}`, { props: { measured } });
    const g = this.replace(r.group); this.emit('groups');
    return g;
  }
  /** Add dimensions to a group, after any save of that group still on its way. */
  addMeasured(gid, list) {
    if (!this.group(gid)) return Promise.reject(new Error('Choose a dimension group first.'));
    return this.serial(gid, () => { const g = this.group(gid); return this.put(gid, [...(g?.props.measured || []), ...list]); });
  }
  /** Change measured dimensions across groups: fn(m, g) returns the new dimension, null to delete it, or undefined to keep it.
   * Each group is changed from its latest saved state. Resolves with the number of groups changed. */
  async updateDims(fn) {
    const jobs = this.groups().map(({ id }) => this.serial(id, async () => {
      const g = this.group(id); if (!g) return 0;
      let dirty = false; const out = [];
      for (const m of g.props.measured || []) {
        const r = fn(m, g);
        if (r === undefined) out.push(m);
        else { dirty = true; if (r) out.push(r); }
      }
      if (!dirty) return 0;
      await this.put(id, out); return 1;
    }));
    return (await Promise.all(jobs)).reduce((a, b) => a + b, 0);
  }
  /** Every measured dimension taken on this drawing page (or in 3D on this model version): [{ g, m }]. */
  dimsOn(srcT, key, page = 1) {
    const out = [];
    for (const g of this.groups()) for (const m of g.props.measured || []) {
      if (m.src?.t === srcT && m.src.key === key && (srcT === '3d' || (m.src.page || 1) === page)) out.push({ g, m });
    }
    return out;
  }

  // ---------------------------------------------------------------- drawing settings
  drawing(dkey) { const s = this.settings[dkey] || {}; return { multiplier: 1, pages: {}, markups: [], ...s }; }
  scaleOf(dkey, page) { return this.drawing(dkey).pages[page]?.scale || 0; }
  /** Working area of a page (CostX "Set Working Area"): { x0, y0, x1, y1 } in drawing units, or null. */
  areaOf(dkey, page) { return this.drawing(dkey).pages[page]?.area || null; }
  async setArea(dkey, page, area) {
    const s = this.drawing(dkey), pg = { ...(s.pages[page] || { scale: 0 }) };
    if (area) pg.area = area; else delete pg.area;
    s.pages = { ...s.pages, [page]: pg };
    return this.saveDrawing(dkey, s);
  }
  async saveDrawing(dkey, props) {
    const r = await this.api('PUT', `/projects/${this.projectId}/drawing-settings/${encodeURIComponent(dkey)}`, { props });
    this.settings[dkey] = r.props; this.emit('settings');
    return r.props;
  }
  /** New scale for one page: saves it and recalculates every dimension already measured on that page. */
  async setScale(dkey, page, scale, extra = {}) {
    const s = this.drawing(dkey);
    s.pages = { ...s.pages, [page]: { ...(s.pages[page]?.area ? { area: s.pages[page].area } : {}), scale, ...extra } };
    await this.saveDrawing(dkey, s);
    const n = await this.updateDims((m) => {
      if (m.src?.t === '3d' || m.src?.key !== dkey || (m.src.page || 1) !== page || !m.pts) return undefined;
      const q = measure2d(m.shape, m.pts, scale, m); if (!q) return undefined;
      return { ...m, value: q.value, ...(q.len != null ? { len: q.len } : {}), ...(q.bars != null ? { rebar: { ...m.rebar, bars: q.bars } } : {}) };
    });
    if (n) status(`Scale changed: ${n} dimension group(s) recalculated.`, 'ok');
  }
  /** Drawing multiplier (typical floors): every dimension on the drawing gets the new effective multiplier. */
  async setMultiplier(dkey, mult) {
    const s = this.drawing(dkey); s.multiplier = mult;
    await this.saveDrawing(dkey, s);
    await this.updateDims((m) => (m.src?.key === dkey && m.src.t !== '3d' ? { ...m, dmult: mult } : undefined));
  }
}

/** A new measured dimension for group g. */
export function makeDim(g, { shape, pts, value, len, src, sign = 1, dmult = 1, label, rebar }) {
  const n = (g.props.measured || []).length + 1;
  const base = { area: 'Area', length: 'Length', count: 'Count', distance: 'Distance', face: 'Face area', rebar: 'Rebar' }[shape] || 'Dimension';
  return { id: newId(), label: label || `${base} ${String(n).padStart(4, '0')}`, value, unit: UNIT[g.mtype], kind: src.t === '3d' ? '3d' : '2d',
    sign: sign < 0 ? -1 : 1, multiplier: 1, ...(dmult !== 1 ? { dmult } : {}), shape, src, pts, ...(len != null ? { len } : {}), ...(rebar ? { rebar } : {}), at: new Date().toISOString() };
}
/** Is the group's type one you can measure on screen? */
export const measurable = (g) => Boolean(g && shapeFor(g.mtype));
export function randomColor() {
  const h = Math.floor(Math.random() * 360);
  const f = (n) => { const k = (n + h / 30) % 12, a = 0.55 * Math.min(0.5, 1 - 0.5); const c = 0.5 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
  return `#${f(0)}${f(8)}${f(4)}`;
}
