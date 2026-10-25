// More CostX drawing tools for the drawing take-off (takeoff2d.js): working area, Convert to Cutout / Remove Cutout,
// rebar mode, comparing two drawings as an overlay, and Auto Count (image search for a captured symbol).
// installExtras(DrawingTakeoff) adds these methods to the class.
import { esc, api } from './core.js';
import { dialog } from './wui.js';
import * as G2 from './geom2d.js';
import { cutout } from './cutout.js';
import { makeDim } from './tkstore.js';
import { toInk } from './autocount.js';

let captured = null;          // Auto Count symbol, kept when you open another drawing: { img, ppu, thumb }
let pdfjs = null;
const loadPdf = async () => { if (!pdfjs) { pdfjs = await import('/vendor/pdfjs/pdf.min.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs'; } return pdfjs; };
const svgImage = (svgText, w, h, vb) => new Promise((resolve, reject) => {
  const holder = document.createElement('div'); holder.innerHTML = svgText;
  const el = holder.querySelector('svg'); if (!el) { reject(new Error('The drawing could not be read.')); return; }
  if (vb) el.setAttribute('viewBox', vb);
  el.setAttribute('width', w); el.setAttribute('height', h); el.setAttribute('preserveAspectRatio', 'none');
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(el)], { type: 'image/svg+xml' }));
  const img = new Image(); img.onload = () => { URL.revokeObjectURL(url); resolve(img); }; img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The drawing could not be drawn.')); };
  img.src = url;
});
/** Pixels per drawing unit for an image of the page: about 3000 px across, at most 12 million pixels. */
const ppuFor = (W, H, max = 3000) => Math.min(max / Math.max(W, H), Math.sqrt(1.2e7 / (W * H)), 6);
/** Ink colour layer for Compare: dark pixels become the colour, white becomes transparent. */
function tint(src, rgb) {
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const x = c.getContext('2d'); x.drawImage(src, 0, 0);
  const im = x.getImageData(0, 0, c.width, c.height), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const ink = 1 - (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = Math.round(Math.min(1, ink * 1.6) * 255 * (d[i + 3] / 255));
  }
  x.putImageData(im, 0, 0); return c;
}

/** A picture of any project drawing (for Compare): { canvas, W, H } with W, H its page size in drawing units. */
export async function loadRaster(d, page = 1, maxPx = 3000) {
  const isCad = d.kind !== 'sheet' && /\.(dwg|dxf)$/i.test(d.name || '');
  const res = await api('GET', d.kind === 'sheet' ? `/versions/${d.versionId}/sheets/${d.index}` : isCad ? `/drawings/${d.id}/cad` : `/drawings/${d.id}/file?inline=1`, null, { raw: true });
  const type = res.headers.get('content-type') || '', name = (d.name || '').toLowerCase();
  const c = document.createElement('canvas'), x = c.getContext('2d');
  if (/pdf/.test(type) || name.endsWith('.pdf')) {
    const lib = await loadPdf();
    const doc = await lib.getDocument({ data: new Uint8Array(await res.arrayBuffer()), standardFontDataUrl: '/vendor/pdfjs-fonts/', cMapUrl: '/vendor/pdfjs-cmaps/', cMapPacked: true }).promise;
    const pg = await doc.getPage(Math.min(page, doc.numPages)), v1 = pg.getViewport({ scale: 1 }), k = ppuFor(v1.width, v1.height, maxPx), vp = pg.getViewport({ scale: k });
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: x, viewport: vp }).promise;
    return { canvas: c, W: v1.width, H: v1.height };
  }
  if (/svg/.test(type) || d.kind === 'sheet' || isCad) {
    const text = await res.text();
    const vb = (text.match(/viewBox="([^"]+)"/) || [])[1]?.split(/[ ,]+/).map(Number) || [0, 0, 1000, 700];
    const k = ppuFor(vb[2], vb[3], maxPx); c.width = Math.ceil(vb[2] * k); c.height = Math.ceil(vb[3] * k);
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(await svgImage(text, c.width, c.height), 0, 0);
    return { canvas: c, W: vb[2], H: vb[3] };
  }
  const img = new Image(); img.src = URL.createObjectURL(await res.blob()); await img.decode();
  const k = ppuFor(img.naturalWidth, img.naturalHeight, maxPx); c.width = Math.ceil(img.naturalWidth * k); c.height = Math.ceil(img.naturalHeight * k);
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
  return { canvas: c, W: img.naturalWidth, H: img.naturalHeight };
}

export function installExtras(C) {
  Object.assign(C.prototype, {
    // ================================================================ a picture of this page (Auto Count, Compare)
    /** region: { x0, y0, x1, y1 } in drawing units (default the whole page). Visible layers only, like the screen. */
    async rasterize({ ppu = ppuFor(this.W, this.H), region = null } = {}) {
      const r = region || { x0: 0, y0: 0, x1: this.W, y1: this.H };
      const w = Math.max(1, Math.ceil((r.x1 - r.x0) * ppu)), h = Math.max(1, Math.ceil((r.y1 - r.y0) * ppu));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
      if (this.kind === 'pdf') {
        await this.pdfPage.render({ canvasContext: x, viewport: this.pdfPage.getViewport({ scale: ppu }), transform: [1, 0, 0, 1, -r.x0 * ppu, -r.y0 * ppu], ...this.layerOpt() }).promise;
      } else if (this.kind === 'image') {
        x.drawImage(this.el.base.querySelector('img'), r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, 0, 0, w, h);
      } else {
        x.drawImage(await svgImage(this.svgEl.outerHTML, w, h, `${r.x0} ${r.y0} ${r.x1 - r.x0} ${r.y1 - r.y0}`), 0, 0);
      }
      return { canvas: c, ppu, region: r };
    },

    // ================================================================ working area
    areaHere() { return this.store.areaOf(this.dkey, this.page) || this.localArea?.[this.page] || null; },
    async setWorkingArea(a, b) {
      const area = { x0: Math.max(0, Math.min(a[0], b[0])), y0: Math.max(0, Math.min(a[1], b[1])), x1: Math.min(this.W, Math.max(a[0], b[0])), y1: Math.min(this.H, Math.max(a[1], b[1])) };
      if (area.x1 - area.x0 < 1e-6 || area.y1 - area.y0 < 1e-6) return;
      if (this.store.canEdit()) { try { await this.store.setArea(this.dkey, this.page, area); } catch (err) { this.say(err.message, 'bad'); } }
      else (this.localArea ||= {})[this.page] = area;
      this.setTool('select'); this.applyArea(); this.fit(); this.drawDims();
      this.say('Working area set: only this part of the drawing is shown, snapped to and searched. View > Reset Working Area shows the whole page.', 'ok');
    },
    async resetWorkingArea() {
      if (this.store.areaOf(this.dkey, this.page) && this.store.canEdit()) await this.store.setArea(this.dkey, this.page, null).catch(err => this.say(err.message, 'bad'));
      if (this.localArea) delete this.localArea[this.page];
      this.applyArea(); this.fit(); this.drawDims();
    },
    applyArea() {
      const a = this.areaHere(), b = this.el?.base; if (!b) return;
      b.style.clipPath = a ? `inset(${a.y0}px ${this.W - a.x1}px ${this.H - a.y1}px ${a.x0}px)` : '';
    },
    inArea(p) { const a = this.areaHere(); return !a || (p[0] >= a.x0 && p[0] <= a.x1 && p[1] >= a.y0 && p[1] <= a.y1); },
    areaSvg(z) { const a = this.areaHere(); return a ? `<rect x="${a.x0}" y="${a.y0}" width="${a.x1 - a.x0}" height="${a.y1 - a.y0}" fill="none" stroke="#0f6cbd" stroke-width="${1.5 / z}" stroke-dasharray="${8 / z} ${4 / z}"/>` : ''; },

    // ================================================================ cutouts
    async convertToCutout() {
      const sel = this.selected().filter(x => x.m.shape === 'area');
      const negatives = sel.filter(x => x.m.sign < 0), targets = sel.filter(x => x.m.sign >= 0);
      if (!negatives.length) return this.say('Select a negative area dimension (the opening or void), and the positive areas to cut if they are stacked; then Convert to Cutout.', 'warn');
      const positives = this.dimsHere().filter(x => x.m.shape === 'area' && x.m.sign >= 0);
      const pc = (await import('./polyclip.js')).default;
      const { pieces, used } = cutout(pc, positives, negatives, targets);
      if (!used.size) return this.say('The negative dimension does not overlap a positive area of its group. Select the positive area too to cut a different group.', 'warn');
      const extras = new Map();
      await this.store.updateDims((m, g) => {
        if (used.has(m.id)) return null;                     // the negative dimension becomes the hole
        const ps = pieces.get(m.id); if (!ps) return undefined;
        const mk = (p, i) => { const holes = p.holes.filter(h => h.length >= 6); const q = G2.measure2d('area', p.pts, this.scaleFor(m), { holes });
          const d = { ...m, pts: p.pts, value: q?.value ?? m.value, len: q?.len ?? m.len }; if (holes.length) d.holes = holes; else delete d.holes;
          if (i) { d.id = Math.random().toString(36).slice(2, 10); d.label = `${m.label} (${i + 1})`; } return d; };
        if (ps.length > 1) extras.set(g.id, [...(extras.get(g.id) || []), ...ps.slice(1).map((p, i) => mk(p, i + 1))]);
        return ps.length ? mk(ps[0], 0) : null;
      }).catch(err => this.say(err.message, 'bad'));
      for (const [gid, list] of extras) await this.store.addMeasured(gid, list).catch(err => this.say(err.message, 'bad'));
      this.sel.clear(); this.drawDims(); this.emitSel();
      this.say(`Cutout applied to ${pieces.size} area dimension(s)${extras.size ? '; a dimension cut in two became two dimensions' : ''}. Right-click a hole > Remove Cutout to take it away.`, 'ok');
    },
    async removeCutout(x, i) {
      await this.store.updateDims((m) => {
        if (m.id !== x.m.id) return undefined;
        const holes = (m.holes || []).filter((_, k) => k !== i), q = G2.measure2d('area', m.pts, this.scaleFor(m), { holes });
        const d = { ...m, value: q?.value ?? m.value, len: q?.len ?? m.len }; if (holes.length) d.holes = holes; else delete d.holes; return d;
      }).catch(err => this.say(err.message, 'bad'));
      this.say('Cutout removed (the negative dimension is not restored).', 'ok'); this.drawDims();
    },

    // ================================================================ rebar mode
    rebarClick(p) {
      if (!this.draft) this.draft = { pts: [p], shape: 'rebar' };
      else this.draft.pts.push(p);
      const n = this.draft.pts.length;
      this.say(n === 1 ? 'Rebar: click the other end of the spacing line (the distance the bars cover).' : n === 2 ? 'Now click the start of one bar.' : n === 3 ? 'Click the end of the bar.' : '');
      if (n === 4) this.finishRebar(); else this.drawDraft();
    },
    async finishRebar() {
      const g = this.store.current(), pts = G2.flat(this.draft.pts); this.draft = null; this.drawDraft();
      const q0 = G2.rebarQty(pts, this.scale, {});
      let v = null;
      const r = await dialog({ title: 'Set spacing', body: `<p>Distance covered: <strong>${q0.dist.toFixed(3)} m</strong> · bar length: <strong>${q0.bar.toFixed(3)} m</strong></p>
        <div class="two"><label class="field">Spacing (m)<input class="input" id="rbS" type="number" step="any" min="0" value="${this.lastSpacing || 0.2}" autofocus></label>
        <label class="field">Extra length per bar (m)<input class="input" id="rbE" type="number" step="any" value="${this.lastExtra || 0}"></label></div>
        <p class="hint" id="rbN"></p>`,
        onOpen: (d) => { const upd = () => { const q = G2.rebarQty(pts, this.scale, { spacing: Number(d.querySelector('#rbS').value), extra: Number(d.querySelector('#rbE').value) }); d.querySelector('#rbN').textContent = `${q.bars} bars · total ${q.value.toFixed(3)} m`; }; d.oninput = upd; upd(); },
        validate: (d) => { v = { spacing: Number(d.querySelector('#rbS').value), extra: Number(d.querySelector('#rbE').value) || 0 }; return v.spacing > 0 ? '' : 'Enter the spacing in metres.'; } });
      if (!r) return this.say('Rebar cancelled.');
      this.lastSpacing = v.spacing; this.lastExtra = v.extra;
      const q = G2.rebarQty(pts, this.scale, v);
      const dim = makeDim(g, { shape: 'rebar', pts, value: q.value, src: this.src(), sign: this.sign, dmult: this.settings.multiplier || 1, rebar: { ...v, bars: q.bars } });
      try { await this.store.addMeasured(g.id, [dim]); this.say(`${dim.label}: ${q.bars} bars × ${(q.bar + v.extra).toFixed(3)} m = ${q.value.toFixed(3)} m into "${g.name}". Click the next spacing line, or Esc.`, 'ok'); }
      catch (err) { this.say(err.message, 'bad'); }
    },
    /** SVG of a rebar dimension: the spacing line dashed, the bar solid, and the bars it covers faintly. */
    rebarSvg(m, pts, col, z, sel) {
      if (pts.length < 8) return '';
      const [s0x, s0y, s1x, s1y, b0x, b0y, b1x, b1y] = pts, L = Math.hypot(s1x - s0x, s1y - s0y) || 1, ux = (s1x - s0x) / L, uy = (s1y - s0y) / L;
      const out = [`<line x1="${s0x}" y1="${s0y}" x2="${s1x}" y2="${s1y}" stroke="${col}" stroke-width="${2 / z}" stroke-dasharray="${6 / z} ${4 / z}"/>`,
        `<line x1="${b0x}" y1="${b0y}" x2="${b1x}" y2="${b1y}" stroke="${sel ? '#0078d4' : col}" stroke-width="${(sel ? 4 : 3) / z}" stroke-linecap="round"/>`];
      const sp = (m.rebar?.spacing || 0) / (this.scale || 1), n = Math.min(m.rebar?.bars || 0, 300);
      if (sp > 0 && n > 1) {
        const mx = (b0x + b1x) / 2, my = (b0y + b1y) / 2, t0 = (mx - s0x) * ux + (my - s0y) * uy;
        for (let k = 0; k < n; k++) { const o = k * sp - t0; out.push(`<line x1="${b0x + o * ux}" y1="${b0y + o * uy}" x2="${b1x + o * ux}" y2="${b1y + o * uy}" stroke="${col}" stroke-opacity=".3" stroke-width="${1 / z}"/>`); }
      }
      return out.join('');
    },

    // ================================================================ compare two drawings
    async compareWith() {
      const list = (this.o.drawings?.() || []).filter(d => !(d.kind === this.d.kind && (d.kind === 'sheet' ? d.versionId === this.d.versionId && d.index === this.d.index : d.id === this.d.id)));
      if (!list.length) return this.say('There is no other drawing in this project to compare with.', 'warn');
      let pick = null, page = 1;
      const r = await dialog({ title: 'Compare drawings', body: `<label class="field">Compare with<select class="input" id="cmD">${list.map((d, i) => `<option value="${i}">${esc(d.kind === 'sheet' ? 'Sheet: ' + d.name : d.name)}</option>`).join('')}</select></label>
        <label class="field">Page<input class="input" id="cmP" type="number" min="1" value="${this.page}"></label>
        <p class="hint">This drawing shows in green over the other one in red. Lines in both look dark; changes stand out in one colour. Turn on Align and drag to line them up.</p>`,
        validate: (d) => { pick = list[+d.querySelector('#cmD').value]; page = Math.max(1, Number(d.querySelector('#cmP').value) || 1); return ''; } });
      if (!r) return;
      this.say('Preparing the comparison…');
      try {
        const [mine, other] = await Promise.all([this.rasterize(), loadRaster(pick, page)]);
        this.closeCompare();
        const box = document.createElement('div'); box.className = 'tk-cmp';
        const a = tint(other.canvas, [214, 40, 40]), b = tint(mine.canvas, [16, 150, 40]);
        const k = this.W / other.W;                          // same sheet width
        Object.assign(a.style, { width: other.W * k + 'px', height: other.H * k + 'px' });
        Object.assign(b.style, { width: this.W + 'px', height: this.H + 'px' });
        a.className = 'tk-cmp-other'; b.className = 'tk-cmp-mine';
        box.append(a, b); this.el.page.insertBefore(box, this.el.ov);
        this.cmp = { box, a, b, dx: 0, dy: 0, k, align: false, name: pick.name };
        this.el.base.style.visibility = 'hidden';
        this.comparePanel();
        this.say(`Comparing with ${pick.name}. You can measure as usual: dimensions are saved on this drawing.`, 'ok');
      } catch (err) { this.say('Could not compare: ' + err.message, 'bad'); }
    },
    comparePanel() {
      const c = this.cmp; let p = this.host.querySelector('.tk-cmpbar');
      if (!p) { p = document.createElement('div'); p.className = 'tk-panel tk-cmpbar'; this.el.view.append(p); }
      p.innerHTML = `<div class="tk-ph">Compare <button class="close" aria-label="Close comparison">×</button></div>
        <div class="hint" title="${esc(c.name)}">Green: this drawing · red: ${esc(c.name)}</div>
        <label class="rng1">This <input type="range" min="0" max="100" value="${Math.round((c.b.style.opacity || 1) * 100)}" data-c="b"></label>
        <label class="rng1">Other <input type="range" min="0" max="100" value="${Math.round((c.a.style.opacity || 1) * 100)}" data-c="a"></label>
        <div class="row"><button data-c="align" aria-pressed="${c.align}">${c.align ? 'Aligning: drag' : 'Align'}</button><button data-c="reset">Reset</button></div>`;
      p.querySelector('.close').onclick = () => this.closeCompare();
      p.querySelectorAll('input[type=range]').forEach(r => r.oninput = () => { c[r.dataset.c].style.opacity = r.value / 100; });
      p.querySelector('[data-c=align]').onclick = () => { c.align = !c.align; this.comparePanel(); this.say(c.align ? 'Drag the drawing to line up the red one with the green one. Press Align again when done.' : ''); };
      p.querySelector('[data-c=reset]').onclick = () => { c.dx = c.dy = 0; this.moveCompare(); };
    },
    moveCompare() { if (this.cmp) this.cmp.a.style.transform = `translate(${this.cmp.dx}px, ${this.cmp.dy}px)`; },
    closeCompare() {
      if (!this.cmp) return;
      this.cmp.box.remove(); this.host.querySelector('.tk-cmpbar')?.remove(); this.cmp = null;
      if (this.el?.base) this.el.base.style.visibility = '';
    },

    // ================================================================ Auto Count
    acReady() {
      const g = this.store.current();
      if (!this.ready()) return false;
      if (g.mtype !== 'Count') { this.say('Auto Count goes into a Count group: choose one as the current group (or + Group).', 'warn'); return false; }
      return true;
    },
    acStart() {
      if (!this.acReady()) return;
      this.cancelDraft(); this.tool = 'autocount'; this.el.view.style.cursor = 'crosshair';
      this.ac ||= { matches: [], show: 0.7, accept: 0.9 };
      this.renderBar(); this.acPanel();
      this.say(captured ? 'Auto Count: press Search, or Capture a new symbol.' : 'Auto Count: press Capture, then drag a box around one symbol (a door, a light fitting…).');
    },
    acStop() { this.ac = null; this.host.querySelector('.tk-acbar')?.remove(); if (this.tool === 'autocount' || this.tool === 'capture') this.setTool('select'); this.drawDims(); },
    acPanel() {
      let p = this.host.querySelector('.tk-acbar');
      if (!p) { p = document.createElement('div'); p.className = 'tk-panel tk-acbar'; this.el.view.append(p); }
      const a = this.ac, shown = a.matches.filter(m => m.score >= a.show), st = (m) => m.state || (m.score >= a.accept ? 'acc' : 'unc');
      const acc = shown.filter(m => st(m) === 'acc').length, unc = shown.filter(m => st(m) === 'unc').length, rej = shown.filter(m => st(m) === 'rej').length;
      p.innerHTML = `<div class="tk-ph">Auto Count <button class="close" aria-label="Close Auto Count">×</button></div>
        <div class="tk-thumb">${captured ? `<img src="${captured.thumb}" alt="Captured symbol">` : '<span class="hint">No symbol yet</span>'}</div>
        <div class="row"><button data-a="cap">Capture</button><button data-a="search" ${captured ? '' : 'disabled'}>Search</button></div>
        <label class="rng1" title="How closely a symbol must match to show">Show matches above <b>${Math.round(a.show * 100)}%</b><input type="range" min="30" max="100" value="${Math.round(a.show * 100)}" data-r="show"></label>
        <label class="rng1" title="Matches at least this close are accepted automatically">Auto accept above <b>${Math.round(a.accept * 100)}%</b><input type="range" min="30" max="100" value="${Math.round(a.accept * 100)}" data-r="accept"></label>
        <div class="tk-acsum"><span class="acc">${acc} accepted</span> · <span class="unc">${unc} to check</span> · <span class="rej">${rej} rejected</span></div>
        <p class="hint">Click a yellow match once to accept, twice to reject; click green to reject, red to accept. Shift-click to add one it missed.</p>
        <div class="row"><button class="primary" data-a="save" ${acc ? '' : 'disabled'}>Save accepted (${acc})</button><button data-a="clear" ${a.matches.length ? '' : 'disabled'}>Clear</button></div>`;
      p.querySelector('.close').onclick = () => this.acStop();
      p.querySelector('[data-a=cap]').onclick = () => { this.tool = 'capture'; this.say('Drag a box tightly around one symbol.'); this.el.view.focus(); };
      p.querySelector('[data-a=search]').onclick = () => this.acSearch();
      p.querySelector('[data-a=save]').onclick = () => this.acSave();
      p.querySelector('[data-a=clear]').onclick = () => { a.matches = []; this.acPanel(); this.drawDims(); };
      p.querySelectorAll('[data-r]').forEach(r => r.oninput = () => { a[r.dataset.r] = r.value / 100; r.previousElementSibling.textContent = r.value + '%'; this.drawDims(); clearTimeout(this.acT); this.acT = setTimeout(() => this.acPanel(), 250); });
    },
    async acCapture(a, b) {
      const region = { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
      const ppu = ppuFor(this.W, this.H), w = (region.x1 - region.x0) * ppu, h = (region.y1 - region.y0) * ppu;
      this.tool = 'autocount';
      if (w < 6 || h < 6) return this.say('That box is too small: zoom in and drag around the whole symbol.', 'warn');
      if (w > 400 || h > 400) return this.say('That box is too big: capture one symbol only.', 'warn');
      const r = await this.rasterize({ ppu, region });
      const x = r.canvas.getContext('2d'), im = x.getImageData(0, 0, r.canvas.width, r.canvas.height);
      captured = { img: toInk(im.data, r.canvas.width, r.canvas.height), ppu, thumb: r.canvas.toDataURL('image/png') };
      this.ac.matches = []; this.acPanel(); this.drawDims();
      this.say('Symbol captured. Press Search to find every copy on this drawing (in the working area, on visible layers).', 'ok');
    },
    async acSearch() {
      if (!captured) return;
      const ppu = ppuFor(this.W, this.H), area = this.areaHere();
      let tpl = captured.img;
      if (Math.abs(captured.ppu - ppu) / ppu > 0.02) tpl = resample(tpl, ppu / captured.ppu);       // captured on a drawing of another size
      this.say('Searching the drawing… (rotated and mirrored copies too)');
      const p = this.host.querySelector('.tk-acbar [data-a=search]'); if (p) { p.disabled = true; p.textContent = 'Searching…'; }
      try {
        const r = await this.rasterize({ ppu, region: area });
        const x = r.canvas.getContext('2d'), im = x.getImageData(0, 0, r.canvas.width, r.canvas.height);
        const img = toInk(im.data, r.canvas.width, r.canvas.height);
        const t0 = Date.now();
        const res = await new Promise((resolve, reject) => {
          const w = new Worker(new URL('./acworker.js', import.meta.url), { type: 'module' });
          w.onmessage = (e) => { w.terminate(); e.data.ok ? resolve(e.data.matches) : reject(new Error(e.data.error)); };
          w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The search failed.')); };
          w.postMessage({ img, tpl, opts: { min: 0.3 } }, [img.d.buffer]);
        });
        const off = r.region;
        this.ac.matches = res.map(m => ({ x: off.x0 + m.x / ppu, y: off.y0 + m.y / ppu, w: m.w / ppu, h: m.h / ppu, score: m.score, rot: m.rot, mirror: m.mirror }));
        this.acPanel(); this.drawDims();
        this.say(`${res.filter(m => m.score >= this.ac.show).length} match(es) found in ${((Date.now() - t0) / 1000).toFixed(1)} s. Check the yellow ones, then Save accepted.`, 'ok');
      } catch (err) { this.say('Auto Count: ' + err.message, 'bad'); this.acPanel(); }
    },
    acState(m) { return m.state || (m.score >= this.ac.accept ? 'acc' : 'unc'); },
    acClick(p, e) {
      const a = this.ac; if (!a) return;
      if (e.shiftKey && captured) {                    // add a match it missed
        const w = captured.img.w / captured.ppu, h = captured.img.h / captured.ppu;
        a.matches.push({ x: p[0] - w / 2, y: p[1] - h / 2, w, h, score: 1, state: 'acc', manual: true });
      } else {
        const m = a.matches.filter(x => x.score >= a.show).find(x => p[0] >= x.x && p[0] <= x.x + x.w && p[1] >= x.y && p[1] <= x.y + x.h);
        if (!m) return;
        const s = this.acState(m);
        m.state = s === 'acc' ? 'rej' : 'acc';        // yellow → green → red → green (CostX)
      }
      this.acPanel(); this.drawDims();
    },
    async acSave() {
      const a = this.ac, g = this.store.current(); if (!a || !g) return;
      const list = a.matches.filter(m => m.score >= a.show && this.acState(m) === 'acc');
      if (!list.length) return;
      const base = (g.props.measured || []).length;
      const dims = list.map((m, i) => { const d = makeDim(g, { shape: 'count', pts: [m.x + m.w / 2, m.y + m.h / 2], value: 1, src: this.src(), sign: this.sign, dmult: this.settings.multiplier || 1 }); d.label = `Count ${String(base + i + 1).padStart(4, '0')}`; d.kind = 'autocount'; return d; });
      try { await this.store.addMeasured(g.id, dims); a.matches = a.matches.filter(m => !list.includes(m)); this.say(`${dims.length} count(s) added to "${g.name}".`, 'ok'); }
      catch (err) { this.say(err.message, 'bad'); }
      this.acPanel(); this.drawDims();
    },
    acSvg(z) {
      const a = this.ac; if (!a?.matches.length) return '';
      const col = { acc: '#16a34a', unc: '#e0b000', rej: '#d13438' };
      return a.matches.filter(m => m.score >= a.show).map(m => { const s = this.acState(m);
        return `<rect x="${m.x}" y="${m.y}" width="${m.w}" height="${m.h}" fill="${col[s]}" fill-opacity=".18" stroke="${col[s]}" stroke-width="${2 / z}"/><text x="${m.x + m.w}" y="${m.y - 2 / z}" font-size="${10 / z}" text-anchor="end" fill="${col[s]}">${Math.round(m.score * 100)}%</text>`; }).join('');
    },
  });
}

/** Nearest-neighbour resize of a grey image by factor k. */
function resample(img, k) {
  const w = Math.max(2, Math.round(img.w * k)), h = Math.max(2, Math.round(img.h * k)), d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = img.d[Math.min(img.h - 1, Math.floor(y / k)) * img.w + Math.min(img.w - 1, Math.floor(x / k))];
  return { w, h, d };
}
