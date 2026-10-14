#!/usr/bin/env python3
"""QS face analysis of a packed model: which faces of every element are free (need formwork, are exposed
to the ground or the sky) and which are covered by other elements.

Usage: python3 -I qs.py <geometry.bin> <geometry.json> <out qs.json> [i/n]
  i/n: only part i of n of the planes (the browser runs the parts in parallel workers and adds them up).

For every element (all areas m2, lengths m, levels m in the model's up axis):
  soffit   free downward faces (within 15 deg of horizontal) that have something below -> formwork with propping
  soffitBands  {"0-3": a, "3-4.5": a, "4.5-6": a, ...} the soffit split by propping height (soffit to surface below)
  ground   downward faces with nothing below (cast on ground or blinding)
  slopeSoffit  free downward faces steeper than 15 deg
  side     free vertical faces (within 15 deg of vertical)
  sides    [[area, zlo, zhi, outer, narrow, vlen]] one row per free vertical plane: outer = faces the outside of the
           building footprint; narrow = the face is 500 mm wide or less (edges, wall ends); vlen = its length along the
           face (m, for narrow faces measured in m)
  topSlope free upward faces steeper than 15 deg (formwork in NRM2)
  top      free upward faces (flat); topExposed = the part with nothing above (roofs); exposedPerim = its plan perimeter
  covered  {category: area} faces covered by other elements (touching face to face, or inside them)
  height   extent along up; thick = the smallest extent (slab / wall thickness); box = true when the element is a box
Plus "overlaps": [[idA, idB, volume]] for box-like elements whose solids overlap (counted once by the rules).

Contact: two faces of different elements on the same plane (5 mm tolerance) with opposite normals touch; the
shared area is exact (polygon intersection). Faces inside another box-like element (unjoined overlaps) are
covered too (exact clip by that box).
"""
import sys, json, math
from collections import defaultdict
import numpy as np
# np.bincount needs the platform index type (32-bit in the browser build of numpy)
_bc = lambda x, *a, **k: np.bincount(np.asarray(x).astype(np.intp, copy=False), *a, **k)
import shapely
from shapely.geometry import Polygon, box as sbox
from shapely.ops import unary_union

# Polygon overlays are exact; if GEOS reports a robustness problem ("non-noded intersection" on nearly coincident
# edges), the operation is repeated on a 1 micron precision grid (snap rounding), which cannot fail.
GRID = 1e-6
from shapely.errors import GEOSException
def _areal(g):
    """Only the polygonal part (snap rounding can leave slivers as lines or points, which overlays refuse)."""
    t = g.geom_type
    if t in ('Polygon', 'MultiPolygon'): return g
    if t == 'GeometryCollection':
        parts = [p for p in g.geoms if p.geom_type in ('Polygon', 'MultiPolygon')]
        return shapely.union_all(parts, grid_size=GRID) if parts else Polygon()
    return Polygon()
def U(geoms):
    try: return shapely.union_all(geoms)
    except GEOSException: return _areal(shapely.union_all([_areal(x) for x in geoms], grid_size=GRID))
def D(x, y):
    try: return x.difference(y)
    except GEOSException: return _areal(shapely.difference(_areal(x), _areal(y), grid_size=GRID))
def I(x, y):
    try: return x.intersection(y)
    except GEOSException: return _areal(shapely.intersection(_areal(x), _areal(y), grid_size=GRID))

BIN, GEO, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
PART = tuple(int(x) for x in sys.argv[4].split('/')) if len(sys.argv) > 4 else None
TOL = 0.005                       # 5 mm: faces this close touch
COS15, SIN15 = math.cos(math.radians(15)), math.sin(math.radians(15))
BANDS = [0, 3.0, 4.5, 6.0, 7.5, 9.0, 10.5, 12.0, 13.5, 15.0]   # NRM2: up to 3 m, 3-4.5 m, then 1.5 m stages

raw = open(BIN, 'rb').read()
assert raw[:4] == b'DWG2'
hl = int.from_bytes(raw[4:8], 'little')
head = json.loads(raw[8:8 + hl])
off = 8 + hl
nV, nT = head['nVerts'], head['nTris']
L = np.frombuffer(raw, '<f4', nV * 3, off).reshape(-1, 3).astype(np.float64); off += nV * 12
T = np.frombuffer(raw, '<u4', nT * 3, off).reshape(-1, 3).astype(np.int64)
P = L + np.array(head['origin'])
UP = 'xyz'.index(head.get('up', 'y'))
HZ = [i for i in range(3) if i != UP]
rows = head['elements']
cats = {int(k): v for k, v in (json.load(open(GEO)).get('categories') or {}).items()}

el = np.full(nT, -1, dtype=np.int64)
for k, r in enumerate(rows):
    el[r[3]:r[3] + r[4]] = k
ids = [r[0] for r in rows]

a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
cr = np.cross(b - a, c - a)
nrm = np.linalg.norm(cr, axis=1)
area = nrm / 2
# only the structure is analysed (formwork, contact, waterproofing): pipes, ducts, furniture and finishes add
# triangles but no QS quantities, and their faces must not cover concrete faces
import re as _re
QS_CAT = _re.compile(r'foundation|column|framing|floor|wall|roof|stair|run|landing|slab|beam|pile|ramp|structural', _re.I)
el_ok = np.array([ids[k] != -1 and bool(QS_CAT.search(cats.get(ids[k], '') or '')) for k in range(len(rows))] or [False], dtype=bool)
ok = (area > 1e-9) & (el >= 0) & el_ok[el.clip(0)]
n = np.divide(cr, np.where(nrm > 0, nrm, 1)[:, None])

# ---------------------------------------------------------------- element boxes, box-likeness
nE = len(rows)
lo = np.full((nE, 3), np.inf); hi = np.full((nE, 3), -np.inf)
for k, r in enumerate(rows):
    if r[2]:
        v = P[r[1]:r[1] + r[2]]; lo[k] = v.min(0); hi[k] = v.max(0)
# volume by divergence (closed shells); box-like = volume fills its bounding box
cen = np.where(np.isfinite(lo), (lo + hi) / 2, 0)
sv = np.einsum('ij,ij->i', a - cen[el.clip(0)], cr) / 6
vol = np.abs(_bc(el.clip(0), weights=np.where(ok, sv, 0), minlength=nE))
bbv = np.prod(np.maximum(hi - lo, 0), axis=1)
boxlike = (bbv > 1e-9) & (vol >= 0.97 * bbv) & (vol <= 1.03 * bbv)
ext = hi - lo

# ---------------------------------------------------------------- planes (same normal, same offset within 5 mm)
sgn = np.where(np.abs(n[:, 0]) >= np.maximum(np.abs(n[:, 1]), np.abs(n[:, 2])), np.sign(n[:, 0]),
               np.where(np.abs(n[:, 1]) >= np.abs(n[:, 2]), np.sign(n[:, 1]), np.sign(n[:, 2])))
sgn[sgn == 0] = 1
cn = n * sgn[:, None]
cent = (a + b + c) / 3
d = np.einsum('ij,ij->i', cn, cent)
nkey = np.round(cn * 200).astype(np.int64)             # ~0.3 degree normal bins
def group_rows(idx, keys):
    """idx split by equal key rows, groups in order of first appearance (vectorised)."""
    if not len(idx): return []
    _, first_i, inv = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1); order = np.argsort(inv, kind='stable')
    cuts = np.flatnonzero(np.diff(inv[order])) + 1
    parts = np.split(idx[order], cuts)
    return [parts[g] for g in np.argsort(first_i, kind='stable')]
_okt = np.flatnonzero(ok)
groups = {n: g for n, g in enumerate(group_rows(_okt, nkey[_okt]))}

def _cross(p, q):
    return np.array([p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]])
def basis(nv):
    u = _cross(nv, (0.0, 0.0, 1.0) if abs(nv[2]) < 0.9 else (1.0, 0.0, 0.0)); u /= math.sqrt(float(u @ u))
    return u, _cross(nv, u)

clusters = []
for key, ts in groups.items():
    ts = np.array(ts); order = np.argsort(d[ts]); ts = ts[order]; dd = d[ts]
    cut = np.flatnonzero(np.diff(dd) > TOL) + 1
    for part in np.split(ts, cut):
        clusters.append(part)

def tri_polys(ts, X, Y):
    """Triangles ts as shapely polygons in 2D coordinates X(p), Y(p) (vectorised; slivers dropped)."""
    ts = np.asarray(ts)
    if not len(ts): return []
    ring = np.stack([a[ts], b[ts], c[ts], a[ts]], axis=1)                     # (n, 4, 3)
    xy = np.stack([X(ring), Y(ring)], axis=-1)                               # (n, 4, 2)
    pg = shapely.polygons(xy)
    return pg[shapely.area(pg) > 1e-10]

def poly2d(ts, u, v):
    pgs = tri_polys(ts, lambda r: r @ u, lambda r: r @ v)
    return U(pgs) if len(pgs) else Polygon()

def plane_box_poly(k, nv, dv, u, v, shrink=0.001):
    """The section of element k's bounding box (shrunk) cut by the plane nv.x = dv, as a 2D polygon."""
    sh = shrink * np.abs(nv)                       # only across the face, so in-plane extents stay exact
    l, h = lo[k] + sh, hi[k] - sh
    if np.any(h <= l): return None
    corners = np.array([[l[0] if i & 1 == 0 else h[0], l[1] if i & 2 == 0 else h[1], l[2] if i & 4 == 0 else h[2]] for i in range(8)])
    s = corners @ nv - dv
    if s.min() >= 0 or s.max() <= 0: return None
    pts = []
    for i in range(8):
        for j in range(i + 1, 8):
            if bin(i ^ j).count('1') != 1: continue
            if (s[i] > 0) != (s[j] > 0):
                tt = s[i] / (s[i] - s[j]); p = corners[i] + tt * (corners[j] - corners[i])
                pts.append((float(p @ u), float(p @ v)))
    if len(pts) < 3: return None
    hull = shapely.MultiPoint(pts).convex_hull
    return hull if hull.area > 1e-10 else None

# ---------------------------------------------------------------- tops / bottoms index for "what is below / above"
up_t = np.flatnonzero(ok & (n[:, UP] > 0.3))
dn_t = np.flatnonzero(ok & (n[:, UP] < -0.3))
def to3d(pts2, u, v, nv, dv):
    return pts2[:, :1] * u + pts2[:, 1:2] * v + dv * nv

def band(h):
    for i in range(len(BANDS) - 1):
        if h <= BANDS[i + 1] + 1e-6:
            return f'{BANDS[i]:g}-{BANDS[i + 1]:g}'
    return f'>{BANDS[-1]:g}'

# ---------------------------------------------------------------- exact surfaces in plan, for "what is below / above"
def plan_surfaces(ts):
    """Faces grouped per element and height: [(k, z, plan polygon)] (sloping faces stay one per triangle)."""
    ts = np.asarray(ts)
    if not len(ts): return []
    Z = np.stack([a[ts, UP], b[ts, UP], c[ts, UP]], axis=1)
    flat = Z.max(axis=1) - Z.min(axis=1) < 0.002
    zkey = np.where(flat, np.round(Z.mean(axis=1), 3) * 1000, 0).round().astype(np.int64)
    tkey = np.where(flat, -1, ts)                                  # sloping faces: one group per triangle
    out = []
    for lst in group_rows(ts, np.stack([el[ts], zkey, tkey], axis=1)):
        polys = tri_polys(lst, lambda r: r[..., HZ[0]], lambda r: r[..., HZ[1]])
        if not len(polys): continue
        out.append((int(el[lst[0]]), float(cent[lst, UP].mean()), U(polys)))
    return out
S_UP, S_DN = plan_surfaces(up_t), plan_surfaces(dn_t)
T_UP = shapely.STRtree([pg for _, _, pg in S_UP]) if S_UP else None     # spatial index: only nearby surfaces are tested
T_DN = shapely.STRtree([pg for _, _, pg in S_DN]) if S_DN else None
def near(tree, surfaces, geom):
    return [surfaces[i] for i in tree.query(geom, predicate='intersects')] if tree is not None else []

def plan_of(free, u, v, nv, dv):
    def tr(xy):
        p3 = xy[:, :1] * u + xy[:, 1:2] * v + dv * nv
        return np.column_stack([p3[:, HZ[0]], p3[:, HZ[1]]])
    return shapely.transform(free, tr)

def split_below(fplan, z0, k_self):
    """Plan polygon of a soffit at height z0 -> [(clear height, plan area)] to the nearest surface below; rest = None."""
    out, rem = [], fplan
    cands = sorted(((z, pg) for (k2, z, pg) in near(T_UP, S_UP, fplan) if k2 != k_self and z < z0 - 0.02), key=lambda x: -x[0])
    for z, pg in cands:
        if rem.is_empty or rem.area <= 1e-9: break
        inter = I(rem, pg)
        if inter.area > 1e-9:
            out.append((z0 - z, inter.area)); rem = D(rem, pg)
    out.append((None, rem.area if not rem.is_empty else 0.0))
    return out

def exposed_above(fplan, z0, k_self):
    """The part of a top face (plan polygon) with nothing above it."""
    rem = fplan
    for (k2, z, pg) in sorted(near(T_DN, S_DN, fplan), key=lambda x: x[1]):
        if k2 != k_self and z > z0 + 0.02 and pg.intersects(rem):
            rem = D(rem, pg)
            if rem.is_empty: return rem
    return rem

# ---------------------------------------------------------------- building footprint (for outer faces)
plan_polys = tri_polys(up_t, lambda r: r[..., HZ[0]], lambda r: r[..., HZ[1]])
footprint = U(plan_polys).buffer(0.05).buffer(-0.05) if len(plan_polys) else Polygon()
if not footprint.is_empty: shapely.prepare(footprint)

# ---------------------------------------------------------------- priority (who owns a shared face or volume)
ORDER = ['foundation', 'column', 'wall', 'framing', 'beam', 'floor', 'slab', 'roof', 'stair']
def prio_of(cat):
    cl = (cat or '').lower()
    for i, w in enumerate(ORDER):
        if w in cl: return i
    return len(ORDER)
PRIO = lambda k: (prio_of(cats.get(ids[k], '')), ids[k])

# ---------------------------------------------------------------- spatial index of box-like elements (plan boxes)
BOX_K = np.flatnonzero(boxlike & np.array([i != -1 for i in ids], dtype=bool))
BOX_T = shapely.STRtree([sbox(lo[k, HZ[0]] - TOL, lo[k, HZ[1]] - TOL, hi[k, HZ[0]] + TOL, hi[k, HZ[1]] + TOL) for k in BOX_K]) if len(BOX_K) else None
def boxes_near(qlo, qhi):
    """Box-like elements whose box meets the 3D box [qlo, qhi] (within TOL)."""
    if BOX_T is None: return []
    c = BOX_K[BOX_T.query(sbox(qlo[HZ[0]], qlo[HZ[1]], qhi[HZ[0]], qhi[HZ[1]]))]
    return c[(lo[c, UP] <= qhi[UP] + TOL) & (hi[c, UP] >= qlo[UP] - TOL)]

# ---------------------------------------------------------------- main pass
def new_R():
    return [dict(soffit=0.0, soffitBands=defaultdict(float), ground=0.0, slopeSoffit=0.0, side=0.0, sides=[], topSlope=0.0,
          top=0.0, topExposed=0.0, exposedPerim=0.0, covered=defaultdict(float)) for _ in rows]

def run_clusters(sub):
    R = new_R()
    for ts in sub:
        t0 = ts[0]
        nv = cn[t0] / np.linalg.norm(cn[t0]); dv = float(np.mean(d[ts]))
        u, v = basis(nv)
        by = defaultdict(lambda: {1: [], -1: []})
        for t in ts:
            by[int(el[t])][int(sgn[t])].append(t)
        elems = list(by.keys())
        polys = {(k, s): poly2d(lst, u, v) for k in elems for s in (1, -1) if (lst := by[k][s])}
        first = {key: n for n, key in enumerate(polys)}                     # covering faces are checked in their original order
        items = [(k, s, pg) for (k, s), pg in sorted(polys.items(), key=lambda kv: PRIO(kv[0][0])) if not pg.is_empty]
        if not items: continue
        # bounding boxes: on a shared plane (all slab tops of a level...) each face is only compared with the faces near it
        bx = np.array([pg.bounds for _, _, pg in items]); sx = np.array([s for _, s, _ in items]); kx = np.array([k for k, _, _ in items])
        for i, (k, s, pg) in enumerate(items):
            near_i = (bx[:, 0] <= bx[i, 2] + 1e-9) & (bx[:, 2] >= bx[i, 0] - 1e-9) & (bx[:, 1] <= bx[i, 3] + 1e-9) & (bx[:, 3] >= bx[i, 1] - 1e-9)
            # same-direction faces of overlapping elements: one owner (the earlier, higher-priority element)
            prev = [items[j][2] for j in np.flatnonzero(near_i[:i] & (sx[:i] == s))]
            free = D(pg, U(prev)) if prev else pg
            opp = sorted(((int(kx[j]), items[j][2]) for j in np.flatnonzero(near_i & (sx == -s) & (kx != k))), key=lambda o: first[(o[0], -s)])
            for k2, p2 in opp:
                inter = I(free, p2)
                if inter.area > 1e-8:
                    R[k]['covered'][cats.get(ids[k2], 'Other')] += inter.area
                    free = D(free, p2)
            if free.area <= 1e-8: continue
            # inside another box-like element (unjoined overlap)
            fb = free.bounds
            q1, q2 = to3d(np.array([[fb[0], fb[1]], [fb[2], fb[3]]]), u, v, nv, dv)
            for k2 in boxes_near(np.minimum(q1, q2), np.maximum(q1, q2)):
                if k2 == k: continue
                sec = plane_box_poly(k2, nv, dv, u, v)
                if sec is None: continue
                inter = I(free, sec)
                if inter.area > 1e-8:
                    R[k]['covered'][cats.get(ids[k2], 'Other')] += inter.area
                    free = D(free, sec)
                    if free.area <= 1e-8: break
            A = free.area
            if A <= 1e-8: continue
            nz = float(nv[UP] * s)                                   # outward normal component along up
            rk = R[k]
            if nz <= -COS15:
                # soffit: split exactly by the surface straight below each part (propping height), or the ground
                fplan = plan_of(free, u, v, nv, dv)
                scale = A / fplan.area if fplan.area > 1e-12 else 1.0
                rp = free.representative_point(); z0 = float(to3d(np.array([[rp.x, rp.y]]), u, v, nv, dv)[0][UP])
                for h, ar in split_below(fplan, z0, k):
                    if ar <= 1e-9: continue
                    if h is None: rk['ground'] += ar * scale
                    else: rk['soffit'] += ar * scale; rk['soffitBands'][band(h)] += ar * scale
            elif nz < -SIN15:
                rk['slopeSoffit'] += A
            elif nz <= SIN15:
                rk['side'] += A
                g = free
                zs = []
                for geom in (g.geoms if hasattr(g, 'geoms') else [g]):
                    zs.extend([float((to3d(np.array([[x, y]]), u, v, nv, dv)[0])[UP]) for x, y in geom.exterior.coords])
                zlo, zhi = (min(zs), max(zs)) if zs else (0.0, 0.0)
                # width across the face (horizontal in-plane direction) and length along it
                hdir = np.cross(nv, np.eye(3)[UP]); hn = np.linalg.norm(hdir)
                hdir = hdir / hn if hn > 1e-9 else u
                hu = np.array([hdir @ u, hdir @ v]); vu = np.array([np.eye(3)[UP] @ u, np.eye(3)[UP] @ v])
                coords = np.vstack([np.array(geom.exterior.coords) for geom in (g.geoms if hasattr(g, 'geoms') else [g])])
                wid = float((coords @ hu).max() - (coords @ hu).min()); hgt = float((coords @ vu).max() - (coords @ vu).min())
                narrow = min(wid, hgt) <= 0.5 + 1e-6
                vlen = max(wid, hgt) if narrow else 0.0
                # outer: points half a metre out from the face (middle of its height, at 1/4, 1/2 and 3/4 of its length) are
                # outside the building footprint (majority; plain arithmetic, so every GEOS version gives the same answer)
                hc = coords @ hu; vc = coords @ vu
                mid_v = (vc.max() + vc.min()) / 2
                outs = 0
                det = hu[0] * vu[1] - hu[1] * vu[0]
                for f in (0.25, 0.5, 0.75):
                    h_ = hc.min() + f * (hc.max() - hc.min())
                    # plane coordinates (x, y) with x.hu = h_ and x.vu = mid_v (2 x 2, Cramer's rule)
                    uv = np.array([(h_ * vu[1] - mid_v * hu[1]) / det, (hu[0] * mid_v - vu[0] * h_) / det]) if abs(det) > 1e-12 else np.zeros(2)
                    p3 = to3d(np.array([uv]), u, v, nv, dv)[0] + nv * s * 0.5
                    outs += not shapely.contains_xy(footprint, float(p3[HZ[0]]), float(p3[HZ[1]]))
                outer = bool(not footprint.is_empty and outs >= 2)
                rk['sides'].append([round(A, 4), round(zlo, 4), round(zhi, 4), outer, bool(narrow), round(vlen, 4)])
            elif nz < COS15:
                rk['topSlope'] += A
            else:
                rk['top'] += A
                fplan = plan_of(free, u, v, nv, dv)
                scale = A / fplan.area if fplan.area > 1e-12 else 1.0
                rp = free.representative_point(); z0 = float(to3d(np.array([[rp.x, rp.y]]), u, v, nv, dv)[0][UP])
                ex = exposed_above(fplan, z0, k)
                if not ex.is_empty:
                    rk['topExposed'] += ex.area * scale
                    rk['exposedPerim'] += ex.length              # plan perimeter of the exposed part (roof upstands)
    return R

def plain(R):
    for r in R:
        r['soffitBands'] = dict(r['soffitBands']); r['covered'] = dict(r['covered'])
    return R
def _part(i):
    return plain(run_clusters(clusters[i::PROCS]))

# Planes are independent: on the server they are shared out over the processor cores (QS_PROCS, default: all of them).
# In the browser (Pyodide) there are no processes, so it runs in one.
import os
PROCS = 1 if sys.platform == 'emscripten' else max(1, min(int(os.environ.get('QS_PROCS', '0') or 0) or (os.cpu_count() or 1), 16))
if PART:
    R = plain(run_clusters(clusters[PART[0]::PART[1]]))
elif PROCS > 1 and len(clusters) > 400:
    import multiprocessing as mp
    with mp.get_context('fork').Pool(PROCS) as pool:
        parts = pool.map(_part, range(PROCS))
    R = parts[0]
    for P_ in parts[1:]:
        for r, q_ in zip(R, P_):
            for key in ('soffit', 'ground', 'slopeSoffit', 'side', 'topSlope', 'top', 'topExposed', 'exposedPerim'): r[key] += q_[key]
            r['sides'] += q_['sides']
            for dk in ('soffitBands', 'covered'):
                for kk, vv in q_[dk].items(): r[dk][kk] = r[dk].get(kk, 0.0) + vv
else:
    R = plain(run_clusters(clusters))

# ---------------------------------------------------------------- overlaps between box-like solids
overlaps = []
order = np.argsort(lo[:, 0]) if not PART or PART[0] == 0 else []
for ii, k in enumerate(order):
    if not boxlike[k] or ids[k] == -1: continue
    for k2 in order[ii + 1:]:
        if lo[k2, 0] >= hi[k, 0] - TOL: break
        if not boxlike[k2] or ids[k2] == -1: continue
        ov = np.minimum(hi[k], hi[k2]) - np.maximum(lo[k], lo[k2])
        if np.all(ov > TOL):
            overlaps.append([ids[k], ids[k2], round(float(np.prod(ov)), 6)])

r4 = lambda x: round(float(x), 4)
out = {}
if PART:
    # one part of n: the raw sums (not rounded), so adding the parts up (public/js/modelmerge.js) gives exactly what one run gives
    for k, r in enumerate(rows):
        if r[0] == -1 or not r[2]: continue
        q = R[k]
        out[str(r[0])] = {key: q[key] for key in ('soffit', 'soffitBands', 'ground', 'slopeSoffit', 'side', 'sides', 'topSlope', 'top', 'topExposed', 'exposedPerim', 'covered')}
        if PART[0] == 0:
            out[str(r[0])].update(height=r4(ext[k, UP]), thick=r4(ext[k].min()), box=bool(boxlike[k]), vol=round(float(vol[k]), 6), zlo=r4(lo[k, UP]), zhi=r4(hi[k, UP]))
    json.dump({'version': 1, 'up': 'xyz'[UP], 'elements': out, 'overlaps': overlaps, 'part': list(PART)}, open(OUT, 'w'))
    print('qs part', PART, len(out), 'elements')
    sys.exit(0)
for k, r in enumerate(rows):
    if r[0] == -1 or not r[2]: continue
    q = R[k]
    out[str(r[0])] = dict(soffit=r4(q['soffit']), soffitBands={kk: r4(vv) for kk, vv in q['soffitBands'].items() if vv > 1e-6},
                          ground=r4(q['ground']), slopeSoffit=r4(q['slopeSoffit']), side=r4(q['side']), sides=q['sides'],
                          topSlope=r4(q['topSlope']), top=r4(q['top']), topExposed=r4(q['topExposed']), exposedPerim=r4(q['exposedPerim']),
                          covered={kk: r4(vv) for kk, vv in q['covered'].items() if vv > 1e-6},
                          height=r4(ext[k, UP]), thick=r4(ext[k].min()), box=bool(boxlike[k]), vol=round(float(vol[k]), 6),
                          zlo=r4(lo[k, UP]), zhi=r4(hi[k, UP]))
json.dump({'version': 1, 'up': 'xyz'[UP], 'elements': out, 'overlaps': overlaps}, open(OUT, 'w'))
print('qs', len(out), 'elements', len(overlaps), 'overlaps', len(clusters), 'planes')
