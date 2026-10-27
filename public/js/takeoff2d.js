// On-screen 2D take-off on drawings (PDF, images and the 2D sheets inside a DWFx), working like CostX:
// choose the current dimension group, then click on the drawing. The group's type decides what you measure:
// Area (click the corners, Enter / double-click / right-click to finish, Shift + two clicks for a rectangle),
// Length (click along the line, finish the same way) or Count (one click per item). Positive and negative
// (deduction) dimensions, a sticky cursor that snaps to drawing lines and line ends, angle snap, scale presets and
// calibration per page, a drawing multiplier for typical floors, markups, labels, legend, monochrome, rotate,
// select / move / rotate / mirror / copy / paste / delete dimensions. Every dimension is stored in its dimension
// group with its points, so it shows on the drawing again and is recalculated when the scale changes.
import { esc } from './core.js';
import { menu, dialog, ask, confirmIt } from './wui.js';
import * as G2 from './geom2d.js';
import { drawingKey, makeDim, measurable, newId, randomColor } from './tkstore.js';
import { UNIT, dimQuantity, displayUnit } from './dims.js';
import { fmt, uLabel } from './engine.js';
import { installExtras } from './tkextras.js';
import { drawingResponse } from './localfiles.js';

let pdfjs = null;
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  return pdfjs;
}
const nice = (v, u) => (v == null || !Number.isFinite(v) ? '' : fmt(v, u === 'nr' ? '' : u));
let clipboard = null;                    // copied dimensions: { items: [{ gid, m }], W, H }
const SVGNS = 'http://www.w3.org/2000/svg';

export class DrawingTakeoff {
  /**
   * host: element to fill. store: TakeoffStore. opts: { close: bool (show a Close button), onClose(), insertPicture(dataUrl),
   * onDimSelect(list of {gid, mid}) }
   */
  constructor(host, store, opts = {}) {
    this.host = host; this.store = store; this.o = opts;
    this.tool = 'select'; this.sign = 1; this.angle = false; this.snapOn = true; this.labels = true; this.legend = true;
    this.markupsOn = true; this.mono = false;
    this.showAll = !store.hasTree?.();     // in the measurement window the tree chooses what is shown (the groups or folder clicked)
    this.signShow = 0;                       // 0 both, 1 only positive, -1 only negative dimensions (ribbon Positive / Negative / Both)
    this.disp = { text: true, hatch: true, weight: true, white: false, lineStyles: true };   // drawing display (ribbon Display group)
    this.sel = new Set(); this.draft = null; this.hover = null; this.pending = [];
    this.z = 1; this.tx = 0; this.ty = 0; this.rot = 0; this.page = 1; this.pages = 1;
    this.unsub = store.on((w) => { if (w !== 'current') this.drawDims(); this.syncBar(); });
  }
  destroy() { this.closeCompare?.(); this.unsub?.(); this.renderTask?.cancel?.(); this.doc?.destroy?.(); this.pageCache?.forEach(b => b.close?.()); this.host.innerHTML = ''; document.removeEventListener('keyup', this.keyUp); }

  // ================================================================== open a drawing
  async open(d) {
    this.d = d; this.dkey = drawingKey(d); this.sel.clear(); this.draft = null; this.page = d.page || 1;
    this.host.innerHTML = `<div class="tk">
      <div class="tk-bar" role="toolbar" aria-label="Drawing take-off tools"></div>
      <div class="tk-view" tabindex="0" aria-label="Drawing. Click to measure into the current dimension group; Enter finishes; Esc cancels.">
        <div class="tk-page"><div class="tk-base"></div><svg class="tk-ov" xmlns="${SVGNS}"><defs></defs><g class="tk-dims"></g><g class="tk-mk"></g><g class="tk-draft"></g></svg></div>
        <div class="tk-tip" hidden></div><div class="tk-legend" hidden></div><div class="tk-load">Loading drawing…</div>
      </div>
      <div class="tk-stat" aria-live="polite"></div></div>`;
    this.el = { bar: this.q('.tk-bar'), view: this.q('.tk-view'), page: this.q('.tk-page'), base: this.q('.tk-base'), ov: this.q('.tk-ov'),
      dims: this.q('.tk-dims'), mk: this.q('.tk-mk'), draftG: this.q('.tk-draft'), defs: this.q('defs'), tip: this.q('.tk-tip'), legend: this.q('.tk-legend'),
      load: this.q('.tk-load'), stat: this.q('.tk-stat') };
    this.bindEvents();
    try {
      await this.store.load().catch(() => {});
      if (d.kind !== 'sheet' && /\.(dwg|dxf)$/i.test(d.name || '')) this.el.load.textContent = 'Reading the CAD drawing… (the first time can take a minute)';
      const res = await drawingResponse(d);
      const type = res.headers.get('content-type') || d.content_type || '', name = (d.name || '').toLowerCase();
      if (/pdf/.test(type) || name.endsWith('.pdf')) { this.kind = 'pdf'; const lib = await loadPdfJs(); this.doc = await lib.getDocument({ data: new Uint8Array(await res.arrayBuffer()), standardFontDataUrl: '/vendor/pdfjs-fonts/', cMapUrl: '/vendor/pdfjs-cmaps/', cMapPacked: true }).promise; this.pages = this.doc.numPages; this.ocg = await this.doc.getOptionalContentConfig().catch(() => null); }
      else if (/svg/.test(type) || d.kind === 'sheet' || name.endsWith('.svg')) { this.kind = d.kind === 'sheet' ? 'sheet' : /\.(dwg|dxf)$/.test(name) ? 'cad' : 'svg'; this.svgText = await res.text(); }
      else if (/image\//.test(type) || /\.(png|jpe?g|gif|webp|bmp)$/.test(name)) { this.kind = 'image'; this.imgUrl = URL.createObjectURL(await res.blob()); }
      else throw new Error('This file type cannot be measured here. Upload it as PDF or an image.');
      await this.showPage(Math.min(this.page, this.pages));
      this.el.load.hidden = true;
    } catch (err) { this.el.load.textContent = err.message; this.el.load.classList.add('bad'); }
    this.renderBar();
  }
  q(s) { return this.host.querySelector(s); }
  get paperMm() { return G2.PAPER_MM[this.kind] || 0; }
  /** Metres per drawing unit: the scale set for the page, or for CAD drawings the file's own units (1:1). */
  get scale() { return this.store.scaleOf(this.dkey, this.page) || this.cadUnit || 0; }
  /** Y stretch of this page when it was calibrated separately in X and Y. */
  get ky() { return this.store.kyOf?.(this.dkey, this.page) || 1; }
  kyFor(m) { return this.store.kyOf?.(m.src?.key || this.dkey, m.src?.page || this.page) || 1; }
  /** Tell the window (ribbon, status bar) that the tool, the page or the view changed. */
  changed() { this.o.onState?.(this); }
  get settings() { return this.store.drawing(this.dkey); }
  src() { return { t: this.d.kind === 'sheet' ? 's' : 'd', key: this.dkey, page: this.page, name: this.d.name + (this.pages > 1 ? ` (page ${this.page})` : '') }; }

  async showPage(n) {
    this.page = n; this.sel.clear(); this.draft = null; this.snapIdx = null;
    const base = this.el.base; base.innerHTML = '';
    if (this.kind === 'pdf') {
      this.pdfPage = await this.doc.getPage(n);
      const vp = this.pdfPage.getViewport({ scale: 1 }); this.W = vp.width; this.H = vp.height;
      this.baseScale = Math.min(3, Math.sqrt(9e6 / (this.W * this.H)));
      const c = document.createElement('canvas'); c.className = 'tk-canvas';
      const v2 = this.pdfPage.getViewport({ scale: this.baseScale }); c.width = Math.ceil(v2.width); c.height = Math.ceil(v2.height);
      base.append(c); this.baseCanvas = c;
      this.detail = document.createElement('canvas'); this.detail.className = 'tk-detail'; this.detail.hidden = true; base.append(this.detail);
      // pages seen before come from memory at once; a new page shows a quick low-resolution picture first,
      // and the sharp one is drawn while the user already works
      this.pageCache ||= new Map();
      const hit = this.pageCache.get(n), x = c.getContext('2d');
      if (hit) { x.drawImage(hit, 0, 0); this.pageCache.delete(n); this.pageCache.set(n, hit); }
      else {
        const ps = Math.min(0.75, this.baseScale / 3), pv = this.pdfPage.getViewport({ scale: ps });
        const pc = document.createElement('canvas'); pc.width = Math.ceil(pv.width); pc.height = Math.ceil(pv.height);
        await this.pdfPage.render({ canvasContext: pc.getContext('2d'), viewport: pv, ...this.layerOpt() }).promise.catch(() => {});
        x.drawImage(pc, 0, 0, c.width, c.height);
        const page = this.pdfPage;
        this.basePaint = (async () => {
          const full = document.createElement('canvas'); full.width = c.width; full.height = c.height;
          await page.render({ canvasContext: full.getContext('2d'), viewport: v2, ...this.layerOpt() }).promise;
          if (this.pdfPage !== page) return;
          x.drawImage(full, 0, 0);
          if (typeof createImageBitmap === 'function') { this.pageCache.set(n, await createImageBitmap(full)); while (this.pageCache.size > 6) { const [k, b] = this.pageCache.entries().next().value; b.close?.(); this.pageCache.delete(k); } }
        })().catch(() => {});
      }
      this.pdfVectors().catch(() => {});
    } else if (this.kind === 'sheet' || this.kind === 'svg' || this.kind === 'cad') {
      const holder = document.createElement('div'); holder.innerHTML = this.svgText;
      const el = holder.querySelector('svg'); if (!el) throw new Error('The drawing could not be read.');
      const vb = (el.getAttribute('viewBox') || `0 0 ${el.getAttribute('width') || 1000} ${el.getAttribute('height') || 700}`).split(/[ ,]+/).map(Number);
      this.W = vb[2]; this.H = vb[3];
      el.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`); el.removeAttribute('width'); el.removeAttribute('height');
      el.classList.add('tk-svg'); base.append(el); this.svgEl = el;
      this.cadUnit = this.kind === 'cad' ? Number(el.getAttribute('data-unit-m')) || 0 : 0;
      setTimeout(() => this.svgVectors(el), 0);
    } else {
      const img = new Image(); img.src = this.imgUrl; await img.decode(); this.W = img.naturalWidth; this.H = img.naturalHeight;
      img.className = 'tk-img'; img.alt = this.d.name; base.append(img); this.snapIdx = new G2.SnapIndex([]);
    }
    for (const x of [this.el.page, this.el.ov]) { x.style.width = this.W + 'px'; x.style.height = this.H + 'px'; }
    this.el.ov.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    this.closeCompare(); this.applyArea(); this.applyMono(); this.fit(); this.renderBar(); this.drawDims();
    if (this.kind === 'cad' && this.cadUnit && !this.store.scaleOf(this.dkey, this.page)) this.say(`CAD drawing in ${({ 0.001: 'millimetres', 0.01: 'centimetres', 1: 'metres', 0.0254: 'inches', 0.3048: 'feet' })[this.cadUnit] || this.cadUnit + ' m units'}: measured 1:1, no scale needed. Check one known length with Distance (M).`, 'ok');
    else if (!this.scale && this.store.canEdit()) this.say(this.paperMm ? 'Set the scale of this page first (Scale list, or Calibrate with a known length).' : 'This image has no scale: press Calibrate and click two points a known distance apart.', 'warn');
  }

  // ================================================================== drawing lines for the sticky cursor
  async pdfVectors() {
    const ops = await this.pdfPage.getOperatorList(), O = pdfjs.OPS, vt = this.pdfPage.getViewport({ scale: 1 }).transform;
    const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
    let ctm = [1, 0, 0, 1, 0, 0]; const stack = []; const segs = [];
    const P = (x, y) => { const m = mul(vt, ctm); return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; };
    for (let i = 0; i < ops.fnArray.length && segs.length < 1.6e6; i++) {
      const f = ops.fnArray[i], a = ops.argsArray[i];
      if (f === O.save) stack.push(ctm);
      else if (f === O.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (f === O.transform) ctm = mul(ctm, a);
      else if (f === O.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(a?.[0]) || a?.[0]?.length === 6) ctm = mul(ctm, [...a[0]]); }
      else if (f === O.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (f === O.constructPath) {
        const sub = a[0], c = a[1]; let k = 0, cur = null, start = null;
        const seg = (p) => { if (cur) segs.push(cur[0], cur[1], p[0], p[1]); cur = p; };
        for (const op of sub) {
          if (op === O.moveTo) { cur = start = P(c[k], c[k + 1]); k += 2; }
          else if (op === O.lineTo) { seg(P(c[k], c[k + 1])); k += 2; }
          else if (op === O.curveTo) { seg(P(c[k + 4], c[k + 5])); k += 6; }
          else if (op === O.curveTo2 || op === O.curveTo3) { seg(P(c[k + 2], c[k + 3])); k += 4; }
          else if (op === O.rectangle) { const [x, y, w, h] = [c[k], c[k + 1], c[k + 2], c[k + 3]]; k += 4; const r = [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)]; for (let j = 0; j < 4; j++) segs.push(...r[j], ...r[(j + 1) % 4]); cur = start = r[0]; }
          else if (op === O.closePath) { if (cur && start) seg(start); }
        }
      }
    }
    this.snapIdx = new G2.SnapIndex(segs);
    this.say(`${this.snapIdx.size.toLocaleString()} drawing lines found: the cursor snaps to them (hold B to stop snapping).`);
  }
  svgVectors(svg) {
    const segs = [];
    const root = svg.getCTM()?.inverse();
    for (const el of svg.querySelectorAll('path, line, polyline, polygon, rect')) {
      if (segs.length > 1.6e6) break;
      if (el.closest('[display="none"]')) continue;
      const m0 = el.getCTM?.(); if (!m0) continue;
      const m = root ? root.multiply(m0) : m0;
      const T = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
      let local = [];
      const tag = el.tagName.toLowerCase();
      if (tag === 'path') local = G2.pathSegments(el.getAttribute('d'));
      else if (tag === 'line') local = ['x1', 'y1', 'x2', 'y2'].map(k => Number(el.getAttribute(k)) || 0);
      else if (tag === 'rect') { const x = +el.getAttribute('x') || 0, y = +el.getAttribute('y') || 0, w = +el.getAttribute('width') || 0, h = +el.getAttribute('height') || 0; if (w < this.W * 0.98) local = [x, y, x + w, y, x + w, y, x + w, y + h, x + w, y + h, x, y + h, x, y + h, x, y]; }
      else { const p = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number); for (let i = 2; i + 1 < p.length; i += 2) local.push(p[i - 2], p[i - 1], p[i], p[i + 1]); if (tag === 'polygon' && p.length > 3) local.push(p[p.length - 2], p[p.length - 1], p[0], p[1]); }
      for (let i = 0; i + 3 < local.length; i += 4) { const a = T(local[i], local[i + 1]), b = T(local[i + 2], local[i + 3]); segs.push(a[0], a[1], b[0], b[1]); }
    }
    this.snapIdx = new G2.SnapIndex(segs);
  }

  // ================================================================== view: zoom, pan, rotate
  matrix() { const r = this.rot * Math.PI / 180; return [Math.cos(r), Math.sin(r)]; }
  toScreen(p) { const [c, s] = this.matrix(); return [this.tx + this.z * (p[0] * c - p[1] * s), this.ty + this.z * (p[0] * s + p[1] * c)]; }
  toPage(s) { const [c, sn] = this.matrix(); const x = (s[0] - this.tx) / this.z, y = (s[1] - this.ty) / this.z; return [x * c + y * sn, -x * sn + y * c]; }
  evPage(e) { const r = this.el.view.getBoundingClientRect(); return this.toPage([e.clientX - r.left, e.clientY - r.top]); }
  apply() {
    this.el.page.style.transform = `translate(${this.tx}px, ${this.ty}px) rotate(${this.rot}deg) scale(${this.z})`;
    cancelAnimationFrame(this.rafDims); this.rafDims = requestAnimationFrame(() => { this.drawDims(); this.drawDraft(); });
    clearTimeout(this.detailTimer); this.detailTimer = setTimeout(() => this.renderDetail(), 180);
    const zl = this.host.querySelector('[data-k=zoom]'); if (zl) zl.textContent = Math.round(this.z * 100) + '%';
  }
  fit(box = null) {
    if (!this.el?.view || !this.W) return;                 // not loaded yet
    const vw = this.el.view.clientWidth || 600, vh = this.el.view.clientHeight || 400;
    const pad = box ? Math.max(this.W, this.H) * 0.02 : 0, wa = !box && this.areaHere();
    const b = box ? { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad } : wa || { x0: 0, y0: 0, x1: this.W, y1: this.H };
    const save = [this.tx, this.ty]; this.tx = 0; this.ty = 0; const zz = this.z; this.z = 1;
    const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(p => this.toScreen(p));
    const xs = corners.map(c => c[0]), ys = corners.map(c => c[1]);
    const w = Math.max(...xs) - Math.min(...xs) || 1, h = Math.max(...ys) - Math.min(...ys) || 1;
    this.z = Math.min(vw / w, vh / h) * (box ? 0.7 : 0.96);
    if (!Number.isFinite(this.z) || this.z <= 0) { this.z = zz; [this.tx, this.ty] = save; return; }
    this.tx = vw / 2 - this.z * (Math.min(...xs) + w / 2); this.ty = vh / 2 - this.z * (Math.min(...ys) + h / 2);
    this.apply();
  }
  zoomAt(f, sx, sy) {
    const p = this.toPage([sx, sy]);
    this.z = Math.min(Math.max(this.z * f, 0.02), 400);
    const s = this.toScreen(p); this.tx += sx - s[0]; this.ty += sy - s[1];
    this.apply();
  }
  rotate(deg) {
    const vw = this.el.view.clientWidth / 2, vh = this.el.view.clientHeight / 2, p = this.toPage([vw, vh]);
    this.rot = (this.rot + deg + 360) % 360;
    const s = this.toScreen(p); this.tx += vw - s[0]; this.ty += vh - s[1]; this.apply();
  }
  /** Sharp PDF detail for the visible part when zoomed in beyond the base picture. */
  async renderDetail() {
    if (this.kind !== 'pdf' || !this.pdfPage) return;
    const dpr = window.devicePixelRatio || 1, want = this.z * dpr;
    if (want <= this.baseScale * 1.05) { this.detail.hidden = true; return; }
    const vw = this.el.view.clientWidth, vh = this.el.view.clientHeight;
    const cs = [[0, 0], [vw, 0], [vw, vh], [0, vh]].map(p => this.toPage(p));
    const x0 = Math.max(0, Math.min(...cs.map(c => c[0]))), y0 = Math.max(0, Math.min(...cs.map(c => c[1])));
    const x1 = Math.min(this.W, Math.max(...cs.map(c => c[0]))), y1 = Math.min(this.H, Math.max(...cs.map(c => c[1])));
    if (x1 <= x0 || y1 <= y0) return;
    const sc = Math.min(want, Math.sqrt(1.6e7 / ((x1 - x0) * (y1 - y0))));
    const c = document.createElement('canvas'); c.className = 'tk-detail';
    c.width = Math.ceil((x1 - x0) * sc); c.height = Math.ceil((y1 - y0) * sc);
    this.renderTask?.cancel?.();
    const vp = this.pdfPage.getViewport({ scale: sc });
    this.renderTask = this.pdfPage.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: [1, 0, 0, 1, -x0 * sc, -y0 * sc], ...this.layerOpt() });
    try { await this.renderTask.promise; } catch { return; }
    Object.assign(c.style, { left: x0 + 'px', top: y0 + 'px', width: (x1 - x0) + 'px', height: (y1 - y0) + 'px' });
    this.detail.replaceWith(c); this.detail = c;
  }
  // ================================================================== layers (PDF optional content)
  layerOpt() { return this.ocg ? { optionalContentConfigPromise: Promise.resolve(this.ocg) } : {}; }
  layerList() {
    if (this.kind === 'cad') return [...(this.svgEl?.querySelectorAll('g[data-layer]') || [])].map(g => ({ id: g.dataset.layer, name: g.dataset.layer, on: g.getAttribute('display') !== 'none' }));
    const groups = this.ocg?.getGroups?.() || {}; return Object.entries(groups).map(([id, g]) => ({ id, name: g.name || id, on: g.visible }));
  }
  setLayer(id, on) {
    if (this.kind === 'cad') { const g = [...this.svgEl.querySelectorAll('g[data-layer]')].find(x => x.dataset.layer === id); if (g) { if (on) g.removeAttribute('display'); else g.setAttribute('display', 'none'); } }
    else this.ocg?.setVisibility(id, on);
  }
  async rerender() {
    if (this.kind !== 'pdf') return;
    this.pageCache?.forEach(b => b.close?.()); this.pageCache?.clear();             // layers changed: the kept pictures are out of date
    const c = this.baseCanvas, x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height);
    await this.pdfPage.render({ canvasContext: x, viewport: this.pdfPage.getViewport({ scale: this.baseScale }), ...this.layerOpt() }).promise.catch(() => {});
    this.renderDetail();
  }
  async layers() {
    const list = this.layerList();
    if (!list.length) return this.say(this.kind === 'pdf' ? 'This PDF has no layers.' : 'Layers are available for CAD drawings and PDFs that have them.', 'warn');
    const r = await dialog({ title: 'Layers', body: `<p class="hint">Hide layers you do not need, so it is easier to see and measure. The drawing file is not changed.</p>
      <div class="row"><button type="button" data-l="all">Show All</button><button type="button" data-l="none">Hide All</button><button type="button" data-l="inv">Invert</button></div>
      <div class="dg-list">${list.map(l => `<label class="check"><input type="checkbox" data-id="${esc(l.id)}" ${l.on ? 'checked' : ''}> ${esc(l.name)}</label>`).join('')}</div>`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', value: 'ok', primary: true }],
      onOpen: (d) => d.querySelectorAll('[data-l]').forEach(b => b.onclick = () => d.querySelectorAll('[data-id]').forEach(c => { c.checked = b.dataset.l === 'all' ? true : b.dataset.l === 'none' ? false : !c.checked; })),
      validate: (d) => { d.querySelectorAll('[data-id]').forEach(c => this.setLayer(c.dataset.id, c.checked)); return ''; } });
    if (r) {
      if (this.kind === 'cad') this.svgVectors(this.svgEl); else await this.rerender();          // snapping follows the visible layers
      this.say('Layers updated: the cursor snaps only to visible layers.', 'ok');
    }
  }
  applyMono() {
    const b = this.el.base; b.classList.toggle('mono', this.mono);
    b.classList.toggle('no-text', !this.disp.text); b.classList.toggle('no-hatch', !this.disp.hatch); b.classList.toggle('thin', !this.disp.weight);
    this.el.page.classList.toggle('white', this.disp.white);
  }
  /** Drawing display options (ribbon Display group). Text, hatching and line weight apply to CAD and SVG drawings. */
  setDisplay(key, on) { this.disp[key] = on ?? !this.disp[key]; this.applyMono(); this.changed(); }
  get vector() { return ['cad', 'svg', 'sheet'].includes(this.kind); }

  // ================================================================== toolbar
  renderBar() {
    const st = this.store, g = st.current(), groups = st.groups(), ed = st.canEdit();
    const opt = (x) => `<option value="${x.id}" ${x.id === g?.id ? 'selected' : ''}>${esc(x.name)} (${x.mtype})</option>`;
    const ratio = this.settings.pages[this.page]?.ratio, sc = this.scale;
    const scaleLabel = !sc ? 'Not set' : this.cadUnit && !this.store.scaleOf(this.dkey, this.page) ? '1:1 (CAD units)' : ratio ? `1:${Math.round(ratio * 100) / 100}` : this.settings.pages[this.page]?.calibrated ? 'Calibrated' : 'Custom';
    const b = (k, label, title, pressed) => `<button class="vbtn" data-k="${k}" title="${esc(title)}" ${pressed != null ? `aria-pressed="${Boolean(pressed)}"` : ''}>${esc(label)}</button>`;
    this.el.bar.innerHTML = `
      <span class="tk-grp"><label class="sr-only" for="tkCur">Current dimension group</label>
        <select class="input small" id="tkCur" title="Current dimension group: measurements go into it">${'<option value="">Current group: none</option>'}${groups.map(opt).join('')}</select>
        ${b('newgrp', '+ Group', 'Add a dimension group (Area, Length or Count) and make it current')}</span>
      <span class="sep"></span>
      ${b('select', 'Select', 'Select, move and edit dimensions (Esc)', this.tool === 'select')}
      ${b('measure', 'Measure', 'Measure into the current group: click points; Enter, double-click or right-click finishes; Shift + 2 clicks = rectangle', this.tool === 'measure')}
      ${b('sign', this.sign < 0 ? 'Negative' : 'Positive', 'New dimensions are positive, or negative (deductions such as openings)', this.sign < 0)}
      ${b('distance', 'Distance', 'Measure distance (M): click points, nothing is saved', this.tool === 'distance')}
      ${b('rebar', 'Rebar', 'Rebar mode (Length group): click the spacing line, then one bar; set the spacing', this.tool === 'rebar')}
      ${b('autocount', 'Auto Count', 'Auto Count (Count group): capture a symbol and find every copy on the drawing', this.tool === 'autocount' || this.tool === 'capture')}
      <span class="sep"></span>
      <label class="tk-scale" title="Scale of this page">Scale <select class="input small" id="tkScale" ${ed ? '' : 'disabled'}>
        <option value="">${esc(scaleLabel)}</option>${this.paperMm ? G2.RATIOS.map(r => `<option value="${r}">1:${r}</option>`).join('') : ''}
        <option value="cal">Calibrate…</option>${this.paperMm ? '<option value="custom">Custom 1:…</option>' : ''}</select></label>
      <span class="sep"></span>
      ${b('zout', '−', 'Zoom out (mouse wheel)')}<span class="tk-z" data-k="zoom">${Math.round(this.z * 100)}%</span>${b('zin', '+', 'Zoom in (mouse wheel)')}
      ${b('fit', 'Extents', 'Zoom extents: the whole page (F)')}
      ${this.pages > 1 ? `<span class="tk-pg">${b('prev', '◀', 'Previous page')}<span>${this.page} / ${this.pages}</span>${b('next', '▶', 'Next page')}</span>` : ''}
      ${b('view', 'View ▾', 'Snap, angle snap, rotate, labels, legend, markups, monochrome, drawing properties and picture')}
      ${this.o.close ? b('close', 'Close', 'Close the drawing') : ''}`;
    this.el.bar.querySelector('#tkCur').onchange = (e) => { this.store.setCurrent(e.target.value || null); this.cancelDraft(); this.syncBar(); this.drawDims(); };
    this.el.bar.querySelector('#tkScale').onchange = (e) => this.scaleChoice(e.target.value);
    this.el.bar.querySelectorAll('[data-k]').forEach(x => x.onclick = () => this.act(x.dataset.k));
    this.syncBar();
    this.changed();
  }
  syncBar() {
    if (!this.el?.bar) return;
    const cur = this.el.bar.querySelector('#tkCur');
    if (cur && cur.options.length - 1 !== this.store.groups().length) return this.renderBar();
    if (cur) cur.value = this.store.currentId() || '';
    const g = this.store.current(), key = `${this.tool}|${g?.id}|${this.sign}`;
    if (key === this.hintKey) return;                  // only when the tool, the group or the sign changes
    this.hintKey = key;
    if (this.tool === 'measure') this.say(g ? this.hintFor(g) : 'Choose the current dimension group first (or + Group).');
  }
  hintFor(g) {
    if (!measurable(g)) return `"${g.name}" is a ${g.mtype} group. On drawings, measure into Area, Length or Count groups (use Default Display Volume with a height for volumes).`;
    return { Area: 'Area: click each corner, then Enter, double-click or right-click. Shift-click two corners for a rectangle. Backspace removes the last point.',
      Length: 'Length: click along the line, then Enter, double-click or right-click. Backspace removes the last point.',
      Count: 'Count: click each item.' }[g.mtype] + (this.sign < 0 ? ' (negative)' : '');
  }
  act(k) {
    switch (k) {
      case 'newgrp': return this.newGroup();
      case 'select': this.setTool('select'); break;
      case 'measure': this.setTool('measure'); break;
      case 'sign': this.sign = -this.sign; this.renderBar(); break;
      case 'distance': this.setTool(this.tool === 'distance' ? 'select' : 'distance'); break;
      case 'rebar': this.setTool(this.tool === 'rebar' ? 'select' : 'rebar'); break;
      case 'autocount': if (this.ac) this.acStop(); else this.acStart(); break;
      case 'angle': this.angle = !this.angle; this.renderBar(); break;
      case 'snap': this.snapOn = !this.snapOn; this.renderBar(); break;
      case 'zin': this.zoomAt(1.25, this.el.view.clientWidth / 2, this.el.view.clientHeight / 2); break;
      case 'zout': this.zoomAt(0.8, this.el.view.clientWidth / 2, this.el.view.clientHeight / 2); break;
      case 'fit': this.fit(); break;
      case 'rot': this.rotate(90); break;
      case 'prev': if (this.page > 1) this.showPage(this.page - 1); break;
      case 'next': if (this.page < this.pages) this.showPage(this.page + 1); break;
      case 'labels': this.labels = !this.labels; this.renderBar(); this.drawDims(); break;
      case 'legend': this.legend = !this.legend; this.renderBar(); this.drawDims(); break;
      case 'markups': this.markupsOn = !this.markupsOn; this.renderBar(); this.drawDims(); break;
      case 'mono': this.mono = !this.mono; this.applyMono(); this.renderBar(); break;
      case 'all': this.showAll = !this.showAll; this.renderBar(); this.drawDims(); break;
      case 'props': return this.drawingProps();
      case 'view': return this.viewMenu();
      case 'shot': return this.picture();
      case 'close': this.destroy(); this.o.onClose?.(); break;
    }
  }
  viewMenu() {
    const r = this.el.bar.querySelector('[data-k=view]').getBoundingClientRect();
    menu([
      { label: 'Snap to Drawing Lines', key: 'hold B: off', checked: this.snapOn, run: () => this.act('snap') },
      { label: 'Angle Snap (15°)', key: 'A', checked: this.angle, run: () => this.act('angle') }, '-',
      { label: 'Rotate', items: [90, 180, 270].map(d => ({ label: `${d}°`, run: () => this.rotate(d) })) },
      { label: 'Reset View', run: () => { this.rot = 0; this.fit(); } }, '-',
      { label: 'Labels', checked: this.labels, run: () => this.act('labels') },
      { label: 'Legend', checked: this.legend, run: () => this.act('legend') },
      { label: 'Markups', checked: this.markupsOn, run: () => this.act('markups') },
      { label: 'Monochrome Drawing', checked: this.mono, run: () => this.act('mono') },
      { label: 'Set Working Area', title: 'Show, snap and search only part of the drawing', run: () => this.setTool('warea') },
      { label: 'Reset Working Area', disabled: !this.areaHere(), run: () => this.resetWorkingArea() },
      { label: this.cmp ? 'Close Comparison' : 'Compare with Another Drawing...', disabled: !this.cmp && !this.o.drawings, run: () => (this.cmp ? this.closeCompare() : this.compareWith()) }, '-',
      { label: 'Layers...', disabled: !this.layerList().length, title: this.layerList().length ? '' : 'This drawing has no layers', run: () => this.layers() },
      { label: 'Show Every Dimension Group', checked: this.showAll, title: 'Off: only the dimension group or folder chosen in the tree', run: () => this.act('all') }, '-',
      { label: 'Drawing Properties...', run: () => this.drawingProps() },
      { label: 'Picture of the Drawing', run: () => this.picture() }, '-', { label: 'Close Menu' }], r.left, r.bottom + 2);
  }
  setTool(t) {
    if ((t === 'measure' || t === 'rebar') && !this.ready()) return;
    if (t === 'rebar' && this.store.current()?.mtype !== 'Length') { this.say('Rebar mode measures into a Length group: choose one as the current group (or + Group).', 'warn'); return; }
    this.cancelDraft(); this.tool = t;
    this.el.view.style.cursor = t === 'select' ? '' : 'crosshair';
    this.renderBar(); this.el.view.focus();
    if (t === 'distance') this.say('Distance: click points along the line. Double-click or Enter to finish. Nothing is saved.');
    if (t === 'calibrate') this.say('Calibrate: click the two ends of a length you know (for example a dimension line).');
    if (t === 'rebar') this.say('Rebar: click the two ends of the spacing line (the distance the bars cover).');
    if (t === 'warea') this.say('Working area: drag a box around the part of the drawing to keep.');
    if (t === 'zarea') this.say('Zoom area: drag a box around the part to zoom to.');
    if (t === 'selarea') this.say('Select in area: drag a box; the dimensions fully inside are selected (Ctrl adds).');
  }
  /** Is everything in place to measure into the current group? Explains what is missing. */
  ready() {
    const g = this.store.current();
    if (!this.store.canEdit()) { this.say('You have view access to this project: you cannot add dimensions.', 'warn'); return false; }
    if (!g) { this.newGroup(); return false; }
    if (!measurable(g)) { this.say(this.hintFor(g), 'warn'); return false; }
    if (!this.scale) { this.say('Set the scale of this page first: choose it in the Scale list, or Calibrate.', 'warn'); this.el.bar.querySelector('#tkScale')?.focus(); return false; }
    return true;
  }
  say(msg, kind = '') { if (this.el?.stat) { this.el.stat.textContent = msg || ''; this.el.stat.className = 'tk-stat ' + kind; } }

  async newGroup() {
    if (await newGroupDialog(this.store, (m, k) => this.say(m, k))) { this.renderBar(); this.setTool('measure'); }
  }
  async scaleChoice(v) {
    const sel = this.el.bar.querySelector('#tkScale');
    if (!v) return;
    if (v === 'cal') { sel.value = ''; return this.setTool('calibrate'); }
    let ratio = Number(v);
    if (v === 'custom') { ratio = await ask('Custom scale', 'Scale 1 :', '100', { type: 'number', hint: 'For a 1:75 drawing, enter 75.' }); if (!ratio || ratio <= 0) { this.renderBar(); return; } }
    const all = this.pages > 1 && await dialog({ title: 'Scale', body: `<p>Use 1:${ratio} for every page of this drawing, or only page ${this.page}?</p>`, buttons: [{ label: 'This page', value: null }, { label: 'All pages', value: 'all', primary: true }] }) === 'all';
    await this.saveScale(G2.scaleFromRatio(ratio, this.paperMm), { ratio, resetY: true }, all);
  }
  async saveScale(scale, extra, allPages = false) {
    try {
      for (const p of allPages ? Array.from({ length: this.pages }, (_, i) => i + 1) : [this.page]) await this.store.setScale(this.dkey, p, scale, extra);
      this.say(`Scale set${allPages ? ' for every page' : ''}. Measured dimensions on this drawing were recalculated.`, 'ok');
    } catch (err) { this.say(err.message, 'bad'); }
    this.renderBar(); this.drawDims();
  }
  async drawingProps() {
    const s = this.settings; let v = null;
    const r = await dialog({ title: 'Drawing properties', body: `<div class="dg-form">
      <label>Name:</label><span>${esc(this.d.name)}</span>
      <label>Page:</label><span>${this.page} of ${this.pages}</span>
      <label>Paper unit:</label><span>${this.paperMm ? `${this.paperMm.toFixed(4)} mm per drawing unit` : 'none (image: calibrate)'}</span>
      <label>Scale (this page):</label><span>${this.scale ? `${(this.scale * 1000).toPrecision(5)} mm per drawing unit${s.pages[this.page]?.ratio ? ` · 1:${s.pages[this.page].ratio}` : ''}` : 'not set'}</span>
      <label for="dpM">Drawing multiplier:</label><input class="input" id="dpM" type="number" step="any" min="0" value="${s.multiplier || 1}" ${this.store.canEdit() ? '' : 'disabled'}>
      </div><p class="hint">The drawing multiplier repeats every dimension on this drawing, for example 10 for a typical floor plan used for ten floors. Effective multiplier = dimension multiplier × drawing multiplier.</p>`,
      buttons: [{ label: 'Cancel', value: null }, { label: 'Update', value: 'ok', primary: true }],
      validate: (d) => { v = Number(d.querySelector('#dpM').value); return v > 0 ? '' : 'The multiplier must be more than 0.'; } });
    if (!r || v === (s.multiplier || 1)) return;
    try { await this.store.setMultiplier(this.dkey, v); this.say(`Drawing multiplier ${v}: every dimension on this drawing updated.`, 'ok'); } catch (err) { this.say(err.message, 'bad'); }
  }

  // ================================================================== events
  bindEvents() {
    const v = this.el.view;
    let down = null, panning = false;
    this.keys = new Set();
    const inPanel = (e) => Boolean(e.target.closest?.('.tk-panel, .tk-legend'));      // the floating panels handle their own clicks
    v.addEventListener('wheel', (e) => { if (inPanel(e)) return; e.preventDefault(); const r = v.getBoundingClientRect(); this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    v.addEventListener('pointerdown', (e) => {
      if (inPanel(e)) return;
      v.focus();
      const p = this.evPage(e);
      down = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, p, btn: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
      panning = e.button === 1 || (e.button === 0 && this.keys.has(' '));
      if (e.button === 0 && !panning && ['warea', 'capture', 'zarea', 'selarea'].includes(this.tool)) { down.box = true; down.rectTool = this.tool; }
      else if (e.button === 0 && !panning && this.cmp?.align) down.cmp = { dx: this.cmp.dx, dy: this.cmp.dy };
      if (e.button === 0 && !panning && this.tool === 'select') {
        const mk = this.hitMarkup(p);
        if (mk) { down.markup = mk; }
        else {
          const h = this.hitHandle(p);
          if (h) down.handle = h;
          else {
            const hit = this.hitDim(p);
            if (hit && down.ctrl && this.sel.has(hit.m.id)) { this.sel.delete(hit.m.id); this.drawDims(); this.emitSel(); }
            else if (hit && this.sel.has(hit.m.id)) down.move = true;
            else if (hit) { if (!down.ctrl) this.sel.clear(); this.sel.add(hit.m.id); down.move = true; this.drawDims(); this.emitSel(); }
            else if (e.shiftKey) down.box = true;
          }
        }
      }
      v.setPointerCapture(e.pointerId);
      if (e.button === 1) e.preventDefault();
    });
    v.addEventListener('pointermove', (e) => {
      const p = this.evPage(e);
      this.cursor = p; this.cursorScreen = [e.clientX, e.clientY];
      this.o.onCursor?.(p, this);
      if (down) {
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        if (down.cmp) { this.cmp.dx = down.cmp.dx + (p[0] - down.p[0]) / this.cmp.k; this.cmp.dy = down.cmp.dy + (p[1] - down.p[1]) / this.cmp.k; this.moveCompare(); return; }
        if (moved > 4 && !down.box && !down.move && !down.handle && !down.markup && (panning || down.btn === 0)) panning = true;
        if (panning) { this.tx = down.tx + e.clientX - down.x; this.ty = down.ty + e.clientY - down.y; this.apply(); return; }
        if (down.box && moved > 4) { this.boxRect = [down.p, p]; this.drawDraft(); return; }
        if ((down.move || down.handle || down.markup) && moved > 3) { this.dragTo(down, this.snapPoint(p, true)); return; }
        return;
      }
      if (this.tool === 'select') this.hoverAt(p, e);
      else this.drawDraft();
    });
    v.addEventListener('pointerup', (e) => {
      const d = down; down = null;
      if (!d) return;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (panning) { panning = false; if (moved > 4) return; }
      if (d.cmp) return;
      if (d.box) {
        const q = this.evPage(e); this.boxRect = null; this.drawDraft();
        if (d.rectTool === 'warea') return this.setWorkingArea(d.p, q);
        if (d.rectTool === 'capture') return this.acCapture(d.p, q);
        if (d.rectTool === 'zarea') { this.setTool('select'); return this.fit({ x0: Math.min(d.p[0], q[0]), y0: Math.min(d.p[1], q[1]), x1: Math.max(d.p[0], q[0]), y1: Math.max(d.p[1], q[1]) }); }
        if (d.rectTool === 'selarea') { this.setTool('select'); return this.boxSelect(d.p, q, d.ctrl); }
        this.boxSelect(d.p, q, d.ctrl); return;
      }
      if ((d.move || d.handle || d.markup) && moved > 3) { this.dragEnd(d); return; }
      if (e.button !== 0 || moved > 4) return;
      const p = this.snapPoint(this.evPage(e));
      if (this.tool === 'select') { if (!this.hitDim(d.p) && !d.ctrl && !d.markup) { this.sel.clear(); this.drawDims(); this.emitSel(); } return; }
      this.click(p, e);
    });
    v.addEventListener('dblclick', (e) => { if (inPanel(e)) return; e.preventDefault(); if (this.draft) this.finish(); else if (this.tool === 'select') { const h = this.hitDim(this.evPage(e)); if (h) this.editDim(h); } });
    v.addEventListener('contextmenu', (e) => {
      if (inPanel(e)) return;
      e.preventDefault();
      if (this.draft && this.draft.pts.length) { this.finish(); return; }
      this.contextMenu(this.evPage(e), e.clientX, e.clientY);
    });
    v.addEventListener('pointerleave', () => { this.el.tip.hidden = true; this.cursor = null; this.drawDraft(); });
    v.addEventListener('keydown', (e) => this.onKey(e));
    this.keyUp = (e) => { this.keys.delete(e.key.toLowerCase()); if (e.key === ' ') this.keys.delete(' '); };
    document.addEventListener('keyup', this.keyUp);
    new ResizeObserver(() => { if (this.W && !this.userMoved) this.fit(); }).observe(v);
    v.addEventListener('pointerdown', () => { this.userMoved = true; }, { once: true });
  }
  onKey(e) {
    const k = e.key.toLowerCase();
    this.keys.add(k === ' ' ? ' ' : k);
    if (k === ' ') { e.preventDefault(); return; }
    if (k === 'escape') { if (this.draft) this.cancelDraft(); else if (this.tool !== 'select') this.setTool('select'); else { this.sel.clear(); this.drawDims(); this.emitSel(); } e.preventDefault(); return; }
    if (k === 'enter') { if (this.draft && this.draft.shape !== 'rebar') { this.finish(); e.preventDefault(); } return; }
    if (k === 'backspace') { if (this.draft?.pts.length) { this.draft.pts.pop(); if (!this.draft.pts.length) this.draft = null; this.drawDraft(); } e.preventDefault(); return; }
    if (k === 'delete') { if (this.sel.size) this.deleteSel(); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); this.visibleDims().forEach(x => this.sel.add(x.m.id)); this.drawDims(); this.emitSel(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'c') { e.preventDefault(); this.copySel(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'v') { e.preventDefault(); this.paste(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'm') this.setTool(this.tool === 'distance' ? 'select' : 'distance');
    else if (k === 'a') { this.angle = !this.angle; this.renderBar(); this.say(this.angle ? 'Angle snap on (15° steps).' : 'Angle snap off.'); }
    else if (k === 'f') this.fit();
    else if (k === '+' || k === '=') this.act('zin');
    else if (k === '-') this.act('zout');
  }

  // ================================================================== snapping
  snapPoint(p, noAngle = false) {
    if (!p) return p;
    const tol = 9 / this.z;
    let q = p, kind = '';
    if (this.snapOn && !this.keys.has('b')) {
      const extra = [];
      for (const { m } of this.dimsHere()) if (!this.dragging?.ids?.has(m.id)) G2.pairs(m.pts || []).forEach(x => extra.push(x));
      if (this.draft) G2.pairs(G2.flat(this.draft.pts)).forEach(x => extra.push(x));
      const s = this.inArea(p) ? this.snapIdx?.find(p, tol, extra) : null;
      if (s) { q = s.p; kind = s.kind; }
    }
    const last = this.draft?.pts[this.draft.pts.length - 1];
    if (!noAngle && this.angle && last && kind !== 'end') q = G2.angleSnap(last, q);
    this.snapKind = kind;
    return q;
  }

  // ================================================================== measuring
  click(p, e) {
    if (this.tool === 'rebar') { if (this.ready()) this.rebarClick(p); return; }
    if (this.tool === 'autocount') return this.acClick(p, e);
    if (this.tool === 'measure') {
      const g = this.store.current(); if (!this.ready()) return;
      if (g.mtype === 'Count') return this.addCount(g, p);
      if (!this.draft) { this.draft = { pts: [p], shape: g.mtype === 'Area' ? 'area' : 'length', rect: e.shiftKey && g.mtype === 'Area' }; }
      else if (this.draft.rect) { this.draft.pts = G2.pairs(G2.rectPts(this.draft.pts[0], p)); this.finish(); return; }
      else this.draft.pts.push(p);
      this.drawDraft(); return;
    }
    if (this.tool === 'distance' || this.tool === 'calibrate') {
      if (!this.draft) this.draft = { pts: [p], shape: 'distance' };
      else this.draft.pts.push(p);
      if (this.tool === 'calibrate' && this.draft.pts.length === 2) { this.calibrate(); return; }
      this.drawDraft(); return;
    }
    if (this.tool === 'markup') { this.addMarkup(p); }
  }
  cancelDraft() { this.draft = null; this.drawDraft(); }
  async finish() {
    const d = this.draft; if (!d) return;
    d.pts = d.pts.filter((p, i) => !i || Math.hypot(p[0] - d.pts[i - 1][0], p[1] - d.pts[i - 1][1]) > 1e-9);   // a double-click adds the last point twice
    if (this.tool === 'distance') {
      const q = G2.measure2d('distance', G2.flat(d.pts), this.scale, { ky: this.ky });
      this.say(q ? `Distance: ${q.value.toFixed(3)} m` : 'Set the scale to read distances in metres.', q ? 'ok' : 'warn');
      this.draft = null; this.drawDraft(); return;
    }
    if (this.tool !== 'measure') return;
    const g = this.store.current(), pts = G2.flat(d.pts);
    const q = G2.measure2d(d.shape, pts, this.scale, { ky: this.ky });
    if (!q) { this.say(d.shape === 'area' ? 'An area needs at least 3 points.' : 'A length needs at least 2 points.', 'warn'); return; }
    this.draft = null; this.drawDraft();
    const dim = makeDim(g, { shape: d.shape, pts, value: q.value, len: q.len, src: this.src(), sign: this.sign, dmult: this.settings.multiplier || 1 });
    try {
      await this.store.addMeasured(g.id, [dim]);
      const u = UNIT[g.mtype];
      this.say(`${dim.label} added to "${g.name}": ${nice(q.value, u)} ${uLabel(u)}${q.len != null ? ` · perimeter ${nice(q.len, 'm')} m` : ''}${this.sign < 0 ? ' (negative)' : ''}.`, 'ok');
      if (this.o.propsOnAdd?.()) { const x = this.dimsHere().find(y => y.m.id === dim.id); if (x) this.editDim(x); }      // Properties on Add
    } catch (err) { this.say(err.message, 'bad'); }
  }
  addCount(g, p) {
    const dim = makeDim(g, { shape: 'count', pts: [p[0], p[1]], value: 1, src: this.src(), sign: this.sign, dmult: this.settings.multiplier || 1 });
    dim.label = `Count ${String((g.props.measured || []).length + this.pending.length + 1).padStart(4, '0')}`;
    this.pending.push({ gid: g.id, m: dim }); this.drawDims();
    clearTimeout(this.countTimer);
    this.countTimer = setTimeout(() => this.flushCounts(), 500);
    this.say(`Count: ${(g.props.measured || []).filter(m => m.src?.key === this.dkey).length + this.pending.length} on this drawing in "${g.name}".`);
  }
  async flushCounts() {
    const list = this.pending; this.pending = [];
    const by = new Map(); list.forEach(x => { if (!by.has(x.gid)) by.set(x.gid, []); by.get(x.gid).push(x.m); });
    try { for (const [gid, ms] of by) await this.store.addMeasured(gid, ms); } catch (err) { this.say(err.message, 'bad'); }
    this.drawDims();
  }
  /** Calibrate X or Y separately (scanned drawings stretched more one way): Y keeps the X scale and stores the stretch. */
  calibrateAxis(axis) {
    if (axis === 'y' && !this.store.scaleOf(this.dkey, this.page)) return this.say('Calibrate X (or set the scale) first, then calibrate Y.', 'warn');
    this.calAxis = axis; this.setTool('calibrate');
    this.say(`Calibrate ${axis.toUpperCase()}: click the two ends of a ${axis === 'x' ? 'horizontal' : 'vertical'} length you know.`);
  }
  async resetCalibration() {
    if (!this.store.scaleOf(this.dkey, this.page)) return this.say('This page has no scale to reset.');
    if (!await confirmIt('Reset calibration', 'Remove the scale of this page? Dimensions already measured keep their values until you set a new scale.')) return;
    try { await this.store.setScale(this.dkey, this.page, 0, { resetY: true }); this.say('Calibration reset. Set the scale again before measuring.', 'ok'); } catch (err) { this.say(err.message, 'bad'); }
    this.renderBar(); this.drawDims();
  }
  async calibrate() {
    const [a, b] = this.draft.pts; this.draft = null; this.drawDraft();
    const axis = this.calAxis; this.calAxis = null;
    const units = axis === 'x' ? Math.abs(b[0] - a[0]) || Math.hypot(b[0] - a[0], b[1] - a[1]) : axis === 'y' ? Math.abs(b[1] - a[1]) || Math.hypot(b[0] - a[0], b[1] - a[1]) : Math.hypot(b[0] - a[0], b[1] - a[1]);
    let metres = null, all = false;
    const r = await dialog({ title: 'Calibrate', body: `<label class="field">Real length between the two points (m)<input class="input" id="clV" type="number" step="any" min="0" autofocus placeholder="e.g. 4.5"></label>
      ${this.pages > 1 ? '<label class="check"><input type="checkbox" id="clAll"> Use for every page</label>' : ''}
      <p class="hint">Tip: zoom in and click the two ends of a long dimension line. The longer the line, the more accurate the scale.</p>`,
      validate: (d) => { metres = Number(d.querySelector('#clV').value); all = Boolean(d.querySelector('#clAll')?.checked); return metres > 0 ? '' : 'Enter the length in metres.'; } });
    this.setTool('select');
    if (!r) return;
    const scale = metres / units;
    if (axis === 'y') { const sx = this.store.scaleOf(this.dkey, this.page); return this.saveScale(sx, { calibrated: true, ky: scale / sx }, all); }
    await this.saveScale(scale, { calibrated: true, ...(axis === 'x' ? {} : { resetY: true }), ...(this.paperMm ? { ratio: Math.round(G2.ratioFromScale(scale, this.paperMm) * 100) / 100 } : {}) }, all);
  }

  // ================================================================== dimensions on this page
  dimsHere() { return this.store.dimsOn(this.d.kind === 'sheet' ? 's' : 'd', this.dkey, this.page); }
  visibleDims() { const cur = this.store.currentId(); return this.dimsHere().filter(x => (this.showAll || x.g.id === cur || this.store.isShown?.(x.g.id)) && (!this.signShow || (x.m.sign < 0 ? -1 : 1) === this.signShow)); }
  hitDim(p) {
    const tol = 6 / this.z; let best = null, bestD = tol, bestA = Infinity;
    for (const x of this.visibleDims()) {
      const d = G2.distToShape(p, x.m.shape, x.m.pts || [], x.m.holes);
      const a = x.m.shape === 'area' ? G2.polyArea(x.m.pts) : 0;
      if (d < bestD || (d === 0 && bestD === 0 && a < bestA)) { best = x; bestD = d; bestA = a; }
    }
    return best;
  }
  hitHandle(p) {
    if (this.sel.size !== 1) return null;
    const x = this.dimsHere().find(y => this.sel.has(y.m.id)); if (!x || x.m.shape === 'count') return null;
    const P = G2.pairs(x.m.pts); const tol = 6 / this.z;
    const i = P.findIndex(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < tol);
    return i >= 0 ? { x, i } : null;
  }
  hoverAt(p, e) {
    const h = this.hitDim(p);
    const id = h?.m.id || null;
    if (id !== this.hover) { this.hover = id; this.drawDims(); }
    const tip = this.el.tip;
    if (!h) { tip.hidden = true; return; }
    const g = h.g, m = h.m, u = UNIT[g.mtype], du = displayUnit(g), qty = dimQuantity(g, m.value, m);
    tip.innerHTML = `<strong>${esc(m.label)}</strong><br>Group: ${esc(g.name)}<br>${g.mtype} = ${esc(nice(m.value, u))} ${uLabel(u)}${m.len != null ? `<br>Perimeter = ${esc(nice(m.len, 'm'))} m` : ''}${m.holes?.length ? `<br>Cutouts: ${m.holes.length}` : ''}${m.shape === 'rebar' ? `<br>Bars = ${m.rebar?.bars} at ${m.rebar?.spacing} m${m.rebar?.extra ? ` · +${m.rebar.extra} m per bar` : ''}` : ''}
      ${du !== u ? `<br>${({ m: 'Length', m2: 'Area', m3: 'Volume', nr: 'Count' })[du]} = ${esc(nice(qty, du))} ${uLabel(du)}` : ''}${(m.multiplier || 1) * (m.dmult || 1) !== 1 ? `<br>Effective multiplier = ${(m.multiplier || 1) * (m.dmult || 1)}` : ''}${m.sign < 0 ? '<br><em>Negative (deduction)</em>' : ''}`;
    tip.hidden = false; this.placeTip(e.clientX, e.clientY);
  }
  /** Keep the tooltip inside the drawing view, next to the cursor. */
  placeTip(cx, cy) {
    const tip = this.el.tip, r = this.el.view.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    let x = cx - r.left + 14, y = cy - r.top + 14;
    if (x + w > r.width - 4) x = Math.max(4, cx - r.left - w - 10);
    if (y + h > r.height - 4) y = Math.max(4, cy - r.top - h - 10);
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  boxSelect(a, b, add) {
    if (!add) this.sel.clear();
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    for (const x of this.visibleDims()) { const bb = G2.bbox(x.m.pts || []); if (bb.x0 >= x0 && bb.x1 <= x1 && bb.y0 >= y0 && bb.y1 <= y1) this.sel.add(x.m.id); }
    this.drawDims(); this.emitSel();
    this.say(`${this.sel.size} dimension(s) selected. Right-click for options; Delete removes them; Ctrl+C copies.`);
  }
  emitSel() { this.o.onDimSelect?.(this.dimsHere().filter(x => this.sel.has(x.m.id)).map(x => ({ gid: x.g.id, mid: x.m.id }))); }
  /** Select and zoom to a dimension (from the Dimensions list). */
  async focusDim(mid) {
    const x = this.store.groups().flatMap(g => (g.props.measured || []).map(m => ({ g, m }))).find(y => y.m.id === mid);
    if (!x || x.m.src?.key !== this.dkey) return false;
    if ((x.m.src.page || 1) !== this.page) await this.showPage(x.m.src.page || 1);
    this.sel = new Set([mid]); this.fit(G2.bbox(x.m.pts || [])); this.drawDims();
    return true;
  }

  /** Select and zoom to several dimensions of this drawing (a whole group linked to an Excel cell). */
  async focusDims(ids) {
    const want = new Set(ids);
    const list = this.store.groups().flatMap(g => (g.props.measured || []).map(m => ({ g, m }))).filter(y => want.has(y.m.id) && y.m.src?.key === this.dkey);
    if (!list.length) return false;
    const pages = new Map(); list.forEach(y => pages.set(y.m.src.page || 1, (pages.get(y.m.src.page || 1) || 0) + 1));
    const page = [...pages].sort((a, b) => b[1] - a[1])[0][0];
    if (page !== this.page) await this.showPage(page);
    const here = list.filter(y => (y.m.src.page || 1) === page);
    this.sel = new Set(here.map(y => y.m.id));
    this.fit(G2.bbox(here.flatMap(y => y.m.pts || []))); this.drawDims();
    return true;
  }

  // ================================================================== editing selected dimensions
  selected() { return this.dimsHere().filter(x => this.sel.has(x.m.id)); }
  async updateSel(fn, msg) {
    const ids = new Set(this.sel);
    try { await this.store.updateDims((m, g) => (ids.has(m.id) ? fn(m, g) : undefined)); if (msg) this.say(msg, 'ok'); } catch (err) { this.say(err.message, 'bad'); }
    this.drawDims();
  }
  /** Scale of the page a dimension was taken on (not the page on screen: a queued edit may run after you change page). */
  scaleFor(m) {
    const key = m.src?.key || this.dkey, page = m.src?.page || this.page;
    return this.store.scaleOf(key, page) || (key === this.dkey ? this.cadUnit || 0 : 0);
  }
  recalc(m, pts) {
    const q = G2.measure2d(m.shape, pts, this.scaleFor(m), { ...m, ky: this.kyFor(m) });
    return q ? { ...m, pts, value: q.value, ...(q.len != null ? { len: q.len } : {}), ...(q.bars != null ? { rebar: { ...m.rebar, bars: q.bars } } : {}) } : { ...m, pts };
  }
  /** Apply a point transform to a dimension (its cutout holes too) and recalculate it. */
  xform(m, f) { return this.recalc(m.holes ? { ...m, holes: m.holes.map(f) } : m, f(m.pts)); }
  async deleteSel() {
    if (!this.sel.size || !this.store.canEdit()) return;
    const n = this.sel.size;
    if (n > 1 && !await confirmIt('Delete dimensions', `Delete ${n} dimensions?`)) return;
    await this.updateSel(() => null, `${n} dimension(s) deleted.`); this.sel.clear(); this.emitSel();
  }
  dragTo(d, p) {
    const dx = p[0] - d.p[0], dy = p[1] - d.p[1];
    if (d.markup) { this.dragging = { markup: d.markup, dx, dy }; }
    else if (d.handle) { this.dragging = { ids: new Set([d.handle.x.m.id]), handle: d.handle, p }; }
    else this.dragging = { ids: new Set(this.sel), dx, dy };
    this.drawDims();
  }
  async dragEnd() {
    const dr = this.dragging; this.dragging = null;
    if (!dr || !this.store.canEdit()) { this.drawDims(); return; }
    if (dr.markup) { const s = this.settings; s.markups = s.markups.map(k => (k.id === dr.markup.m.id ? (dr.markup.part === 'text' ? { ...k, tx: k.tx + dr.dx, ty: k.ty + dr.dy } : { ...k, x: k.x + dr.dx, y: k.y + dr.dy }) : k)); await this.store.saveDrawing(this.dkey, s).catch(err => this.say(err.message, 'bad')); this.drawDims(); return; }
    if (dr.handle) {
      const id = dr.handle.x.m.id, i = dr.handle.i;
      await this.store.updateDims((m) => { if (m.id !== id) return undefined; const pts = [...m.pts]; pts[2 * i] = dr.p[0]; pts[2 * i + 1] = dr.p[1]; return this.recalc(m, pts); });
    } else await this.updateSel((m) => this.xform(m, (p) => G2.movePts(p, dr.dx, dr.dy)), 'Moved.');
    this.drawDims();
  }
  transformSel(kind) {
    const all = this.selected().flatMap(x => x.m.pts || []); if (!all.length) return;
    const b = G2.bbox(all), c = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
    return this.updateSel((m) => this.xform(m, (p) => (kind === 'rot' ? G2.rotatePts(p, 90, c) : G2.mirrorPts(p, kind, c))), kind === 'rot' ? 'Rotated 90°.' : 'Mirrored.');
  }
  copySel() {
    const items = this.selected(); if (!items.length) return this.say('Select dimensions first (click, Ctrl+click or Shift+drag).', 'warn');
    clipboard = { items: items.map(x => ({ gid: x.g.id, m: JSON.parse(JSON.stringify(x.m)) })), W: this.W, H: this.H };
    try { localStorage.setItem('dwfxDimClip', JSON.stringify(clipboard)); } catch { /* storage blocked */ }
    this.say(`${items.length} dimension(s) copied. Open another drawing (or page) and press Ctrl+V to paste them in the same place.`, 'ok');
  }
  async paste() {
    let clip = clipboard; try { clip = clip || JSON.parse(localStorage.getItem('dwfxDimClip') || 'null'); } catch { /* storage blocked */ }
    if (!clip?.items?.length) return this.say('Nothing copied yet: select dimensions and press Ctrl+C.', 'warn');
    if (!this.store.canEdit()) return;
    if (!this.scale) return this.say('Set the scale of this page before pasting dimensions.', 'warn');
    const dx = (this.W - clip.W) / 2, dy = (this.H - clip.H) / 2;               // same position relative to the centre of the drawing
    const by = new Map(); const ids = [];
    for (const it of clip.items) {
      const g = this.store.group(it.gid) || this.store.current(); if (!g) continue;
      const holes = it.m.holes?.map(h => G2.movePts(h, dx, dy));
      const pts = G2.movePts(it.m.pts, dx, dy), q = G2.measure2d(it.m.shape, pts, this.scale, { ...it.m, holes, ky: this.ky }) || { value: it.m.value };
      const m = { ...it.m, id: newId(), pts, ...(holes ? { holes } : {}), value: q.value, ...(q.len != null ? { len: q.len } : {}), src: this.src(), dmult: this.settings.multiplier || 1, at: new Date().toISOString() };
      if (m.dmult === 1) delete m.dmult;
      if (!by.has(g.id)) by.set(g.id, []); by.get(g.id).push(m); ids.push(m.id);
    }
    try { for (const [gid, list] of by) await this.store.addMeasured(gid, list); this.sel = new Set(ids); this.say(`${ids.length} dimension(s) pasted. Drag them to adjust; right-click to rotate or mirror.`, 'ok'); }
    catch (err) { this.say(err.message, 'bad'); }
    this.drawDims();
  }
  async editDim(x) {
    const g = x.g, m = x.m, u = UNIT[g.mtype], du = displayUnit(g); let v = null;
    const r = await dialog({ title: 'Dimension properties', body: `<div class="dg-form">
      <label for="dmN">Name:</label><input class="input" id="dmN" value="${esc(m.label)}" ${this.store.canEdit() ? '' : 'disabled'}>
      <label>Group:</label><span>${esc(g.name)} (${g.mtype})</span>
      <label for="dmM">Multiplier:</label><span><input class="input" id="dmM" type="number" step="any" value="${m.multiplier ?? 1}" ${this.store.canEdit() ? '' : 'disabled'}> × drawing ${m.dmult || 1} = ${(m.multiplier ?? 1) * (m.dmult || 1)}</span>
      ${m.shape === 'rebar' ? `<label for="dmSp">Spacing (m):</label><input class="input" id="dmSp" type="number" step="any" min="0" value="${m.rebar?.spacing ?? 0.2}" ${this.store.canEdit() ? '' : 'disabled'}>
      <label for="dmEx">Extra per bar (m):</label><input class="input" id="dmEx" type="number" step="any" value="${m.rebar?.extra ?? 0}" ${this.store.canEdit() ? '' : 'disabled'}>
      <label>Bars:</label><span>${m.rebar?.bars ?? ''}</span>` : ''}
      <label for="dmS">Type:</label><select class="input" id="dmS" ${this.store.canEdit() ? '' : 'disabled'}><option value="1" ${m.sign >= 0 ? 'selected' : ''}>Positive</option><option value="-1" ${m.sign < 0 ? 'selected' : ''}>Negative (deduction)</option></select>
      <label>${g.mtype}:</label><span>${esc(nice(m.value, u))} ${uLabel(u)}</span>
      ${m.len != null ? `<label>Perimeter:</label><span>${esc(nice(m.len, 'm'))} m</span>` : ''}
      <label>Quantity:</label><span>${esc(nice(dimQuantity(g, m.value, m), du))} ${uLabel(du)}</span>
      <label>Drawing:</label><span>${esc(m.src?.name || '')}</span>
      <label>Date added:</label><span>${esc(new Date(m.at || Date.now()).toLocaleString())}</span></div>`,
      buttons: this.store.canEdit() ? [{ label: 'Cancel', value: null }, { label: 'Update', value: 'ok', primary: true }] : [{ label: 'Close', value: null }],
      validate: (d) => {
        v = { label: d.querySelector('#dmN').value.trim() || m.label, multiplier: Number(d.querySelector('#dmM').value), sign: Number(d.querySelector('#dmS').value) };
        if (m.shape === 'rebar') { v.rebar = { ...m.rebar, spacing: Number(d.querySelector('#dmSp').value), extra: Number(d.querySelector('#dmEx').value) || 0 }; if (!(v.rebar.spacing > 0)) return 'Enter the spacing.'; }
        return Number.isFinite(v.multiplier) ? '' : 'Enter a multiplier.'; } });
    if (!r) return;
    this.sel = new Set([m.id]);
    await this.updateSel((x0) => (m.shape === 'rebar' ? this.recalc({ ...x0, ...v }, x0.pts) : { ...x0, ...v }), 'Dimension updated.');
  }
  async moveToGroup() {
    const items = this.selected(); if (!items.length) return;
    const types = new Set(items.map(x => x.g.mtype));
    if (types.size > 1) return this.say('Choose dimensions of one measurement type to move them.', 'warn');
    const mtype = [...types][0], targets = this.store.groups().filter(g => g.mtype === mtype);
    let to = null;
    const r = await dialog({ title: 'Move to another dimension group', body: `<label class="field">Dimension group (${mtype})<select class="input" id="mgG">${targets.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>`,
      validate: (d) => { to = d.querySelector('#mgG').value; return to ? '' : 'Choose a group.'; } });
    if (!r) return;
    const moving = items.filter(x => x.g.id !== to).map(x => ({ ...x.m }));
    const ids = new Set(moving.map(m => m.id));
    try { await this.store.updateDims((m) => (ids.has(m.id) ? null : undefined)); await this.store.addMeasured(to, moving); this.say(`${moving.length} dimension(s) moved.`, 'ok'); } catch (err) { this.say(err.message, 'bad'); }
    this.drawDims();
  }

  // ================================================================== markups
  markupsHere() { return (this.settings.markups || []).filter(m => m.page === this.page); }
  hitMarkup(p) {
    if (!this.markupsOn) return null;
    for (const m of this.markupsHere()) {
      const w = m.text.length * m.size * 0.6 + m.size, h = m.size * 1.6;
      if (p[0] >= m.tx - 4 / this.z && p[0] <= m.tx + w && p[1] >= m.ty - h && p[1] <= m.ty + 4 / this.z) return { m, part: 'text' };
      if (Math.hypot(p[0] - m.x, p[1] - m.y) < 6 / this.z) return { m, part: 'point' };
    }
    return null;
  }
  async addMarkup(p, edit = null) {
    if (!this.store.canEdit()) return;
    let text = null, size = null;
    const r = await dialog({ title: edit ? 'Edit markup' : 'Add markup', body: `<label class="field">Markup text<textarea class="input" id="muT" maxlength="500" autofocus>${esc(edit?.text || '')}</textarea></label>
      <label class="field">Size<input class="input" id="muS" type="number" min="6" max="96" value="${edit?.size || Math.round(Math.max(8, Math.min(40, this.H / 60)))}"></label>`,
      buttons: [{ label: 'Cancel', value: null }, { label: edit ? 'Update' : 'Insert', value: 'ok', primary: true }],
      validate: (d) => { text = d.querySelector('#muT').value.trim(); size = Number(d.querySelector('#muS').value) || 12; return text ? '' : 'Type the markup text.'; } });
    this.setTool('select');
    if (!r) return;
    const s = this.settings;
    s.markups = edit ? s.markups.map(m => (m.id === edit.id ? { ...m, text, size } : m))
      : [...(s.markups || []), { id: newId(), page: this.page, x: p[0], y: p[1], tx: p[0] + 20 / this.z, ty: p[1] - 20 / this.z, text, size }];
    try { await this.store.saveDrawing(this.dkey, s); this.markupsOn = true; this.renderBar(); } catch (err) { this.say(err.message, 'bad'); }
    this.drawDims();
  }
  async deleteMarkup(m) { const s = this.settings; s.markups = s.markups.filter(x => x.id !== m.id); await this.store.saveDrawing(this.dkey, s).catch(err => this.say(err.message, 'bad')); this.drawDims(); }
  async markupSize(f) { const s = this.settings; s.markups = s.markups.map(m => (m.page === this.page ? { ...m, size: Math.max(6, Math.min(96, Math.round(m.size * f))) } : m)); await this.store.saveDrawing(this.dkey, s).catch(() => {}); this.drawDims(); }

  // ================================================================== right-click menu
  contextMenu(p, x, y) {
    const mk = this.hitMarkup(p);
    if (mk) return menu([{ label: 'Edit Markup...', run: () => this.addMarkup(null, mk.m) }, { label: 'Delete Markup', run: () => this.deleteMarkup(mk.m) }, '-', { label: 'Close Menu' }], x, y);
    const h = this.hitDim(p);
    if (h && !this.sel.has(h.m.id)) { this.sel = new Set([h.m.id]); this.drawDims(); this.emitSel(); }
    const ed = !this.store.canEdit(), n = this.sel.size;
    const hh = h?.m.holes?.length ? h : this.visibleDims().find(x => x.m.holes?.length && G2.holeAt(p, x.m.holes) >= 0);   // a click inside a hole
    const hole = hh ? G2.holeAt(p, hh.m.holes, 6 / this.z) : -1;
    const negSel = this.selected().some(x => x.m.shape === 'area' && x.m.sign < 0);
    const dimItems = n || hole >= 0 ? [
      { label: 'Convert to Cutout', disabled: ed || !negSel, title: negSel ? 'Cut the selected negative area out of the positive areas it overlaps' : 'Select a negative area dimension first', run: () => this.convertToCutout() },
      ...(hole >= 0 ? [{ label: 'Remove Cutout', disabled: ed, run: () => this.removeCutout(hh, hole) }] : []), '-',
      { label: `Edit Dimension Properties...`, disabled: n !== 1, run: () => this.editDim(this.selected()[0]) },
      { label: 'Move Dimension to Another Dimension Group...', disabled: ed, run: () => this.moveToGroup() },
      { label: 'Change Multiplier...', disabled: ed, run: async () => { const v = await ask('Change multiplier', 'Multiplier', '1', { type: 'number' }); if (v != null) this.updateSel(m => ({ ...m, multiplier: v }), 'Multiplier changed.'); } },
      { label: 'Make Negative', disabled: ed, run: () => this.updateSel(m => ({ ...m, sign: -1 }), 'Made negative.') },
      { label: 'Make Positive', disabled: ed, run: () => this.updateSel(m => ({ ...m, sign: 1 }), 'Made positive.') }, '-',
      { label: 'Copy Dimensions', key: 'Ctrl+C', run: () => this.copySel() },
      { label: 'Rotate 90°', disabled: ed, run: () => this.transformSel('rot') },
      { label: 'Mirror Left-Right', disabled: ed, run: () => this.transformSel('x') },
      { label: 'Mirror Up-Down', disabled: ed, run: () => this.transformSel('y') }, '-',
      { label: `Delete Dimension${n > 1 ? 's' : ''}`, key: 'Del', disabled: ed, run: () => this.deleteSel() }, '-'] : [];
    menu([...dimItems,
      { label: 'Paste Dimensions', key: 'Ctrl+V', disabled: ed, run: () => this.paste() },
      { label: 'Select All Dimensions', key: 'Ctrl+A', run: () => { this.visibleDims().forEach(z => this.sel.add(z.m.id)); this.drawDims(); this.emitSel(); } }, '-',
      { label: 'Rotate', items: [90, 180, 270].map(d => ({ label: `${d}°`, run: () => this.rotate(d) })) },
      { label: 'Zoom Extents', run: () => this.fit() },
      { label: 'Reset View', run: () => { this.rot = 0; this.fit(); } }, '-',
      { label: 'Create Markup...', disabled: ed, run: () => this.addMarkup(p) },
      { label: this.markupsOn ? 'Hide Markups' : 'Show Markups', run: () => this.act('markups') },
      { label: 'Increase Markup Size', disabled: ed, run: () => this.markupSize(1.25) },
      { label: 'Decrease Markup Size', disabled: ed, run: () => this.markupSize(0.8) }, '-',
      { label: 'Close Menu' }], x, y);
  }

  // ================================================================== drawing the overlay
  pattern(color, cross = false) {
    const id = 'tkh' + (cross ? 'x' : '') + color.replace('#', ''), k = 8 / this.z;
    if (!this.el.defs.querySelector('#' + id)) {
      const line = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${3 / this.z}" stroke-opacity=".55"/>`;
      this.el.defs.insertAdjacentHTML('beforeend', `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${k}" height="${k}" patternTransform="rotate(45)"><rect width="${k}" height="${k}" fill="${color}" fill-opacity=".12"/>${line(0, 0, 0, k)}${cross ? line(0, 0, k, 0) : ''}</pattern>`);
    }
    return `url(#${id})`;
  }
  /** Fill of an area dimension: the group's pattern for positive or negative dimensions (Solid, Hatch, Cross Hatch, Outline). */
  areaFill(g, neg, col, sel) {
    const kind = neg ? (g.props.negPattern || 'Hatch') : (g.props.posPattern || 'Solid');
    if (kind === 'Outline') return 'fill="none"';
    if (kind === 'Hatch' || kind === 'Cross Hatch') return `fill="${this.pattern(col, kind === 'Cross Hatch')}" fill-opacity="1"`;
    return `fill="${col}" fill-opacity="${sel ? 0.45 : 0.3}"`;
  }
  drawDims() {
    if (!this.el?.dims || !this.W) return;
    const z = this.z, cur = this.store.currentId(), out = [], labels = [];
    const list = [...this.visibleDims(), ...this.pending.filter(x => x.m.src.page === this.page).map(x => ({ g: this.store.group(x.gid), m: x.m, pending: true }))].filter(x => x.g);
    const dr = this.dragging;
    const sw = (k) => `stroke-width="${k / z}"`;              // screen pixels (the page is scaled with a CSS transform)
    this.el.defs.innerHTML = '';
    for (const { g, m } of list) {
      let pts = m.pts || [], holes = m.holes || [];
      if (dr?.ids?.has(m.id)) { pts = dr.handle ? (() => { const q = [...pts]; q[2 * dr.handle.i] = dr.p[0]; q[2 * dr.handle.i + 1] = dr.p[1]; return q; })() : G2.movePts(pts, dr.dx, dr.dy); if (!dr.handle) holes = holes.map(h => G2.movePts(h, dr.dx, dr.dy)); }
      const neg = m.sign < 0, col = neg ? (g.props.negColor || '#d13438') : (g.props.posColor || '#107c10');
      const sel = this.sel.has(m.id), hov = this.hover === m.id, dim = this.showAll && g.id !== cur ? ' opacity=".75"' : '';
      const stroke = sel ? '#0078d4' : hov ? '#0a5ab0' : col, w = sel || hov ? 3 : 2;
      const P = G2.pairs(pts).map(q => q.join(',')).join(' ');
      if (m.shape === 'area' && holes.length) {
        const ring = (r) => 'M' + G2.pairs(r).map(q => q.join(',')).join('L') + 'Z';
        out.push(`<path d="${ring(pts)}${holes.map(ring).join('')}" fill-rule="evenodd" ${this.areaFill(g, neg, col, sel)} stroke="${stroke}" ${sw(w)}${dim}/>`);
      } else if (m.shape === 'area') out.push(`<polygon points="${P}" ${this.areaFill(g, neg, col, sel)} stroke="${stroke}" ${sw(w)}${dim}/>`);
      else if (m.shape === 'rebar') out.push(this.rebarSvg(m, pts, col, z, sel || hov));
      else if (m.shape === 'length') out.push(`<polyline points="${P}" fill="none" stroke="${stroke}" ${sw(w + 2)} stroke-linecap="round" stroke-linejoin="round"${neg ? ` stroke-dasharray="${6 / z} ${4 / z}"` : ''}${dim}/>`);
      else if (m.shape === 'count') { const r = 6 / z; out.push(`<circle cx="${pts[0]}" cy="${pts[1]}" r="${r}" fill="${col}" fill-opacity=".85" stroke="${sel ? '#0078d4' : '#fff'}" ${sw(sel ? 3 : 1.5)}${dim}/>${neg ? `<line x1="${pts[0] - r}" y1="${pts[1]}" x2="${pts[0] + r}" y2="${pts[1]}" stroke="#fff" ${sw(2)}/>` : ''}`); }
      if (sel && this.sel.size === 1 && m.shape !== 'count' && m.shape !== 'rebar') G2.pairs(pts).forEach(q => out.push(`<rect x="${q[0] - 4 / z}" y="${q[1] - 4 / z}" width="${8 / z}" height="${8 / z}" fill="#fff" stroke="#0078d4" ${sw(1.5)}/>`));
      if (this.labels && m.shape !== 'count') {
        const c = m.shape === 'area' ? G2.centroid(pts) : G2.pairs(pts)[Math.floor(G2.pairs(pts).length / 2)] || [0, 0];
        const u = UNIT[g.mtype];
        labels.push(`<text x="${c[0]}" y="${c[1]}" font-size="${11 / z}" text-anchor="middle" class="tk-lbl"><tspan x="${c[0]}" font-weight="600">${esc(m.label)}</tspan><tspan x="${c[0]}" dy="${13 / z}">${m.shape === 'rebar' ? `${m.rebar?.bars || 0} bars · ` : ''}${esc(nice(m.value, u))} ${uLabel(u)}</tspan></text>`);
      }
    }
    this.el.dims.innerHTML = this.areaSvg(z) + out.join('') + labels.join('') + this.acSvg(z);
    // markups
    this.el.mk.innerHTML = !this.markupsOn ? '' : this.markupsHere().map(m0 => {
      let m = m0;
      if (dr?.markup?.m.id === m.id) m = dr.markup.part === 'text' ? { ...m, tx: m.tx + dr.dx, ty: m.ty + dr.dy } : { ...m, x: m.x + dr.dx, y: m.y + dr.dy };
      const w = m.text.length * m.size * 0.6 + m.size, h = m.size * 1.6;
      return `<line x1="${m.x}" y1="${m.y}" x2="${m.tx}" y2="${m.ty - h / 2}" stroke="${m.color}" ${sw(1.5)}/><circle cx="${m.x}" cy="${m.y}" r="${3 / z}" fill="${m.color}"/>
        <rect x="${m.tx - m.size / 2}" y="${m.ty - h}" width="${w}" height="${h}" fill="#fff" fill-opacity=".9" stroke="${m.color}" ${sw(1.5)} rx="${m.size / 4}"/>
        <text x="${m.tx}" y="${m.ty - m.size * 0.45}" font-size="${m.size}" fill="${m.color}" font-family="Arial, sans-serif">${esc(m.text)}</text>`;
    }).join('');
    this.drawLegend(list);
  }
  drawLegend(list) {
    const box = this.el.legend;
    if (!this.legend || !list.length) { box.hidden = true; return; }
    const by = new Map();
    for (const { g, m } of list) { if (!by.has(g.id)) by.set(g.id, { g, total: 0, n: 0 }); const t = by.get(g.id); t.total += dimQuantity(g, m.value, m) || 0; t.n++; }
    box.innerHTML = `<div class="tk-lh">On this page</div>${[...by.values()].map(({ g, total, n }) => `<div class="tk-lr${g.id === this.store.currentId() ? ' cur' : ''}"><span class="sw" style="background:${esc(g.props.posColor || '#107c10')}"></span><span class="nm" title="${esc(g.name)}">${esc(g.name)}</span><span class="q">${esc(nice(total, displayUnit(g)))} ${uLabel(displayUnit(g))}</span><span class="n">${n}</span></div>`).join('')}`;
    box.hidden = false;
  }
  drawDraft() {
    const gEl = this.el?.draftG; if (!gEl) return;
    const z = this.z, out = [], sw = (k) => `stroke-width="${k / z}"`, dash = `stroke-dasharray="${5 / z} ${3 / z}"`;
    const cur = this.cursor && this.tool !== 'select' ? this.snapPoint(this.cursor) : null;
    if (this.boxRect) { const [a, b] = this.boxRect; out.push(`<rect x="${Math.min(a[0], b[0])}" y="${Math.min(a[1], b[1])}" width="${Math.abs(b[0] - a[0])}" height="${Math.abs(b[1] - a[1])}" fill="#0f6cbd" fill-opacity=".08" stroke="#0f6cbd" ${dash} ${sw(1)}/>`); }
    const d = this.draft;
    const g = this.store.current();
    const col = this.tool === 'measure' && g ? (this.sign < 0 ? g.props.negColor || '#d13438' : g.props.posColor || '#107c10') : '#c50f1f';
    let tipText = '';
    if (d) {
      let pts = d.pts.map(p => [...p]);
      if (cur) pts = d.rect ? G2.pairs(G2.rectPts(d.pts[0], cur)) : [...pts, cur];
      const P = pts.map(q => q.join(',')).join(' ');
      if (d.shape === 'rebar') {
        const ln = (a, b2, dashed) => (a && b2 ? `<line x1="${a[0]}" y1="${a[1]}" x2="${b2[0]}" y2="${b2[1]}" stroke="${col}" ${sw(dashed ? 2 : 3)} ${dashed ? dash : ''}/>` : '');
        out.push(ln(pts[0], pts[1], true), ln(pts[2], pts[3], false));
      } else if (d.shape === 'area' && pts.length >= 3) out.push(`<polygon points="${P}" fill="${col}" fill-opacity=".2" stroke="${col}" ${sw(2)} ${dash}/>`);
      else out.push(`<polyline points="${P}" fill="none" stroke="${col}" ${sw(2)} ${dash}/>`);
      pts.forEach(q => out.push(`<circle cx="${q[0]}" cy="${q[1]}" r="${3 / z}" fill="${col}"/>`));
      const q = G2.measure2d(d.shape, G2.flat(pts), this.scale || 0, { ky: this.ky });
      if (d.shape === 'rebar' && this.scale && pts.length >= 2) { const last = pts.length >= 4 ? [pts[2], pts[3]] : pts.length === 3 ? [pts[2], pts[2]] : [pts[0], pts[1]]; tipText = `${pts.length <= 2 ? 'Spacing line' : 'Bar'} ${(Math.hypot(last[1][0] - last[0][0], last[1][1] - last[0][1]) * this.scale).toFixed(3)} m`; }
      else if (q) tipText = d.shape === 'area' ? `Area ${q.value.toFixed(3)} m² · perimeter ${q.len.toFixed(3)} m` : `${d.shape === 'distance' ? 'Distance' : 'Length'} ${q.value.toFixed(3)} m`;
      if (pts.length >= 2) {
        const a = pts[pts.length - 2], b = pts[pts.length - 1], seg = Math.hypot(b[0] - a[0], b[1] - a[1]) * (this.scale || 0);
        const ang = (Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180 / Math.PI + 360) % 360;
        if (this.scale) tipText += ` · segment ${seg.toFixed(3)} m at ${ang.toFixed(1)}°`;
      }
      if (this.tool === 'calibrate') tipText = 'Click the second point of the known length';
    }
    if (cur) {
      const s = 5 / z;
      if (this.snapKind === 'end') out.push(`<rect x="${cur[0] - s}" y="${cur[1] - s}" width="${2 * s}" height="${2 * s}" fill="none" stroke="#f2a900" ${sw(2)}/>`);
      else if (this.snapKind === 'line') out.push(`<path d="M${cur[0] - s},${cur[1] - s}L${cur[0] + s},${cur[1] + s}M${cur[0] - s},${cur[1] + s}L${cur[0] + s},${cur[1] - s}" stroke="#f2a900" ${sw(2)}/>`);
      else out.push(`<path d="M${cur[0] - s},${cur[1]}L${cur[0] + s},${cur[1]}M${cur[0]},${cur[1] - s}L${cur[0]},${cur[1] + s}" stroke="${col}" ${sw(1)}/>`);
    }
    gEl.innerHTML = out.join('');
    const tip = this.el.tip;
    if (tipText && this.cursorScreen) {
      tip.textContent = tipText; tip.hidden = false; this.placeTip(this.cursorScreen[0], this.cursorScreen[1]);
    } else if (this.tool !== 'select') tip.hidden = true;
  }

  // ================================================================== picture
  async picture() {
    try {
      const W = Math.min(4000, Math.round(this.W * (this.kind === 'pdf' ? this.baseScale : Math.max(1, 2000 / this.W)))), k = W / this.W, H = Math.round(this.H * k);
      const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
      const drawSvg = (svgEl) => new Promise((res) => { const s = svgEl.cloneNode(true); s.setAttribute('width', W); s.setAttribute('height', H); s.setAttribute('xmlns', SVGNS);
        const img = new Image(); img.onload = () => { x.drawImage(img, 0, 0, W, H); res(); }; img.onerror = () => res();
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(s)); });
      if (this.mono) x.filter = 'grayscale(1)';
      if (this.kind === 'pdf') x.drawImage(this.baseCanvas, 0, 0, W, H);
      else if (this.kind === 'image') x.drawImage(this.el.base.querySelector('img'), 0, 0, W, H);
      else await drawSvg(this.el.base.querySelector('svg'));
      x.filter = 'none';
      await drawSvg(this.el.ov);
      const url = c.toDataURL('image/png');
      if (this.o.insertPicture) { await this.o.insertPicture(url); return; }
      const a = document.createElement('a'); a.href = url; a.download = (this.d.name || 'drawing').replace(/\.[^.]+$/, '') + '-takeoff.png'; document.body.append(a); a.click(); a.remove();
      this.say('Picture saved.', 'ok');
    } catch (err) { this.say('Could not make the picture: ' + err.message, 'bad'); }
  }
}
/** "Add dimension group" for on-screen measuring (Area, Length or Count). Makes it current. Resolves with the group or null. */
export async function newGroupDialog(store, say = () => {}) {
  if (!store.canEdit()) { say('You have view access to this project.', 'warn'); return null; }
  let v = null;
  const r = await dialog({ title: 'Add dimension group', body: `<label class="field">Name<input class="input" id="ngN" maxlength="200" autofocus placeholder="e.g. Floor tiles, Skirting, Doors"></label>
    <label class="field">Measurement type<select class="input" id="ngT">${['Area', 'Length', 'Count'].map(m => `<option>${m}</option>`).join('')}</select></label>
    <label class="field">Default height (m, optional: a length shown as wall area, an area as volume)<input class="input" id="ngH" type="number" step="any" min="0" value="0"></label>
    <label class="field">Colour<input id="ngC" type="color" value="${randomColor()}"></label>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add and measure', value: 'ok', primary: true }],
    validate: (d) => { v = { name: d.querySelector('#ngN').value.trim(), mtype: d.querySelector('#ngT').value, h: Number(d.querySelector('#ngH').value) || 0, c: d.querySelector('#ngC').value }; return v.name ? '' : 'Give the group a name.'; } });
  if (!r) return null;
  try {
    const props = { posColor: v.c, height: v.h, ...(v.h > 0 ? { display: v.mtype === 'Length' ? 'Area' : v.mtype === 'Area' ? 'Volume' : v.mtype } : {}) };
    const g = await store.createGroup({ name: v.name, mtype: v.mtype, props });
    say(`"${g.name}" added and made current.`, 'ok');
    return g;
  } catch (err) { say(err.message, 'bad'); return null; }
}
/** Every drawing of a project you can measure on (uploaded drawings and the 2D sheets of model versions), for Compare. */
export function measurableDrawings(detail) {
  if (!detail) return [];
  return [...(detail.drawings || []).filter(d => canMeasure(d.name)),
    ...(detail.models || []).flatMap(m => m.versions.flatMap(v => (v.stats?.sheets || []).map(sh => ({ kind: 'sheet', versionId: v.id, index: sh.index, name: `${sh.name} (${m.name} v${v.version})` }))))];
}
export const canMeasure = (name) => /\.(pdf|png|jpe?g|gif|webp|bmp|svg|dwg|dxf)$/i.test(name || '');
installExtras(DrawingTakeoff);
