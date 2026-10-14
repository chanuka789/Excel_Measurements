// DWFx Measure 3D viewer.
// One merged geometry for the whole model (a few draw calls), element ranges for colour, hide and
// isolate, a BVH for instant picking, and the QS tools: view cube, standard views, orthographic,
// section box, level plan, window selection, distance / face-area measure, colour by property, x-ray,
// saved views and screenshots. Used by the task pane and by the large 3D window.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const PICK = new THREE.Color('#f2a900');
const css = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;

/** Parse the DWG2 binary written by py/pack.py. */
export function parseBin(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x32475744) throw new Error('Not a DWFx Measure geometry file.');   // 'DWG2'
  const hl = dv.getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl)));
  let o = 8 + hl;
  const pos = new Float32Array(buf, o, h.nVerts * 3); o += h.nVerts * 12;
  const tri = new Uint32Array(buf, o, h.nTris * 3); o += h.nTris * 12;
  const edges = new Uint32Array(buf, o, h.nEdges * 2);
  return { header: h, pos, tri, edges, elements: h.elements };
}

/** Convert the older per-mesh JSON geometry into the same arrays (no feature edges). */
export function fromLegacy(geo) {
  const b64 = (s, T) => new T(Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer);
  const by = new Map();
  for (const m of geo.meshes || []) { const id = m.id ?? -1; if (!by.has(id)) by.set(id, []); by.get(id).push(m); }
  const parts = [], elements = []; let nv = 0, nt = 0;
  for (const id of [...by.keys()].sort((a, b) => a - b)) {
    const v0 = nv, t0 = nt;
    for (const m of by.get(id)) {
      const p = b64(m.p, Float32Array), i = b64(m.i, Uint32Array);
      parts.push([p, i, nv]); nv += p.length / 3; nt += i.length / 3;
    }
    elements.push([id, v0, nv - v0, t0, nt - t0, 0, 0]);
  }
  const pos = new Float32Array(nv * 3), tri = new Uint32Array(nt * 3);
  let po = 0, to = 0;
  for (const [p, i, off] of parts) { pos.set(p, po); po += p.length; for (let k = 0; k < i.length; k++) tri[to + k] = i[k] + off; to += i.length; }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < pos.length; k += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], pos[k + c]); hi[c] = Math.max(hi[c], pos[k + c]); }
  return { header: { version: 1, origin: [0, 0, 0], up: 'y', bounds: [lo, hi] }, pos, tri, edges: new Uint32Array(0), elements };
}

export class Viewer {
  /**
   * @param {HTMLElement} host  container (position: relative)
   * @param {object} cb  callbacks: onPick(id|null, additive), onContext(id, x, y), onBoxSelect(ids, additive),
   *                     onHover(id|null), onMeasure(text|null), onChange()
   */
  constructor(host, cb = {}) {
    this.host = host; this.cb = cb;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, logarithmicDepthBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.autoClear = false;
    host.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.persp = new THREE.PerspectiveCamera(40, 1, 0.05, 5000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
    this.camera = this.persp;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 1.25));
    this.sun = new THREE.DirectionalLight(0xffffff, 1.3); this.scene.add(this.sun);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.controls = this.makeControls();
    this.clip = []; this.sectionOn = false;
    this.mode = 'orbit';                // orbit | box | measure | area
    this.dirty = true; this.edgesWanted = true; this.xray = false;
    this.state = { selected: new Set(), isVisible: () => true, colorOf: () => '#8a9aa6' };
    this.lastColor = null; this.hoverK = -1;
    this.makeOverlay();
    this.makeCube();
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = () => {
      const moving = this.controls.update();
      if ((this.dirty || moving) && host.offsetParent !== null) this.render();
      requestAnimationFrame(loop);
    };
    loop();
  }

  // ------------------------------------------------------------------ setup
  makeControls() {
    const c = new OrbitControls(this.camera, this.renderer.domElement);
    c.enableDamping = true; c.dampingFactor = 0.12; c.screenSpacePanning = true;
    c.addEventListener('change', () => { this.dirty = true; this.updateEdgeVisibility(); });
    return c;
  }
  invalidate() { this.dirty = true; }
  resize() {
    const w = Math.max(this.host.clientWidth, 1), h = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h; this.persp.updateProjectionMatrix();
    this.updateOrthoFrustum();
    this.dirty = true;
  }
  setTheme() {
    this.scene.background = new THREE.Color(css('--viewer', '#e8eaec'));
    const dark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    if (this.edgeMat) this.edgeMat.color.set(dark ? '#c8ced3' : '#2f363c');
    this.dirty = true;
  }

  // ------------------------------------------------------------------ loading
  /** g: result of parseBin / fromLegacy */
  load(g) {
    this.clear();
    const h = g.header;
    this.origin = h.origin || [0, 0, 0];
    this.up = { x: 0, y: 1, z: 2 }[h.up || 'y'];
    const upV = new THREE.Vector3(); upV.setComponent(this.up, 1);
    this.upV = upV;
    this.eastV = new THREE.Vector3(1, 0, 0);
    this.northV = this.up === 1 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    for (const cam of [this.persp, this.ortho]) cam.up.copy(upV);
    this.controls.dispose(); this.controls = this.makeControls();
    this.sun.position.copy(upV.clone().multiplyScalar(2).add(this.eastV).add(this.northV.clone().multiplyScalar(-1.5)));

    this.pos = g.pos; this.tri = g.tri; this.edgeIdx = g.edges;
    const n = g.elements.length;
    this.E = { id: new Float64Array(n), vs: new Uint32Array(n), vc: new Uint32Array(n), ts: new Uint32Array(n), tc: new Uint32Array(n), es: new Uint32Array(n), ec: new Uint32Array(n) };
    this.kOf = new Map();
    g.elements.forEach((r, k) => {
      this.E.id[k] = r[0]; this.E.vs[k] = r[1]; this.E.vc[k] = r[2]; this.E.ts[k] = r[3]; this.E.tc[k] = r[4]; this.E.es[k] = r[5] || 0; this.E.ec[k] = r[6] || 0;
      if (r[0] !== -1) this.kOf.set(r[0], k);
    });
    this.n = n;
    this.colors = new Uint8Array(this.pos.length);
    this.lastColor = new Int32Array(n).fill(-1);

    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 3, true);
    const mk = () => { const geo = new THREE.BufferGeometry(); geo.setAttribute('position', this.posAttr); geo.setAttribute('color', this.colAttr); return geo; };
    this.geoSolid = mk(); this.geoGhost = mk(); this.geoEdge = new THREE.BufferGeometry(); this.geoEdge.setAttribute('position', this.posAttr);
    this.solidMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.ghostMat = new THREE.MeshLambertMaterial({ color: '#b9bfc4', transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, flatShading: true });
    this.edgeMat = new THREE.LineBasicMaterial({ color: '#2f363c', transparent: true, opacity: 0.38 });
    this.solid = new THREE.Mesh(this.geoSolid, this.solidMat);
    this.ghost = new THREE.Mesh(this.geoGhost, this.ghostMat); this.ghost.renderOrder = 2; this.ghost.visible = !this.imagesHidden;
    this.edges = new THREE.LineSegments(this.geoEdge, this.edgeMat); this.edges.renderOrder = 1;
    for (const o of [this.solid, this.ghost, this.edges]) { o.frustumCulled = false; this.root.add(o); }
    // picking geometry: every triangle, with a BVH built on first use
    // The BVH re-orders its index array in place, so it gets its own copy: this.tri (and the element
    // triangle ranges that point into it) must never change, or colours and selection hit the wrong elements.
    this.pickTri = this.tri.slice();
    this.geoPick = new THREE.BufferGeometry(); this.geoPick.setAttribute('position', this.posAttr);
    this.geoPick.setIndex(new THREE.BufferAttribute(this.pickTri, 1));
    this.pickMesh = new THREE.Mesh(this.geoPick, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    this.bvhReady = false;
    if (window.requestIdleCallback) window.requestIdleCallback(() => this.ensureBVH(), { timeout: 1500 }); else setTimeout(() => this.ensureBVH(), 50);

    const [lo, hi] = h.bounds;
    this.bounds = new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi));
    this.section = this.bounds.clone();
    this.setTheme();
    this.totalTris = this.tri.length / 3;
    this.paint(this.state);
    this.setView('iso', false);
  }
  clear() {
    this.root.clear(); this.n = 0; this.kOf = new Map(); this.measureClear();
    for (const gg of [this.geoSolid, this.geoGhost, this.geoEdge, this.geoPick]) gg?.dispose();
    this.dirty = true;
  }
  ensureBVH() {
    if (this.bvhReady || !this.geoPick) return;
    this.geoPick.computeBoundsTree({ maxLeafTris: 10 });
    this.bvhReady = true;
  }
  get loaded() { return this.n > 0; }
  hasGeometry(id) { return this.kOf.has(id); }

  // ------------------------------------------------------------------ painting
  /**
   * state: { selected:Set<id>, isVisible(id)->bool, colorOf(id)->css colour, xray:bool }
   * Rebuilds the index buffers (a few ms even for a million triangles) and recolours changed elements.
   */
  paint(state = this.state) {
    this.state = state;
    if (!this.n) return;
    const { selected, isVisible, colorOf } = state;
    const anySel = selected.size > 0, xray = Boolean(state.xray);
    const solidK = [], ghostK = [];
    let changed = false;
    const tmp = new THREE.Color();
    for (let k = 0; k < this.n; k++) {
      const id = this.E.id[k];
      if (id === -1 || !isVisible(id)) continue;
      const sel = selected.has(id);
      if (sel || (!anySel && !xray) || state.solid?.(id)) solidK.push(k); else ghostK.push(k);   // solid(): e.g. the current dimension group
      tmp.set(sel ? PICK : colorOf(id) || '#8a9aa6');
      if (k === this.hoverK && !sel) tmp.lerp(new THREE.Color('#ffffff'), 0.35);
      const packed = (Math.round(tmp.r * 255) << 16) | (Math.round(tmp.g * 255) << 8) | Math.round(tmp.b * 255);
      if (this.lastColor[k] !== packed) {
        this.lastColor[k] = packed; changed = true;
        const r = packed >> 16 & 255, g = packed >> 8 & 255, b = packed & 255;
        for (let v = this.E.vs[k] * 3, end = (this.E.vs[k] + this.E.vc[k]) * 3; v < end; v += 3) { this.colors[v] = r; this.colors[v + 1] = g; this.colors[v + 2] = b; }
      }
    }
    if (changed) this.colAttr.needsUpdate = true;
    this.geoSolid.setIndex(new THREE.BufferAttribute(this.gather(solidK, this.tri, this.E.ts, this.E.tc, 3), 1));
    this.geoGhost.setIndex(new THREE.BufferAttribute(this.gather(ghostK, this.tri, this.E.ts, this.E.tc, 3), 1));
    this.geoEdge.setIndex(new THREE.BufferAttribute(this.gather(solidK, this.edgeIdx, this.E.es, this.E.ec, 2), 1));
    this.ghostMat.vertexColors = xray; this.ghostMat.color.set(xray ? '#ffffff' : '#b9bfc4'); this.ghostMat.opacity = xray ? 0.22 : 0.12; this.ghostMat.needsUpdate = true;
    this.visibleTris = solidK.reduce((s, k) => s + this.E.tc[k], 0);
    this.visibleK = solidK.concat(ghostK);
    this.updateEdgeVisibility();
    this.dirty = true;
  }
  gather(list, src, start, count, per) {
    let total = 0; for (const k of list) total += count[k] * per;
    const out = new Uint32Array(total); let o = 0;
    for (const k of list) { const s = start[k] * per, c = count[k] * per; if (c) { out.set(src.subarray(s, s + c), o); o += c; } }
    return out;
  }
  setEdges(on) { this.edgesWanted = on; this.updateEdgeVisibility(); this.dirty = true; }
  updateEdgeVisibility() {
    if (!this.edges) return;
    // edges on demand: big models only show outlines once zoomed in
    let show = this.edgesWanted && !this.imagesHidden;
    if (show && this.visibleTris > 400000 && this.bounds) {
      const r = this.bounds.getSize(new THREE.Vector3()).length() / 2;
      const d = this.camera.isOrthographicCamera ? r / this.camera.zoom : this.camera.position.distanceTo(this.controls.target);
      show = d < r * 0.6;
    }
    this.edges.visible = show;
  }
  setXray(on) { this.state.xray = on; this.paint(this.state); }

  // ------------------------------------------------------------------ camera, views
  dirOf(name) {
    const e = this.eastV, nn = this.northV, u = this.upV;
    const v = new THREE.Vector3();
    switch (name) {
      case 'top': v.copy(u).addScaledVector(nn, -1e-4); break;
      case 'bottom': v.copy(u).negate().addScaledVector(nn, -1e-4); break;
      case 'front': v.copy(nn).negate(); break;
      case 'back': v.copy(nn); break;
      case 'right': v.copy(e); break;
      case 'left': v.copy(e).negate(); break;
      default: v.copy(e).addScaledVector(nn, -1).addScaledVector(u, 0.85);
    }
    return v.normalize();
  }
  /** Standard views: top, bottom, front, back, left, right, iso. */
  setView(name, keepFit = true) {
    const box = keepFit ? this.visibleBox() : this.bounds;
    if (!box || box.isEmpty()) return;
    this.fitBox(box, this.dirOf(name));
    if (name === 'top' && !this.camera.isOrthographicCamera && keepFit) { /* plans read best in orthographic */ }
    this.cb.onChange?.();
  }
  visibleBox(ids) {
    const b = new THREE.Box3();
    const ks = ids ? ids.map(id => this.kOf.get(id)).filter(k => k != null) : this.visibleK || [];
    for (const k of ks) this.expandByElement(b, k);
    if (this.sectionOn && !b.isEmpty()) b.intersect(this.section);
    return b.isEmpty() ? this.bounds : b;
  }
  expandByElement(b, k) {
    const p = this.pos, v = new THREE.Vector3();
    for (let i = this.E.vs[k] * 3, end = (this.E.vs[k] + this.E.vc[k]) * 3; i < end; i += 3) b.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]));
  }
  elementBox(k) { const b = new THREE.Box3(); this.expandByElement(b, k); return b; }
  fit(ids) { const b = this.visibleBox(ids); const dir = this.camera.position.clone().sub(this.controls.target).normalize(); this.fitBox(b, dir.lengthSq() ? dir : this.dirOf('iso')); }
  fitBox(box, dir) {
    const c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5);
    const vf = THREE.MathUtils.degToRad(this.persp.fov / 2), hf = Math.atan(Math.tan(vf) * this.persp.aspect);
    const d = r / Math.sin(Math.min(vf, hf)) * 0.9;
    for (const cam of [this.persp, this.ortho]) cam.position.copy(c).addScaledVector(dir, d);
    this.persp.near = Math.max(d / 500, 0.01); this.persp.far = d * 40; this.persp.updateProjectionMatrix();
    this.orthoHalf = r * 1.05; this.ortho.zoom = 1; this.updateOrthoFrustum();
    this.controls.target.copy(c); this.controls.update(); this.dirty = true;
  }
  updateOrthoFrustum() {
    const a = this.persp.aspect || 1, h = this.orthoHalf || 10;
    Object.assign(this.ortho, { left: -h * a, right: h * a, top: h, bottom: -h, near: -h * 50, far: h * 50 });
    this.ortho.updateProjectionMatrix();
  }
  setOrtho(on) {
    const next = on ? this.ortho : this.persp;
    if (next === this.camera) return;
    next.position.copy(this.camera.position); next.quaternion.copy(this.camera.quaternion);
    if (on) {   // match the apparent size of the perspective view
      const d = this.persp.position.distanceTo(this.controls.target);
      this.orthoHalf = d * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)); this.ortho.zoom = 1; this.updateOrthoFrustum();
    }
    this.camera = next; this.controls.object = next; this.controls.update();
    this.dirty = true; this.cb.onChange?.();
  }
  get isOrtho() { return this.camera.isOrthographicCamera; }

  // ------------------------------------------------------------------ section box and level plans
  setSection(on, box) {
    this.sectionOn = on;
    if (box) this.section.copy(box);
    const planes = [];
    if (on) {
      const s = this.section;
      for (let a = 0; a < 3; a++) {
        const nMin = new THREE.Vector3(); nMin.setComponent(a, 1);
        const nMax = new THREE.Vector3(); nMax.setComponent(a, -1);
        planes.push(new THREE.Plane(nMin, -s.min.getComponent(a)), new THREE.Plane(nMax, s.max.getComponent(a)));
      }
    }
    this.clip = planes;
    for (const m of [this.solidMat, this.ghostMat, this.edgeMat]) if (m) { m.clippingPlanes = planes; m.needsUpdate = true; }
    this.updateBoxHelper();
    this.dirty = true; this.cb.onChange?.();
  }
  /** Set one side of the section box from a 0..1 fraction of the model bounds. axis: 'x'|'y'|'z', side 'min'|'max'. */
  setSectionFraction(axis, side, f) {
    const a = { x: 0, y: 1, z: 2 }[axis];
    const lo = this.bounds.min.getComponent(a), hi = this.bounds.max.getComponent(a);
    const v = lo + (hi - lo) * Math.min(Math.max(f, 0), 1);
    this.section[side].setComponent(a, v);
    if (this.section.min.getComponent(a) > this.section.max.getComponent(a) - 0.01) {
      if (side === 'min') this.section.min.setComponent(a, this.section.max.getComponent(a) - 0.01); else this.section.max.setComponent(a, this.section.min.getComponent(a) + 0.01);
    }
    this.setSection(true);
  }
  sectionFraction(axis, side) {
    const a = { x: 0, y: 1, z: 2 }[axis];
    const lo = this.bounds.min.getComponent(a), hi = this.bounds.max.getComponent(a);
    return (this.section[side].getComponent(a) - lo) / Math.max(hi - lo, 1e-9);
  }
  sectionToSelection(ids) {
    const b = this.visibleBox(ids); if (b.isEmpty()) return;
    b.expandByScalar(0.3); b.intersect(this.bounds);
    this.setSection(true, b); this.fit(ids);
  }
  updateBoxHelper() {
    if (this.boxHelper) { this.scene.remove(this.boxHelper); this.boxHelper.geometry.dispose(); this.boxHelper = null; }
    if (!this.sectionOn) return;
    this.boxHelper = new THREE.Box3Helper(this.section.clone(), new THREE.Color('#0f6cbd'));
    this.boxHelper.material.transparent = true; this.boxHelper.material.opacity = 0.6;
    this.scene.add(this.boxHelper);
  }
  /** Plan of one level: orthographic top view, cut at levelZ + cut (world metres), showing down to levelZ - below. */
  levelPlan(levelZWorld, cut = 1.2, below = 1.0) {
    const z = levelZWorld - this.origin[this.up];
    const b = this.bounds.clone();
    b.min.setComponent(this.up, Math.max(z - below, this.bounds.min.getComponent(this.up)));
    b.max.setComponent(this.up, Math.min(z + cut, this.bounds.max.getComponent(this.up)));
    this.setSection(true, b);
    this.setOrtho(true);
    this.fitBox(b, this.dirOf('top'));
    this.cb.onChange?.();
  }
  toLocalUp(worldValue) { return worldValue - this.origin[this.up]; }

  // ------------------------------------------------------------------ picking
  clipped(p) { return this.clip.some(pl => pl.distanceToPoint(p) < 0); }
  ndc(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
  }
  /** Element of a picked triangle. faceIndex is in the BVH's (re-ordered) index, so go through its first
   * vertex: vertex ranges are never re-ordered and each triangle only uses its own element's vertices. */
  elementOfPick(face) { return this.elementOfVert(this.pickTri[face * 3]); }
  elementOfVert(v) {  // binary search in vertex start offsets
    const vs = this.E.vs; let lo = 0, hi = this.n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (vs[mid] <= v) lo = mid; else hi = mid - 1; }
    return lo;
  }
  hit(e) {
    if (!this.n) return null;
    this.ensureBVH();
    const ray = new THREE.Raycaster(); ray.setFromCamera(this.ndc(e), this.camera);
    ray.firstHitOnly = false;
    const vis = new Set(this.visibleK || []);
    for (const h of ray.intersectObject(this.pickMesh, false)) {
      const k = this.elementOfPick(h.faceIndex);
      if (!vis.has(k) || this.E.id[k] === -1 || this.clipped(h.point)) continue;
      return { k, id: this.E.id[k], point: h.point, face: h.faceIndex, normal: h.face?.normal };
    }
    return null;
  }

  // ------------------------------------------------------------------ overlay UI (cube clicks, box select, measure labels)
  makeOverlay() {
    this.rect = document.createElement('div'); this.rect.className = 'v-rect'; this.rect.hidden = true;
    this.tip = document.createElement('div'); this.tip.className = 'v-tip'; this.tip.hidden = true;
    this.mlabel = document.createElement('div'); this.mlabel.className = 'v-mlabel'; this.mlabel.hidden = true;
    this.host.append(this.rect, this.tip, this.mlabel);
  }
  setMode(mode) {
    this.mode = mode;
    this.controls.enabled = mode !== 'box';
    this.renderer.domElement.style.cursor = mode === 'orbit' ? '' : 'crosshair';
    if (mode !== 'measure' && mode !== 'area') this.measureClear();
    this.cb.onChange?.();
  }
  bindEvents() {
    const el = this.renderer.domElement;
    let down = null;
    let rdown = null;
    el.addEventListener('pointerdown', (e) => { if (e.button === 2) rdown = { x: e.clientX, y: e.clientY }; }, true);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: Date.now() };
      if (this.cubeHit(e)) { down.cube = true; return; }
      if (this.mode === 'box') { el.setPointerCapture(e.pointerId); }
    });
    el.addEventListener('pointermove', (e) => {
      if (down && this.mode === 'box' && !down.cube) {
        const r = this.host.getBoundingClientRect();
        const x0 = Math.min(down.x, e.clientX) - r.left, y0 = Math.min(down.y, e.clientY) - r.top;
        Object.assign(this.rect.style, { left: x0 + 'px', top: y0 + 'px', width: Math.abs(e.clientX - down.x) + 'px', height: Math.abs(e.clientY - down.y) + 'px' });
        this.rect.hidden = false;
        this.rect.classList.toggle('crossing', e.clientX < down.x);
        return;
      }
      if (e.buttons) return;
      this.queueHover(e);
    });
    el.addEventListener('pointerleave', () => { this.setHover(-1); this.tip.hidden = true; });
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !down) return;
      const d = down; down = null;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (d.cube) { if (moved < 5) { const face = this.cubeHit(e); if (face) this.setView(face); } return; }
      if (this.mode === 'box' && moved > 4) { this.rect.hidden = true; this.boxSelect(d, e); return; }
      if (this.mode === 'box' && this.areaCb) { this.rect.hidden = true; return; }          // a click without a drag: keep waiting
      this.rect.hidden = true;
      if (moved > 4) return;
      const add = e.ctrlKey || e.metaKey || e.shiftKey;
      const h = this.hit(e);
      if (this.mode === 'measure') return this.measureClick(h, e);
      if (this.mode === 'area') return this.areaClick(h);
      this.cb.onPick?.(h ? h.id : null, add);
    });
    el.addEventListener('dblclick', (e) => { const h = this.hit(e); if (h) this.fit([h.id]); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (rdown && Math.hypot(e.clientX - rdown.x, e.clientY - rdown.y) > 5) { rdown = null; return; }   // right-drag pans
      rdown = null;
      const h = this.hit(e); this.cb.onContext?.(h ? h.id : null, e.clientX, e.clientY);      // empty space too (view menu)
    });
    el.tabIndex = 0;
    el.setAttribute('aria-label', '3D model. Arrow keys orbit, plus and minus zoom, F fits, 1 to 7 pick a standard view.');
    el.addEventListener('keydown', (e) => {
      const views = { 1: 'top', 2: 'front', 3: 'right', 4: 'back', 5: 'left', 6: 'bottom', 7: 'iso' };
      if (views[e.key]) { this.setView(views[e.key]); e.preventDefault(); }
      else if (e.key === 'f' || e.key === 'F') { this.fit(); e.preventDefault(); }
      else if (e.key === 'Escape') { if (this.areaCb) this.cancelArea(); else this.setMode('orbit'); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '-', '='].includes(e.key)) {
        const off = this.camera.position.clone().sub(this.controls.target);
        const s = new THREE.Spherical().setFromVector3(this.up === 1 ? off : new THREE.Vector3(off.x, off.z, -off.y));
        if (e.key === 'ArrowLeft') s.theta -= 0.12; if (e.key === 'ArrowRight') s.theta += 0.12;
        if (e.key === 'ArrowUp') s.phi = Math.max(0.01, s.phi - 0.1); if (e.key === 'ArrowDown') s.phi = Math.min(Math.PI - 0.01, s.phi + 0.1);
        if (e.key === '+' || e.key === '=') { if (this.isOrtho) this.camera.zoom *= 1.2; else s.radius /= 1.2; }
        if (e.key === '-') { if (this.isOrtho) this.camera.zoom /= 1.2; else s.radius *= 1.2; }
        const v = new THREE.Vector3().setFromSpherical(s);
        off.copy(this.up === 1 ? v : new THREE.Vector3(v.x, -v.z, v.y));
        this.camera.position.copy(this.controls.target).add(off); this.camera.updateProjectionMatrix(); this.controls.update(); this.dirty = true;
        e.preventDefault();
      }
    });
  }
  queueHover(e) {
    if (this.hoverQueued) { this.hoverEvt = e; return; }
    this.hoverQueued = true; this.hoverEvt = e;
    requestAnimationFrame(() => {
      this.hoverQueued = false;
      if (!this.bvhReady || this.mode === 'box') return;
      const ev = this.hoverEvt;
      if (this.cubeHit(ev)) { this.setHover(-1); this.tip.hidden = true; this.renderer.domElement.style.cursor = 'pointer'; return; }
      this.renderer.domElement.style.cursor = this.mode === 'orbit' ? '' : 'crosshair';
      const h = this.hit(ev);
      this.setHover(h ? h.k : -1);
      const label = h ? this.cb.labelOf?.(h.id) : null;
      if (label) {
        const r = this.host.getBoundingClientRect();
        this.tip.textContent = label; this.tip.hidden = false;
        this.tip.style.left = Math.min(ev.clientX - r.left + 12, r.width - 160) + 'px'; this.tip.style.top = (ev.clientY - r.top + 14) + 'px';
      } else this.tip.hidden = true;
      this.cb.onHover?.(h ? h.id : null);
    });
  }
  setHover(k) {
    if (k === this.hoverK) return;
    this.hoverK = k; this.paint(this.state);
  }
  boxSelect(a, b) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const toN = (x, y) => [(x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1];
    const [x0, y0] = toN(Math.min(a.x, b.clientX), Math.max(a.y, b.clientY));
    const [x1, y1] = toN(Math.max(a.x, b.clientX), Math.min(a.y, b.clientY));
    const crossing = b.clientX < a.x;          // CAD convention: right-to-left selects anything touched
    const ids = [];
    const v = new THREE.Vector3();
    for (const k of this.visibleK || []) {
      if (this.E.id[k] === -1) continue;
      const bb = this.elementBox(k);
      if (this.sectionOn && !bb.intersectsBox(this.section)) continue;
      let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity, behind = false;
      for (let c = 0; c < 8; c++) {
        v.set(c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z).project(this.camera);
        if (v.z > 1) behind = true;
        mnx = Math.min(mnx, v.x); mny = Math.min(mny, v.y); mxx = Math.max(mxx, v.x); mxy = Math.max(mxy, v.y);
      }
      if (behind) continue;
      const inside = mnx >= x0 && mxx <= x1 && mny >= y0 && mxy <= y1;
      const touch = mxx >= x0 && mnx <= x1 && mxy >= y0 && mny <= y1;
      if (crossing || this.areaCrossing ? touch : inside) ids.push(this.E.id[k]);
    }
    if (this.areaCb) { const cb = this.areaCb; this.areaCb = null; this.areaCrossing = false; this.setMode(this.areaPrev || 'orbit'); cb(ids); return; }
    this.cb.onBoxSelect?.(ids, b.ctrlKey || b.metaKey || b.shiftKey);
  }
  /** One rectangle drawn by the user, then cb(ids). crossing: every element the rectangle touches. Esc cancels. */
  pickArea(cb, { crossing = false } = {}) {
    this.areaPrev = this.mode === 'box' ? 'orbit' : this.mode;
    this.areaCb = cb; this.areaCrossing = crossing; this.setMode('box');
  }
  cancelArea() { if (this.areaCb) { this.areaCb = null; this.areaCrossing = false; this.setMode(this.areaPrev || 'orbit'); } }
  /** "Hide Images": the faded (ghost) objects and the edge lines. */
  setImagesHidden(on) { this.imagesHidden = Boolean(on); if (this.ghost) this.ghost.visible = !on; this.updateEdgeVisibility(); this.dirty = true; }

  // ------------------------------------------------------------------ measure tools
  snap(h, e) {
    // snap to the nearest corner of the hit triangle when within 12 px
    const t = h.face * 3, p = this.pos, r = this.renderer.domElement.getBoundingClientRect();
    let best = h.point.clone(), bestD = 12;
    for (let j = 0; j < 3; j++) {
      const vi = this.pickTri[t + j] * 3, w = new THREE.Vector3(p[vi], p[vi + 1], p[vi + 2]);
      const s = w.clone().project(this.camera);
      const dx = (s.x + 1) / 2 * r.width - (e.clientX - r.left), dy = (1 - s.y) / 2 * r.height - (e.clientY - r.top);
      const d = Math.hypot(dx, dy); if (d < bestD) { bestD = d; best = w; }
    }
    return best;
  }
  measureClick(h, e) {
    if (!h) return;
    const p = this.snap(h, e);
    if (!this.mPts || this.mPts.length >= 2) { this.measureClear(); this.mPts = []; }
    this.mPts.push(p);
    this.drawMeasure();
  }
  drawMeasure() {
    if (this.mLine) { this.scene.remove(this.mLine); this.mLine.geometry.dispose(); }
    const pts = this.mPts;
    const g = new THREE.BufferGeometry().setFromPoints(pts.length === 1 ? [pts[0], pts[0]] : pts);
    this.mLine = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#c50f1f', depthTest: false }));
    this.mLine.renderOrder = 10;
    const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), new THREE.PointsMaterial({ color: '#c50f1f', size: 7, sizeAttenuation: false, depthTest: false }));
    this.mLine.add(dots); this.scene.add(this.mLine);
    if (pts.length === 2) {
      const d = pts[0].distanceTo(pts[1]);
      const dd = pts[1].clone().sub(pts[0]);
      const dv = Math.abs(dd.getComponent(this.up));
      const dh = Math.sqrt(Math.max(d * d - dv * dv, 0));
      this.mText = `Distance ${d.toFixed(3)} m · horizontal ${dh.toFixed(3)} m · vertical ${dv.toFixed(3)} m`;
      this.mAt = pts[0].clone().add(pts[1]).multiplyScalar(0.5);
    } else { this.mText = 'Click the second point'; this.mAt = pts[0].clone(); }
    this.cb.onMeasure?.(this.mText, pts.length === 2 ? { distance: pts[0].distanceTo(pts[1]) } : null);
    this.dirty = true;
  }
  areaClick(h) {
    if (!h) return;
    // area of the flat face clicked: every triangle of the element on the same plane
    const k = h.k, p = this.pos, T = this.tri;
    const tri = (t) => { const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
      const A = new THREE.Vector3(p[a], p[a + 1], p[a + 2]), B = new THREE.Vector3(p[b], p[b + 1], p[b + 2]), C = new THREE.Vector3(p[c], p[c + 1], p[c + 2]);
      const n = B.clone().sub(A).cross(C.clone().sub(A)); return { A, B, C, n }; };
    const P = this.pickTri, fa = P[h.face * 3] * 3, fb = P[h.face * 3 + 1] * 3, fc = P[h.face * 3 + 2] * 3;
    const A0 = new THREE.Vector3(p[fa], p[fa + 1], p[fa + 2]), B0 = new THREE.Vector3(p[fb], p[fb + 1], p[fb + 2]), C0 = new THREE.Vector3(p[fc], p[fc + 1], p[fc + 2]);
    const f = { A: A0, n: B0.clone().sub(A0).cross(C0.clone().sub(A0)) }; const n0 = f.n.clone().normalize(); const d0 = n0.dot(f.A);
    let area = 0; const keep = [];
    for (let t = this.E.ts[k], end = this.E.ts[k] + this.E.tc[k]; t < end; t++) {
      const g = tri(t); const len = g.n.length(); if (!len) continue;
      const nn = g.n.clone().divideScalar(len);
      if (Math.abs(nn.dot(n0)) > 0.9998 && Math.abs(n0.dot(g.A) - d0) < 0.002) { area += len / 2; keep.push(g.A, g.B, g.C); }
    }
    this.measureClear();
    const geo = new THREE.BufferGeometry().setFromPoints(keep);
    this.mLine = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#c50f1f', transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthTest: false }));
    this.mLine.renderOrder = 10; this.scene.add(this.mLine);
    this.mText = `Face area ${area.toFixed(3)} m²`;
    this.mAt = h.point.clone();
    this.cb.onMeasure?.(this.mText, { id: h.id, area });
    this.dirty = true;
  }
  measureClear() {
    if (this.mLine) { this.scene.remove(this.mLine); this.mLine.geometry.dispose(); this.mLine = null; }
    this.mPts = null; this.mText = null; if (this.mlabel) this.mlabel.hidden = true;
    this.dirty = true;
  }

  // ------------------------------------------------------------------ view cube (drawn in the top-left corner)
  makeCube() {
    this.cubeScene = new THREE.Scene();
    this.cubeCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
    this.cubeSize = 88;
    this.cubeMesh = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 1.8), []);
    this.cubeScene.add(this.cubeMesh);
    this.cubeScene.add(new THREE.AmbientLight(0xffffff, 2.2));
    this.cubeFaces = [];
  }
  labelCube() {
    // map each box side (+x,-x,+y,-y,+z,-z) to a view name for this model's axes
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(a => new THREE.Vector3(...a));
    const names = { top: this.upV, bottom: this.upV.clone().negate(), back: this.northV, front: this.northV.clone().negate(), right: this.eastV, left: this.eastV.clone().negate() };
    this.cubeFaces = dirs.map(d => Object.entries(names).find(([, v]) => v.dot(d) > 0.9)?.[0] || 'iso');
    const dark = document.documentElement.dataset.theme === 'dark';
    this.cubeMesh.material = this.cubeFaces.map(name => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const x = c.getContext('2d');
      x.fillStyle = dark ? '#3d3d3d' : '#f5f5f5'; x.fillRect(0, 0, 128, 128);
      x.strokeStyle = dark ? '#8a8a8a' : '#9e9e9e'; x.lineWidth = 6; x.strokeRect(3, 3, 122, 122);
      x.fillStyle = dark ? '#ffffff' : '#242424'; x.font = '600 26px Segoe UI, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(name.toUpperCase(), 64, 66);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      return new THREE.MeshBasicMaterial({ map: t });
    });
    this.cubeUp = this.upV.clone();
  }
  cubeRect() {
    const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
    const s = w < 360 ? 64 : this.cubeSize;
    return { x: 8, y: h - s - 8, s, top: 8 };      // GL coords (bottom-left origin) and CSS top
  }
  cubeHit(e) {
    if (!this.n || !e) return null;
    const r = this.renderer.domElement.getBoundingClientRect(), c = this.cubeRect();
    const x = e.clientX - r.left - c.x, y = e.clientY - r.top - c.top;
    if (x < 0 || y < 0 || x > c.s || y > c.s) return null;
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(x / c.s * 2 - 1, -(y / c.s) * 2 + 1), this.cubeCam);
    const h = ray.intersectObject(this.cubeMesh)[0];
    return h ? this.cubeFaces[h.face.materialIndex] : null;
  }

  // ------------------------------------------------------------------ render
  render() {
    this.dirty = false;
    const r = this.renderer, w = r.domElement.width, h = r.domElement.height;
    r.setViewport(0, 0, r.domElement.clientWidth, r.domElement.clientHeight); r.setScissorTest(false);
    r.clear();
    r.render(this.scene, this.camera);
    if (this.n) {
      if (!this.cubeFaces.length || !this.cubeUp?.equals(this.upV)) this.labelCube();
      const c = this.cubeRect();
      const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd);
      this.cubeCam.position.copy(fwd).multiplyScalar(-6); this.cubeCam.quaternion.copy(this.camera.quaternion); this.cubeCam.updateMatrixWorld();
      r.setScissorTest(true); r.setScissor(c.x, c.y, c.s, c.s); r.setViewport(c.x, c.y, c.s, c.s);
      r.clearDepth(); r.render(this.cubeScene, this.cubeCam);
      r.setScissorTest(false); r.setViewport(0, 0, r.domElement.clientWidth, r.domElement.clientHeight);
    }
    if (this.mText && this.mAt) {
      const s = this.mAt.clone().project(this.camera);
      const cw = r.domElement.clientWidth, ch = r.domElement.clientHeight;
      this.mlabel.hidden = s.z > 1;
      this.mlabel.textContent = this.mText;
      this.mlabel.style.left = Math.min(Math.max((s.x + 1) / 2 * cw, 80), cw - 80) + 'px';
      this.mlabel.style.top = ((1 - s.y) / 2 * ch - 26) + 'px';
    }
    void w; void h;
  }

  // ------------------------------------------------------------------ saved views, screenshots
  getViewState() {
    return {
      ortho: this.isOrtho, zoom: this.camera.zoom, orthoHalf: this.orthoHalf,
      pos: this.camera.position.toArray(), target: this.controls.target.toArray(),
      section: this.sectionOn ? [this.section.min.toArray(), this.section.max.toArray()] : null,
    };
  }
  setViewState(v) {
    if (!v) return;
    this.setOrtho(Boolean(v.ortho));
    if (v.orthoHalf) { this.orthoHalf = v.orthoHalf; this.updateOrthoFrustum(); }
    this.camera.position.fromArray(v.pos); this.controls.target.fromArray(v.target);
    if (v.zoom) { this.camera.zoom = v.zoom; this.camera.updateProjectionMatrix(); }
    if (v.section) this.setSection(true, new THREE.Box3(new THREE.Vector3(...v.section[0]), new THREE.Vector3(...v.section[1])));
    else this.setSection(false);
    this.controls.update(); this.dirty = true;
  }
  screenshot(maxW = 1200) {
    this.render();
    const c = this.renderer.domElement;
    if (c.width <= maxW) return c.toDataURL('image/png');
    const k = maxW / c.width, o = document.createElement('canvas');
    o.width = maxW; o.height = Math.round(c.height * k);
    o.getContext('2d').drawImage(c, 0, 0, o.width, o.height);
    return o.toDataURL('image/png');
  }
  stats() { return { elements: this.kOf.size, triangles: this.totalTris || 0, visibleTriangles: this.visibleTris || 0, up: 'xyz'[this.up] }; }
}
