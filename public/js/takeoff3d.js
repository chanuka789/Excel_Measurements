// 3D point-mode take-off (CostX "Point" mode in 3D): measure areas, lengths and counts by clicking on the model, or
// a whole flat face with one click, into the current dimension group. Dimensions keep their 3D points and are drawn on
// the model in their group's colour. Shared by the task pane and the 3D window.
import { shapeFor } from './geom2d.js';
import { makeDim, measurable } from './tkstore.js';
import { UNIT } from './dims.js';
import { fmt, uLabel } from './engine.js';

export class PointTakeoff {
  /** viewer: Viewer. store: TakeoffStore. o: { versionId(), label(), status(msg, kind), showAll() } */
  constructor(viewer, store, o) {
    this.v = viewer; this.store = store; this.o = o; this.sign = 1; this.sel = new Set();
    store.on(() => this.refresh());
  }
  get active() { return this.v.mode === 'points'; }
  src() { return { t: '3d', key: this.o.versionId(), page: 1, name: this.o.label?.() || '3D model' }; }
  /** Start measuring into the current group. face: one click takes the whole flat face (area groups). */
  start({ face = false } = {}) {
    const g = this.store.current();
    if (!this.store.canEdit()) return this.o.status('You have view access to this project: you cannot add dimensions.', 'warn');
    if (!g) return this.o.status('Choose the current dimension group first (Dimension Groups list, or the Measure menu).', 'warn');
    if (!measurable(g)) return this.o.status(`"${g.name}" is a ${g.mtype} group. Point measurement goes into Area, Length or Count groups.`, 'warn');
    if (face && g.mtype !== 'Area') return this.o.status('Face area goes into an Area group.', 'warn');
    const shape = face ? 'face' : shapeFor(g.mtype);
    const color = this.sign < 0 ? g.props.negColor || '#d13438' : g.props.posColor || '#107c10';
    this.v.startPoints(shape, { color, onDone: (r) => this.save(r), onHint: (t) => this.o.status(t, 'warn') });
    this.o.status({ area: 'Area: click the corners on the model, then Enter, double-click or right-click. Shift-click a face for its whole area.',
      length: 'Length: click points along the model, then Enter, double-click or right-click.', count: 'Count: click each item on the model.',
      face: 'Face area: click a flat face; its whole area is added.' }[shape] + ` Into "${g.name}"${this.sign < 0 ? ' (negative)' : ''}. Esc stops.`);
  }
  stop() { this.v.stopPoints(); }
  async save(r) {
    const g = this.store.current(); if (!g) return;
    const dim = makeDim(g, { shape: r.shape, pts: r.pts, value: r.value, len: r.len, src: this.src(), sign: this.sign });
    if (r.shape === 'face' && !r.pts.length) delete dim.pts;
    try {
      await this.store.addMeasured(g.id, [dim]);
      const u = UNIT[g.mtype];
      this.o.status(`${dim.label} added to "${g.name}": ${fmt(r.value, u === 'nr' ? '' : u)} ${uLabel(u)}${r.len != null ? ` · perimeter ${fmt(r.len, 'm')} m` : ''}.`, 'ok');
    } catch (err) { this.o.status(err.message, 'bad'); }
  }
  /** Draw the 3D dimensions of this model version (every group, or only the current one). */
  refresh() {
    const key = this.o.versionId(); if (!key) { this.v.setDims3d([]); return; }
    const cur = this.store.currentId(), all = this.o.showAll ? this.o.showAll() : true;
    const list = this.store.dimsOn('3d', key).filter(x => (all || x.g.id === cur) && this.store.isShown(x.g.id)).filter(x => x.m.pts?.length)
      .map(({ g, m }) => ({ id: m.id, shape: m.shape, pts: m.pts, neg: m.sign < 0, sel: this.sel.has(m.id), color: m.sign < 0 ? g.props.negColor || '#d13438' : g.props.posColor || '#107c10' }));
    this.v.setDims3d(list);
  }
}
