#!/usr/bin/env python3
"""Pack the placed meshes from geometry.py into a compact binary 3D file and compute exact
quantities from the geometry of every element.

Usage: python3 -I pack.py <geometry.json> <out geometry.bin> <out metrics.json>

geometry.bin layout (little endian):
  4 bytes  b'DWG2'
  uint32   header length H
  H bytes  UTF-8 JSON header, padded with spaces to a multiple of 4:
           {version, origin:[x,y,z], bounds:[[..],[..]] (local), nVerts, nTris, nEdges,
            elements:[[id, vStart, vCount, tStart, tCount, eStart, eCount], ...]}
  float32  positions, nVerts*3, local metres (world = local + origin), up axis in header
  uint32   triangle vertex indices, nTris*3 (global)
  uint32   feature-edge vertex index pairs, nEdges*2 (global)
Elements are contiguous ranges, so the viewer can draw, hide or recolour one element by range.

metrics.json: {"<id>": {vol, closed, oriented, area, top, bottom, side, plan, bb:[minx,miny,minz,maxx,maxy,maxz]}}
  (areas m2, volume m3, bb in world metres). Volume is reliable when solid is true (every shell closed and consistently wound;
  oriented is the winding test alone)
  (consistent winding); closed is false when T-junctions or gaps leave open edges.
  top/bottom/side/plan are measured against the detected up axis (header 'up').
"""
import sys, json, base64
import numpy as np

SRC, OUT_BIN, OUT_METRICS = sys.argv[1], sys.argv[2], sys.argv[3]
FEATURE_COS = np.cos(np.radians(30))     # edges sharper than 30 degrees are drawn
WELD = 1e-4                              # 0.1 mm: vertices closer than this are the same point

g = json.load(open(SRC))
meshes = g.get('meshes') or []
by_el = {}
for m in meshes:
    eid = m['id'] if m['id'] is not None else -1
    by_el.setdefault(eid, []).append(m)

P_parts, T_parts, shell_of_tri, el_rows = [], [], [], []
v_off = t_off = 0
shell = 0
shell_el = []
for k, eid in enumerate(sorted(by_el)):
    v0, t0 = v_off, t_off
    for m in by_el[eid]:
        p = np.frombuffer(base64.b64decode(m['p']), dtype='<f4').astype(np.float64).reshape(-1, 3)
        i = np.frombuffer(base64.b64decode(m['i']), dtype='<u4').astype(np.int64).reshape(-1, 3)
        if not len(p) or not len(i):
            continue
        i = i[(i < len(p)).all(axis=1)]
        P_parts.append(p); T_parts.append(i + v_off)
        shell_of_tri.append(np.full(len(i), shell)); shell_el.append(k); shell += 1
        v_off += len(p); t_off += len(i)
    el_rows.append([eid, v0, v_off - v0, t0, t_off - t0])

if not P_parts:
    open(OUT_BIN, 'wb').write(b'DWG2' + (2).to_bytes(4, 'little') + b'{}')
    json.dump({}, open(OUT_METRICS, 'w'))
    print('no geometry'); sys.exit(0)

P = np.concatenate(P_parts); T = np.concatenate(T_parts); SH = np.concatenate(shell_of_tri)
shell_el = np.array(shell_el)
EL_OF_TRI = shell_el[SH]
n_el = len(el_rows)
el_of_vert = np.zeros(len(P), dtype=np.int64)
for k, (_, vs, vc, _, _) in enumerate(el_rows):
    el_of_vert[vs:vs + vc] = k

# ---------------------------------------------------------------- up axis
# Revit DWFx is usually Y-up after export, but detect it: floors are thinnest along "up",
# columns longest along it.
cats = {int(k): v for k, v in (g.get('categories') or {}).items()}
lo0 = np.full((n_el, 3), np.inf); hi0 = np.full((n_el, 3), -np.inf)
np.minimum.at(lo0, el_of_vert, P); np.maximum.at(hi0, el_of_vert, P)
ext = hi0 - lo0
floors = [k for k, r in enumerate(el_rows) if 'floor' in cats.get(r[0], '').lower() or 'slab' in cats.get(r[0], '').lower()]
cols = [k for k, r in enumerate(el_rows) if 'column' in cats.get(r[0], '').lower()]
if floors:
    UP = int(np.argmin(np.median(ext[floors], axis=0)))
elif cols:
    UP = int(np.argmax(np.median(ext[cols], axis=0)))
else:
    UP = 1
H = [i for i in range(3) if i != UP]

# ---------------------------------------------------------------- weld vertices (per element)
q = np.round(P / WELD).astype(np.int64)
key = np.column_stack([q, el_of_vert])
_, first, wid = np.unique(key, axis=0, return_index=True, return_inverse=True)
wid = wid.reshape(-1)

def edge_table(TT):
    WT = wid[TT]
    E = np.concatenate([WT[:, [0, 1]], WT[:, [1, 2]], WT[:, [2, 0]]])
    F = np.tile(np.arange(len(TT)), 3)
    fwd = E[:, 0] < E[:, 1]
    E = np.sort(E, axis=1)
    keep = E[:, 0] != E[:, 1]
    E, F, fwd = E[keep], F[keep], fwd[keep]
    nw = int(wid.max()) + 1
    ek = E[:, 0] * nw + E[:, 1]
    order = np.argsort(ek, kind='stable')
    ek, E, F, fwd = ek[order], E[order], F[order], fwd[order]
    starts = np.flatnonzero(np.r_[True, ek[1:] != ek[:-1]])
    counts = np.diff(np.r_[starts, len(ek)])
    return E, F, fwd, starts, counts

# ---------------------------------------------------------------- orientation repair
# Volume needs every shell's triangles wound the same way. Elements where a shared edge is
# walked the same direction by both triangles are repaired by flood-filling the winding.
E, F, fwd, starts, counts = edge_table(T)
two = counts == 2
s2 = starts[two]
bad = fwd[s2] == fwd[s2 + 1]
bad_el = np.unique(EL_OF_TRI[F[s2[bad]]])
if len(bad_el):
    from collections import deque
    adj = {}
    for a_, b_, same in zip(F[s2], F[s2 + 1], fwd[s2] == fwd[s2 + 1]):
        adj.setdefault(a_, []).append((b_, same)); adj.setdefault(b_, []).append((a_, same))
    badset = set(bad_el.tolist())
    flip = np.zeros(len(T), dtype=bool); seen = np.zeros(len(T), dtype=bool)
    for t0 in np.flatnonzero(np.isin(EL_OF_TRI, bad_el)):
        if seen[t0]: continue
        seen[t0] = True; dq = deque([t0])
        while dq:
            t = dq.popleft()
            for u, same in adj.get(t, ()):
                if not seen[u]:
                    seen[u] = True; flip[u] = flip[t] ^ same; dq.append(u)
    T[flip] = T[flip][:, [0, 2, 1]]
    E, F, fwd, starts, counts = edge_table(T)
    two = counts == 2; s2 = starts[two]
still_bad = np.bincount(EL_OF_TRI[F[s2[fwd[s2] == fwd[s2 + 1]]]], minlength=n_el)

# ---------------------------------------------------------------- per-triangle geometry
a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
cr = np.cross(b - a, c - a)
nrm = np.linalg.norm(cr, axis=1)
area = nrm / 2
with np.errstate(invalid='ignore', divide='ignore'):
    nz = np.where(nrm > 0, cr[:, UP] / nrm, 0)
# tetra volume to the element's own centre (keeps precision); a closed surface gives the same
# volume about any point, which is tested below with the shell's vector area.
cen = np.zeros((n_el, 3))
np.add.at(cen, el_of_vert, P); cen /= np.maximum(np.bincount(el_of_vert, minlength=n_el), 1)[:, None]
signed = np.einsum('ij,ij->i', a - cen[EL_OF_TRI], cr) / 6

def per_el(w, mask=None):
    w = w if mask is None else np.where(mask, w, 0)
    return np.bincount(EL_OF_TRI, weights=w, minlength=n_el)

vol_shell = np.abs(np.bincount(SH, weights=signed, minlength=shell))
vol = np.bincount(shell_el, weights=vol_shell, minlength=n_el)
# geometrically closed shell: its vector area (sum of face normals x area) is ~zero
va = np.stack([np.bincount(SH, weights=cr[:, j], minlength=shell) for j in range(3)], axis=1)
sa = np.bincount(SH, weights=nrm, minlength=shell)
shell_closed = np.linalg.norm(va, axis=1) <= 1e-3 * np.maximum(sa, 1e-12)
solid = np.bincount(shell_el, weights=(~shell_closed).astype(float), minlength=n_el) == 0
tot = per_el(area)
top = per_el(area, nz > 0.7)
bottom = per_el(area, nz < -0.7)
side = per_el(area, np.abs(nz) < 0.3)
plan = per_el(np.maximum(cr[:, UP], 0) / 2)

# ---------------------------------------------------------------- feature edges
unit = np.divide(cr, np.where(nrm > 0, nrm, 1)[:, None])
feat = counts != 2
two = counts == 2
s2 = starts[two]
dots = np.einsum('ij,ij->i', unit[F[s2]], unit[F[s2 + 1]])
feat_two = np.zeros(len(starts), dtype=bool); feat_two[np.flatnonzero(two)] = dots < FEATURE_COS
edge_sel = starts[feat | feat_two]
rep = first                                          # welded id -> one original vertex
EDGES = rep[E[edge_sel]]
EDGE_EL = el_of_vert[EDGES[:, 0]]
# a closed (watertight) element has every welded edge used exactly twice
open_edges = np.bincount(el_of_vert[rep[E[starts[counts != 2], 0]]], minlength=n_el)
eo = np.argsort(EDGE_EL, kind='stable'); EDGES, EDGE_EL = EDGES[eo], EDGE_EL[eo]
e_start = np.searchsorted(EDGE_EL, np.arange(n_el), 'left')
e_end = np.searchsorted(EDGE_EL, np.arange(n_el), 'right')

# ---------------------------------------------------------------- bounding boxes
lo = np.full((n_el, 3), np.inf); hi = np.full((n_el, 3), -np.inf)
np.minimum.at(lo, el_of_vert, P); np.maximum.at(hi, el_of_vert, P)

origin = np.floor(P.min(axis=0))
L = (P - origin).astype('<f4')
header = dict(version=2, origin=origin.tolist(), up='xyz'[UP],
              bounds=[(P.min(axis=0) - origin).tolist(), (P.max(axis=0) - origin).tolist()],
              nVerts=len(P), nTris=len(T), nEdges=len(EDGES),
              elements=[[r[0], r[1], r[2], r[3], r[4], int(e_start[k]), int(e_end[k] - e_start[k])] for k, r in enumerate(el_rows)])
hb = json.dumps(header, separators=(',', ':')).encode()
hb += b' ' * ((4 - len(hb) % 4) % 4)
with open(OUT_BIN, 'wb') as f:
    f.write(b'DWG2'); f.write(len(hb).to_bytes(4, 'little')); f.write(hb)
    f.write(L.tobytes()); f.write(T.astype('<u4').tobytes()); f.write(EDGES.astype('<u4').tobytes())

r6 = lambda v: round(float(v), 6)
metrics = {}
for k, r in enumerate(el_rows):
    if r[0] == -1:
        continue
    metrics[str(r[0])] = dict(vol=r6(vol[k]), solid=bool(solid[k] and still_bad[k] == 0), closed=bool(open_edges[k] == 0), oriented=bool(still_bad[k] == 0),
                              area=r6(tot[k]), top=r6(top[k]),
                              bottom=r6(bottom[k]), side=r6(side[k]), plan=r6(plan[k]),
                              bb=[r6(x) for x in (*lo[k], *hi[k])])
json.dump(metrics, open(OUT_METRICS, 'w'))
print('packed', len(P), 'vertices', len(T), 'triangles', len(EDGES), 'edges', n_el, 'elements')
