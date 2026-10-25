// Auto Count (CostX): find every copy of a captured symbol on a drawing image, whatever its rotation (0/90/180/270°)
// or mirror. Normalised cross-correlation (1.0 = identical), searched on a reduced image first and refined at full
// size. Blank parts of the sheet are skipped, so a whole drawing takes about a second. Pure functions: run in a
// worker in the browser (acworker.js) and directly in the unit tests.

/** Grey image { w, h, d: Float32Array } (0 = white, 1 = black ink) from RGBA pixels. */
export function toInk(rgba, w, h) {
  const d = new Float32Array(w * h);
  for (let i = 0, j = 0; j < d.length; i += 4, j++) {
    const a = rgba[i + 3] / 255, lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255;
    d[j] = (1 - lum) * a;
  }
  return { w, h, d };
}
/** Average f x f blocks (keeps thin lines visible as grey). */
export function shrink(img, f) {
  if (f <= 1) return img;
  const w = Math.floor(img.w / f), h = Math.floor(img.h / f), d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let j = 0; j < f; j++) { const row = (y * f + j) * img.w + x * f; for (let i = 0; i < f; i++) s += img.d[row + i]; }
    d[y * w + x] = s / (f * f);
  }
  return { w, h, d };
}
/** Rotations (0, 90, 180, 270) and their mirror images of a template; duplicates (symmetric symbols) removed. */
export function variants(t) {
  const out = [], seen = new Set();
  const rot = (im) => { const w = im.h, h = im.w, d = new Float32Array(w * h); for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) d[x * w + (w - 1 - y)] = im.d[y * im.w + x]; return { w, h, d }; };
  const flip = (im) => { const d = new Float32Array(im.d.length); for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) d[y * im.w + (im.w - 1 - x)] = im.d[y * im.w + x]; return { w: im.w, h: im.h, d }; };
  let cur = t;
  for (let m = 0; m < 2; m++) {
    for (let r = 0; r < 4; r++) {
      const key = cur.w + 'x' + cur.h + ':' + Array.from(cur.d, v => Math.round(v * 8)).join('');
      if (!seen.has(key)) { seen.add(key); out.push({ ...cur, rot: r * 90, mirror: Boolean(m) }); }
      cur = rot(cur);
    }
    cur = flip(t);
  }
  return out;
}
function prep(t) {             // zero-mean template and its norm
  const n = t.d.length; let mean = 0; for (const v of t.d) mean += v; mean /= n;
  const z = new Float32Array(n); let ss = 0; for (let i = 0; i < n; i++) { z[i] = t.d[i] - mean; ss += z[i] * z[i]; }
  return { ...t, z, norm: Math.sqrt(ss) };
}
function integrals(img) {
  const W = img.w + 1, s = new Float64Array(W * (img.h + 1)), q = new Float64Array(W * (img.h + 1));
  for (let y = 0; y < img.h; y++) { let rs = 0, rq = 0; for (let x = 0; x < img.w; x++) { const v = img.d[y * img.w + x]; rs += v; rq += v * v; s[(y + 1) * W + x + 1] = s[y * W + x + 1] + rs; q[(y + 1) * W + x + 1] = q[y * W + x + 1] + rq; } }
  return { s, q, W };
}
/** Normalised correlation of the prepared template t with img at (x, y), from -1 to 1. */
function score(img, I, t, x, y) {
  const n = t.w * t.h;
  const sum = I.s[(y + t.h) * I.W + x + t.w] - I.s[y * I.W + x + t.w] - I.s[(y + t.h) * I.W + x] + I.s[y * I.W + x];
  const sq = I.q[(y + t.h) * I.W + x + t.w] - I.q[y * I.W + x + t.w] - I.q[(y + t.h) * I.W + x] + I.q[y * I.W + x];
  const varw = sq - sum * sum / n;
  if (varw < 1e-6 || t.norm < 1e-6) return 0;
  let dot = 0;
  for (let j = 0; j < t.h; j++) { const row = (y + j) * img.w + x, tr = j * t.w; for (let i = 0; i < t.w; i++) dot += img.d[row + i] * t.z[tr + i]; }
  return dot / (Math.sqrt(varw) * t.norm);
}

/**
 * Find copies of template tpl in img (both from toInk). opts: { min: lowest score kept (0..1), maxResults, region {x,y,w,h} }.
 * Returns [{ x, y, w, h, score, rot, mirror }] in img pixels, best first, overlaps removed.
 */
export function findMatches(img, tpl, { min = 0.5, maxResults = 2000, region = null } = {}) {
  const side = Math.max(tpl.w, tpl.h);
  const f = Math.max(1, Math.floor(side / 18));
  const small = shrink(img, f), I = integrals(small);
  const fullI = integrals(img);
  const vs = variants(tpl).map(v => ({ full: prep(v), small: prep(shrink(v, f)), rot: v.rot, mirror: v.mirror }));
  const rx0 = region ? Math.max(0, Math.floor(region.x / f)) : 0, ry0 = region ? Math.max(0, Math.floor(region.y / f)) : 0;
  const rx1 = region ? Math.min(small.w, Math.ceil((region.x + region.w) / f)) : small.w, ry1 = region ? Math.min(small.h, Math.ceil((region.y + region.h) / f)) : small.h;
  const coarseMin = Math.max(0.2, min - 0.25);
  const cand = [];
  // ink needed in a window: a symbol has some lines; skip empty paper fast
  for (const v of vs) {
    const t = v.small; if (!t.w || !t.h) continue;
    const tInk = t.d.reduce((a, b) => a + b, 0);
    for (let y = ry0; y + t.h <= ry1; y++) for (let x = rx0; x + t.w <= rx1; x++) {
      const ink = I.s[(y + t.h) * I.W + x + t.w] - I.s[y * I.W + x + t.w] - I.s[(y + t.h) * I.W + x] + I.s[y * I.W + x];
      if (ink < tInk * 0.35 || ink > tInk * 2.5) continue;
      const sc = score(small, I, t, x, y);
      if (sc >= coarseMin) cand.push({ x: x * f, y: y * f, sc, v });
    }
  }
  cand.sort((a, b) => b.sc - a.sc);
  // refine around each coarse hit at full size, then keep the best, without overlaps
  const out = [];
  const taken = (x, y, w, h) => out.some(o => Math.abs(o.x + o.w / 2 - (x + w / 2)) < Math.min(o.w, w) * 0.6 && Math.abs(o.y + o.h / 2 - (y + h / 2)) < Math.min(o.h, h) * 0.6);
  const seen = [];                                // places already refined: neighbouring rough hits are the same symbol
  const near = (x, y, w, h) => seen.some(o => Math.abs(o.x - x) < w / 2 && Math.abs(o.y - y) < h / 2);
  for (const c of cand) {
    if (out.length >= maxResults || seen.length > 4000) break;
    if (taken(c.x, c.y, c.v.full.w, c.v.full.h) || near(c.x, c.y, c.v.full.w, c.v.full.h)) continue;
    seen.push({ x: c.x, y: c.y });
    let best = -1, bx = c.x, by = c.y, bv = c.v;
    const own = c.v, others = vs.filter(v => v !== own);
    for (const v of [own, ...others]) {           // every rotation: the coarse pass can rank a similar one first
      if (v !== own && best < min - 0.2) break;   // clearly not this symbol: skip the other rotations
      const t = v.full;
      for (let dy = -f; dy <= f; dy++) for (let dx = -f; dx <= f; dx++) {
        const x = c.x + dx, y = c.y + dy;
        if (x < 0 || y < 0 || x + t.w > img.w || y + t.h > img.h) continue;
        const sc = score(img, fullI, t, x, y); if (sc > best) { best = sc; bx = x; by = y; bv = v; }
      }
    }
    if (best >= min && !taken(bx, by, bv.full.w, bv.full.h)) out.push({ x: bx, y: by, w: bv.full.w, h: bv.full.h, score: best, rot: bv.rot, mirror: bv.mirror });
  }
  return out.sort((a, b) => b.score - a.score);
}
