#!/usr/bin/env python3
"""QS face analysis of a packed model: which faces of every element are free (need formwork, are exposed
to the ground or the sky) and which are covered by other elements.

Usage: python3 -I qs.py <geometry.bin> <geometry.json> <out qs.json>

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
import shapely
from shapely.geometry import Polygon, box as sbox
from shapely.ops import unary_union

BIN, GEO, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
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
ok = (area > 1e-9) & (el >= 0) & (np.array([ids[k] for k in el.clip(0)]) != -1)
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
vol = np.abs(np.bincount(el.clip(0), weights=np.where(ok, sv, 0), minlength=nE))
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
groups = defaultdict(list)
for t in np.flatnonzero(ok):
    groups[(nkey[t, 0], nkey[t, 1], nkey[t, 2])].append(t)

def basis(nv):
    u = np.cross(nv, [0, 0, 1] if abs(nv[2]) < 0.9 else [1, 0, 0]); u /= np.linalg.norm(u)
    return u, np.cross(nv, u)

clusters = []
for key, ts in groups.items():
    ts = np.array(ts); order = np.argsort(d[ts]); ts = ts[order]; dd = d[ts]
    cut = np.flatnonzero(np.diff(dd) > TOL) + 1
    for part in np.split(ts, cut):
        clusters.append(part)

def poly2d(ts, u, v):
    out = []
    for t in ts:
        pts = [(float(p @ u), float(p @ v)) for p in (a[t], b[t], c[t])]
        pg = Polygon(pts)
        if pg.area > 1e-10:
            out.append(pg.buffer(0))
    return unary_union(out) if out else Polygon()

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
    """Faces grouped per element and height: [(k, z, plan polygon, minz, maxz)] (sloping faces stay one per triangle)."""
    grp = defaultdict(list)
    for t in ts:
        zs = (a[t][UP], b[t][UP], c[t][UP])
        flat = max(zs) - min(zs) < 0.002
        grp[(int(el[t]), round(float(np.mean(zs)), 3)) if flat else (int(el[t]), 'tri', int(t))].append(t)
    out = []
    for key, lst in grp.items():
        polys = [Polygon([(float(p[HZ[0]]), float(p[HZ[1]])) for p in (a[t], b[t], c[t])]) for t in lst]
        polys = [pg.buffer(0) for pg in polys if pg.area > 1e-10]
        if not polys: continue
        z = float(np.mean([cent[t][UP] for t in lst]))
        out.append((key[0], z, unary_union(polys)))
    return out
S_UP, S_DN = plan_surfaces(up_t), plan_surfaces(dn_t)

def plan_of(free, u, v, nv, dv):
    def tr(xy):
        p3 = xy[:, :1] * u + xy[:, 1:2] * v + dv * nv
        return np.column_stack([p3[:, HZ[0]], p3[:, HZ[1]]])
    return shapely.transform(free, tr)

def split_below(fplan, z0, k_self):
    """Plan polygon of a soffit at height z0 -> [(clear height, plan area)] to the nearest surface below; rest = None."""
    out, rem = [], fplan
    cands = sorted(((z, pg) for (k2, z, pg) in S_UP if k2 != k_self and z < z0 - 0.02 and pg.intersects(fplan)), key=lambda x: -x[0])
    for z, pg in cands:
        if rem.is_empty or rem.area <= 1e-9: break
        inter = rem.intersection(pg)
        if inter.area > 1e-9:
            out.append((z0 - z, inter.area)); rem = rem.difference(pg)
    out.append((None, rem.area if not rem.is_empty else 0.0))
    return out

def exposed_above(fplan, z0, k_self):
    """The part of a top face (plan polygon) with nothing above it."""
    rem = fplan
    for (k2, z, pg) in S_DN:
        if k2 != k_self and z > z0 + 0.02 and pg.intersects(rem):
            rem = rem.difference(pg)
            if rem.is_empty: return rem
    return rem

# ---------------------------------------------------------------- building footprint (for outer faces)
plan_polys = []
for t in up_t:
    pts = [(float(p[HZ[0]]), float(p[HZ[1]])) for p in (a[t], b[t], c[t])]
    pg = Polygon(pts)
    if pg.area > 1e-8: plan_polys.append(pg.buffer(0))
footprint = unary_union(plan_polys).buffer(0.05).buffer(-0.05) if plan_polys else Polygon()

# ---------------------------------------------------------------- priority (who owns a shared face or volume)
ORDER = ['foundation', 'column', 'wall', 'framing', 'beam', 'floor', 'slab', 'roof', 'stair']
def prio_of(cat):
    cl = (cat or '').lower()
    for i, w in enumerate(ORDER):
        if w in cl: return i
    return len(ORDER)
PRIO = lambda k: (prio_of(cats.get(ids[k], '')), ids[k])

# ---------------------------------------------------------------- main pass
R = [dict(soffit=0.0, soffitBands=defaultdict(float), ground=0.0, slopeSoffit=0.0, side=0.0, sides=[], topSlope=0.0,
          top=0.0, topExposed=0.0, exposedPerim=0.0, covered=defaultdict(float)) for _ in rows]

for ts in clusters:
    t0 = ts[0]
    nv = cn[t0] / np.linalg.norm(cn[t0]); dv = float(np.mean(d[ts]))
    u, v = basis(nv)
    by = defaultdict(lambda: {1: [], -1: []})
    for t in ts:
        by[int(el[t])][int(sgn[t])].append(t)
    elems = list(by.keys())
    polys = {(k, s): poly2d(lst, u, v) for k in elems for s in (1, -1) if (lst := by[k][s])}
    claimed = {1: Polygon(), -1: Polygon()}       # same-direction faces of overlapping elements: one owner
    for (k, s), pg in sorted(polys.items(), key=lambda kv: PRIO(kv[0][0])):
        if pg.is_empty: continue
        opp = [(k2, p2) for (k2, s2), p2 in polys.items() if k2 != k and s2 == -s and not p2.is_empty]
        free = pg.difference(claimed[s]) if not claimed[s].is_empty else pg
        claimed[s] = unary_union([claimed[s], pg]) if not claimed[s].is_empty else pg
        for k2, p2 in opp:
            inter = free.intersection(p2)
            if inter.area > 1e-8:
                R[k]['covered'][cats.get(ids[k2], 'Other')] += inter.area
                free = free.difference(p2)
        if free.area <= 1e-8: continue
        # inside another box-like element (unjoined overlap)
        fb = free.bounds
        p3lo = np.minimum(to3d(np.array([[fb[0], fb[1]]]), u, v, nv, dv), to3d(np.array([[fb[2], fb[3]]]), u, v, nv, dv))[0]
        cands = np.flatnonzero(boxlike & np.all(lo <= np.maximum(to3d(np.array([[fb[0], fb[1]]]), u, v, nv, dv), to3d(np.array([[fb[2], fb[3]]]), u, v, nv, dv))[0] + TOL, axis=1)
                               & np.all(hi >= p3lo - TOL, axis=1))
        for k2 in cands:
            if k2 == k: continue
            sec = plane_box_poly(k2, nv, dv, u, v)
            if sec is None: continue
            inter = free.intersection(sec)
            if inter.area > 1e-8:
                R[k]['covered'][cats.get(ids[k2], 'Other')] += inter.area
                free = free.difference(sec)
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
            # outer: a point half a metre out from the face is outside the building footprint
            rp = g.representative_point(); p3 = to3d(np.array([[rp.x, rp.y]]), u, v, nv, dv)[0] + nv * s * 0.5
            outer = bool(not footprint.is_empty and not footprint.contains(shapely.Point(float(p3[HZ[0]]), float(p3[HZ[1]]))))
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

# ---------------------------------------------------------------- overlaps between box-like solids
overlaps = []
order = np.argsort(lo[:, 0])
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
