// 3D view toolbar and its pop-up panels. Shared by the task pane and the large 3D window.
// host: the page that owns the selection (see the interface in model.js / window.js).
import { esc } from './core.js';

const ICON = {
  fit: '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /><rect x="5.5" y="5.5" width="5" height="5" rx=".5"/>',
  views: '<path d="M8 1.5 14 4.8v6.4L8 14.5 2 11.2V4.8z"/><path d="M2 4.8 8 8l6-3.2M8 8v6.5"/>',
  isolate: '<rect x="1.5" y="1.5" width="4" height="4" opacity=".4"/><rect x="10.5" y="1.5" width="4" height="4" opacity=".4"/><rect x="1.5" y="10.5" width="4" height="4" opacity=".4"/><rect x="10.5" y="10.5" width="4" height="4" opacity=".4"/><path d="M8 4.5 11 6.2v3.6L8 11.5 5 9.8V6.2z"/>',
  hide: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><path d="M2.5 13.5 13.5 2.5"/>',
  show: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  section: '<path d="M3 5.5 8 3l5 2.5v5L8 13l-5-2.5z"/><path d="M1 8.5h14" stroke-dasharray="2 1.5"/>',
  plan: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 7h6v7M8 7V2M11 7h3"/>',
  box: '<rect x="2.5" y="3.5" width="11" height="9" stroke-dasharray="2 1.5"/><path d="M10 9l4 4.5-1.8.3-.8 1.7z" fill="currentColor"/>',
  measure: '<path d="M1.5 11.5 11.5 1.5l3 3-10 10z"/><path d="M4 9l1.5 1.5M6 7l1 1M8 5l1.5 1.5M10 3l1 1"/>',
  color: '<circle cx="5.5" cy="6" r="3"/><circle cx="10.5" cy="6" r="3"/><circle cx="8" cy="10.5" r="3"/>',
  xray: '<rect x="2" y="2" width="9" height="9" opacity=".45"/><rect x="5" y="5" width="9" height="9"/>',
  edges: '<path d="M8 1.5 14 4.8v6.4L8 14.5 2 11.2V4.8z"/>',
  saved: '<path d="M3.5 1.5h9v13L8 11.5l-4.5 3z"/>',
  shot: '<rect x="1.5" y="4" width="13" height="9.5" rx="1"/><path d="M5.5 4l1.2-2h2.6L10.5 4"/><circle cx="8" cy="8.7" r="2.6"/>',
  window: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 5.5h13M9 8.5h3.5v3"/><path d="M12.5 8.5 8 13"/>',
};
const svg = (k) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

export class Toolbar {
  constructor(bar, stage, viewer, host) {
    this.bar = bar; this.stage = stage; this.v = viewer; this.host = host;
    this.pop = null; this.render();
    viewer.cb.onChange = () => this.sync();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.pop) this.closePop();
    });
  }
  btn(id, icon, label, title, pressable = false) {
    return `<button class="vbtn" data-t="${id}" title="${esc(title)}" aria-label="${esc(label)}" ${pressable ? 'aria-pressed="false"' : ''}>${svg(icon)}<span class="lbl">${esc(label)}</span></button>`;
  }
  render() {
    const h = this.host;
    this.bar.innerHTML = [
      this.btn('fit', 'fit', 'Fit', 'Zoom to the visible elements (F)'),
      this.btn('views', 'views', 'Views', 'Standard views, view cube, perspective or orthographic'),
      '<span class="sep"></span>',
      this.btn('isolate', 'isolate', 'Isolate', 'Show only the selected elements', true),
      this.btn('hide', 'hide', 'Hide', 'Hide the selected elements'),
      this.btn('showall', 'show', 'Show all', 'Show every element and clear isolate, hide and level filter'),
      '<span class="sep"></span>',
      this.btn('section', 'section', 'Section', 'Section box: cut the model to see inside', true),
      this.btn('plan', 'plan', 'Plan', 'Level plan: top view of one level, cut at a set height', true),
      this.btn('box', 'box', 'Box select', 'Window selection: drag left-to-right for elements fully inside, right-to-left for anything touched', true),
      this.btn('measure', 'measure', 'Measure', 'Measure a distance or the area of a face', true),
      '<span class="sep"></span>',
      this.btn('color', 'color', 'Colour', 'Colour by category, level, material, zone, property, measured status or revision changes', true),
      this.btn('xray', 'xray', 'X-ray', 'See the selected elements through the others', true),
      this.btn('edges', 'edges', 'Edges', 'Show element outlines', true),
      '<span class="sep"></span>',
      this.btn('saved', 'saved', 'Saved views', 'Save the camera, section, selection and colours, or open a saved view'),
      this.btn('shot', 'shot', 'Picture', 'Picture of the 3D view'),
      h.openWindow ? this.btn('window', 'window', '3D window', 'Open the model in a large window (can go on a second screen)') : '',
    ].join('');
    this.bar.querySelectorAll('[data-t]').forEach(b => b.onclick = () => this.act(b.dataset.t, b));
    this.sync();
  }
  sync() {
    const p = (k, on) => this.bar.querySelector(`[data-t=${k}]`)?.setAttribute('aria-pressed', String(Boolean(on)));
    p('isolate', this.host.isIsolated()); p('section', this.v.sectionOn); p('plan', this.inPlan); p('box', this.v.mode === 'box');
    p('measure', this.v.mode === 'measure' || this.v.mode === 'area'); p('color', this.host.colorMode() !== 'category'); p('xray', this.v.state.xray);
    p('edges', this.v.edgesWanted);
    const hasSel = this.host.selectedIds().length > 0;
    const hb = this.bar.querySelector('[data-t=hide]'); if (hb) hb.disabled = !hasSel;
    const ib = this.bar.querySelector('[data-t=isolate]'); if (ib) ib.disabled = !hasSel && !this.host.isIsolated();
  }
  act(t, b) {
    const v = this.v, h = this.host;
    switch (t) {
      case 'fit': v.fit(); break;
      case 'isolate': h.toggleIsolate(); break;
      case 'hide': h.hideSelected(); break;
      case 'showall': if (this.inPlan) this.exitPlan(); v.setSection(false); h.showAll(); break;
      case 'box': v.setMode(v.mode === 'box' ? 'orbit' : 'box'); h.status(v.mode === 'box' ? 'Box select: drag over the model. Left to right selects elements fully inside; right to left selects anything touched. Hold Ctrl to add.' : ''); break;
      case 'xray': v.setXray(!v.state.xray); break;
      case 'edges': v.setEdges(!v.edgesWanted); break;
      case 'shot': this.picture(); break;
      case 'window': if (h.openAppWindow) this.openPop('window', b); else h.openWindow(); break;
      default: this.openPop(t, b);
    }
    this.sync();
  }
  closePop() { this.pop?.remove(); this.pop = null; }
  openPop(kind, b) {
    if (this.pop?.dataset.kind === kind) return this.closePop();
    this.closePop();
    const p = document.createElement('div'); p.className = 'vpop'; p.dataset.kind = kind;
    p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', b.getAttribute('aria-label'));
    this.stage.append(p); this.pop = p;
    this['pop_' + kind](p);
    p.querySelector('button, input, select')?.focus();
  }
  head(title) { return `<h4>${esc(title)}<button class="close" aria-label="Close">×</button></h4>`; }
  wireClose(p) { p.querySelector('.close').onclick = () => this.closePop(); }

  pop_window(p) {
    p.innerHTML = this.head('Large window') + `<div class="vpop-list">
      <button data-w="normal"><strong>3D window</strong><br><span class="hint">Inside Excel. Maximise and Restore buttons on its top bar.</span></button>
      <button data-w="app"><strong>App window</strong><br><span class="hint">A separate browser window you can minimise, maximise and move to another screen. Stays linked with Excel.</span></button></div>`;
    this.wireClose(p);
    p.querySelectorAll('[data-w]').forEach(x => x.onclick = () => { this.closePop(); x.dataset.w === 'app' ? this.host.openAppWindow() : this.host.openWindow(); });
  }
  pop_views(p) {
    const views = [['top', 'Top'], ['front', 'Front'], ['right', 'Right'], ['back', 'Back'], ['left', 'Left'], ['bottom', 'Bottom'], ['iso', 'Isometric']];
    p.innerHTML = this.head('Views') + `<div class="list">${views.map(([k, l], i) => `<button class="item" data-v="${k}">${l}<span class="muted">${i + 1}</span></button>`).join('')}</div>
      <label class="row"><input type="checkbox" id="vOrtho" ${this.v.isOrtho ? 'checked' : ''}> Orthographic (no perspective)</label>
      <p class="hint">Click a face of the view cube for the same views. Keys: 1-7 views, F fit, arrows orbit, + and - zoom.</p>`;
    this.wireClose(p);
    p.querySelectorAll('[data-v]').forEach(x => x.onclick = () => this.v.setView(x.dataset.v));
    p.querySelector('#vOrtho').onchange = (e) => this.v.setOrtho(e.target.checked);
  }
  pop_section(p) {
    const v = this.v;
    const axes = this.axisNames();
    const draw = () => {
      p.innerHTML = this.head('Section box') + `<label class="row"><input type="checkbox" id="secOn" ${v.sectionOn ? 'checked' : ''}> Section box on</label>
        ${axes.map(([a, label]) => `<div class="rng"><span>${label}</span>
          <input type="range" min="0" max="1000" value="${Math.round(v.sectionFraction(a, 'min') * 1000)}" data-a="${a}" data-s="min" aria-label="${label} from">
          <input type="range" min="0" max="1000" value="${Math.round(v.sectionFraction(a, 'max') * 1000)}" data-a="${a}" data-s="max" aria-label="${label} to"></div>`).join('')}
        <div class="row"><button id="secSel" ${this.host.selectedIds().length ? '' : 'disabled'}>Fit to selection</button><button id="secReset">Reset</button></div>
        <p class="hint">Drag the sliders to cut the model from each side. The blue box shows the cut.</p>`;
      this.wireClose(p);
      p.querySelector('#secOn').onchange = (e) => { v.setSection(e.target.checked); this.sync(); };
      p.querySelectorAll('input[type=range]').forEach(r => r.oninput = () => { v.setSectionFraction(r.dataset.a, r.dataset.s, r.value / 1000); p.querySelector('#secOn').checked = true; this.sync(); });
      p.querySelector('#secSel').onclick = () => { v.sectionToSelection(this.host.selectedIds()); draw(); this.sync(); };
      p.querySelector('#secReset').onclick = () => { v.setSection(true, v.bounds.clone()); draw(); this.sync(); };
    };
    draw();
  }
  axisNames() {
    const up = 'xyz'[this.v.up];
    const north = this.v.up === 1 ? 'z' : 'y';
    return [['x', 'East–West'], [north, 'North–South'], [up, 'Height']];
  }
  pop_plan(p) {
    const levels = this.host.levels();
    p.innerHTML = this.head('Level plan') + (levels.length ? `
      <label class="field">Cut height above the level (m)<input class="input" type="number" id="cutH" step="0.1" min="0.1" value="${this.cut || 1.2}"></label>
      <div class="list">${levels.map((l, i) => `<button class="item" data-i="${i}">${esc(l.name)}<span class="muted">${l.z.toFixed(2)} m</span></button>`).join('')}</div>
      ${this.inPlan ? '<div class="row"><button id="planExit">Back to 3D</button></div>' : ''}`
      : '<p class="hint">No levels with 3D elements were found in this model.</p>');
    this.wireClose(p);
    p.querySelectorAll('[data-i]').forEach(x => x.onclick = () => {
      const l = levels[+x.dataset.i]; this.cut = Number(p.querySelector('#cutH').value) || 1.2;
      this.v.levelPlan(l.z, this.cut); this.inPlan = l.name; this.host.status(`Plan of ${l.name}, cut at ${this.cut} m. Press Plan > Back to 3D to return.`);
      this.closePop(); this.sync();
    });
    p.querySelector('#planExit') && (p.querySelector('#planExit').onclick = () => { this.exitPlan(); this.closePop(); });
  }
  exitPlan() { this.inPlan = null; this.v.setSection(false); this.v.setOrtho(false); this.v.setView('iso'); this.sync(); }
  pop_measure(p) {
    const v = this.v;
    p.innerHTML = this.head('Measure') + `<div class="list">
      <button class="item" data-m="measure">Distance between two points <span class="muted">${v.mode === 'measure' ? 'on' : ''}</span></button>
      <button class="item" data-m="area">Area of a face <span class="muted">${v.mode === 'area' ? 'on' : ''}</span></button>
      <button class="item" data-m="orbit">Stop measuring</button></div>
      <p class="hint">Points snap to element corners near the cursor. Press Esc to stop.</p>`;
    this.wireClose(p);
    p.querySelectorAll('[data-m]').forEach(x => x.onclick = () => {
      v.setMode(x.dataset.m); this.closePop(); this.sync();
      this.host.status(x.dataset.m === 'measure' ? 'Click the first point, then the second point.' : x.dataset.m === 'area' ? 'Click a flat face of an element.' : '');
    });
  }
  pop_color(p) {
    const draw = () => {
      const modes = this.host.colorModes(), cur = this.host.colorMode();
      const legend = this.host.legend();
      p.innerHTML = this.head('Colour by') + `<select class="input" id="cMode" aria-label="Colour by">${modes.map(m => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
        <div class="legend">${legend.map((l, i) => `<button data-i="${i}" title="Select these elements"><span class="sw" style="background:${l.color}"></span>${esc(l.label)}<span class="n">${l.count}</span></button>`).join('')}</div>
        <p class="hint">Click a legend row to select those elements.</p>`;
      this.wireClose(p);
      p.querySelector('#cMode').onchange = async (e) => { await this.host.setColorMode(e.target.value); draw(); this.sync(); };
      p.querySelectorAll('.legend [data-i]').forEach(x => x.onclick = () => this.host.selectIds(legend[+x.dataset.i].ids));
    };
    draw();
  }
  async pop_saved(p) {
    p.innerHTML = this.head('Saved views') + '<div class="loading">Loading…</div>';
    this.wireClose(p);
    let list = [];
    try { list = await this.host.views(); } catch (err) { p.querySelector('.loading').textContent = err.message; return; }
    p.innerHTML = this.head('Saved views') + (this.host.canSaveViews() ? `<form class="inline-form" id="svForm"><input class="input" id="svName" placeholder="View name" maxlength="120" required aria-label="View name"><button class="btn small">Save</button></form>` : '<p class="hint">Open a model from a project to save views.</p>') +
      (list.length ? `<div class="list">${list.map((x, i) => `<div style="display:flex;gap:4px;align-items:center"><button class="item" data-i="${i}">${esc(x.name)}<span class="muted">${esc(x.created_by || '')}</span></button>${this.host.canSaveViews() ? `<button class="close" data-del="${i}" aria-label="Delete ${esc(x.name)}" title="Delete">×</button>` : ''}</div>`).join('')}</div>` : '<p class="hint">No saved views yet. A saved view keeps the camera, section box, plan, selection, isolate, hidden elements and colours, and the whole team can open it.</p>');
    this.wireClose(p);
    p.querySelector('#svForm') && (p.querySelector('#svForm').onsubmit = async (e) => {
      e.preventDefault(); await this.host.saveView(p.querySelector('#svName').value); this.closePop();
    });
    p.querySelectorAll('[data-i]').forEach(x => x.onclick = () => { this.host.applyView(list[+x.dataset.i]); this.closePop(); this.sync(); });
    p.querySelectorAll('[data-del]').forEach(x => x.onclick = async () => { await this.host.deleteView(list[+x.dataset.del]); this.closePop(); });
  }
  async picture() {
    const url = this.v.screenshot(1600);
    if (this.host.insertPicture) {
      try { await this.host.insertPicture(url); return; } catch { /* fall back to download */ }
    }
    const a = document.createElement('a'); a.href = url; a.download = 'model-view.png'; document.body.append(a); a.click(); a.remove();
    this.host.status('Picture saved.', 'ok');
  }
}
