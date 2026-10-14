#!/usr/bin/env python3
"""Place decoded W3D meshes in the model and link each one to its Revit element ID.

Usage: python3 -I geometry.py <model.dwfx> <meshes.bin> <out_geometry.json> <out placed.bin>

meshes.bin / placed.bin: b'MSH1' | uint32 H | JSON header {meshes:[{s|id, nv, ni, c}]} | float32 xyz | uint32 indices
(see public/js/meshbin.js). geometry.json keeps the small data (bounds, labels, categories); the coordinates stay binary.

The open-source decoder returns shells in stream order only. This script reads the HSF
segment structure to (1) find which model node each shell belongs to, (2) resolve that node
to a Revit element through the DWFx Instance / Object XML, and (3) place shells that are
defined once in "Include Library" segments and re-used with a modelling matrix.
"""
import sys, re, zlib, json, struct, bisect, zipfile, collections
import numpy as np
import xml.etree.ElementTree as ET

SRC, MESHES, OUT, OUT_BIN = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
NS = '{DWF-Content:1.0}'
z = zipfile.ZipFile(SRC)
names = z.namelist()

# --- inflate the W3D stream (HSF banner, 'Z' start-compression opcode, zlib payload)
w3d = next(n for n in names if n.lower().endswith('.w3d'))
data = z.read(w3d)
zi = data.find(b'Zx')
raw = zlib.decompressobj().decompress(data[zi + 1:])

# --- instances: node number -> renderable object id
inst = {}
for n in names:
    if n.endswith('.xml') and '/sections/' in n:
        txt = z.read(n).decode('utf-8', 'ignore')
        if '<dwf:Instances' in txt:
            for oid, node in re.findall(r'<dwf:Instance [^>]*renderableRef="([^"]+)" node="(\d+)"', txt):
                inst[int(node)] = oid

# --- object tree: object id -> nearest element (label "... [12345]")
obj2id, idlabel, cat_of = {}, {}, {}
for n in names:
    if not n.endswith('.content.xml'): continue
    root = ET.fromstring(z.read(n))
    objs = root.find(NS + 'Objects')
    if objs is None: continue
    def walk(o, cur, cat):
        lab = o.get('label') or ''
        m = re.search(r'\[(\d+)\]$', lab)
        if m:
            cur = int(m.group(1)); idlabel[cur] = re.sub(r'\s*\[\d+\]$', '', lab); cat_of[cur] = cat
        obj2id[o.get('id')] = cur
        for c in o.findall(NS + 'Object'): walk(c, cur, cat)
    for o in objs.findall(NS + 'Object'):
        walk(o, None, re.sub(r'\s*\(\d+\)$', '', o.get('label') or ''))

def read_msh(path):
    raw = open(path, 'rb').read()
    assert raw[:4] == b'MSH1', 'not a mesh file'
    hl = int.from_bytes(raw[4:8], 'little'); head = json.loads(raw[8:8 + hl]); off = 8 + hl
    ms = head['meshes']; nP = sum(m['nv'] for m in ms) * 3; nI = sum(m['ni'] for m in ms)
    P = np.frombuffer(raw, '<f4', nP, off); I = np.frombuffer(raw, '<u4', nI, off + nP * 4)
    po = io = 0
    for m in ms:
        m['P'] = P[po:po + m['nv'] * 3]; m['I'] = I[io:io + m['ni']]; po += m['nv'] * 3; io += m['ni']
    return ms
M = read_msh(MESHES)
nodes = [(m.start(), int(m.group(2))) for m in re.finditer(rb'\((.)(\d+)qU\x04\x00node', raw)]
npos = [p for p, _ in nodes]
libs = [(m.start(), m.group(2).decode()) for m in re.finditer(rb'\((.)(\?Include Library/\d+)q', raw)]
lpos = [p for p, _ in libs]

def node_at(p):
    i = bisect.bisect_left(npos, p) - 1
    return nodes[i][1] if i >= 0 else None

def elem_of(n):
    while n is not None and n >= 0:
        if n in inst: return obj2id.get(inst[n])
        n -= 1
    return None

placed, libmesh = [], collections.defaultdict(list)
for k, m in enumerate(M):
    n = node_at(m['s'])
    if n is None:
        i = bisect.bisect_left(lpos, m['s']) - 1
        if i >= 0: libmesh[libs[i][1]].append(k)
        continue
    placed.append((elem_of(n), k, None))
for mm in re.finditer(rb'<(.)(\?Include Library/\d+)', raw):
    p = mm.start()
    mat = struct.unpack('<12f', raw[p - 48:p]) if raw[p - 49:p - 48] == b'%' else None
    eid = elem_of(node_at(p))
    for k in libmesh[mm.group(2).decode()]: placed.append((eid, k, mat))

FT = 0.3048  # W3D coordinates are in feet -> metres
heads, parts_p, parts_i = [], [], []
lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
for eid, k, mat in placed:
    P = M[k]['P'].reshape(-1, 3).astype(np.float64)
    if mat:
        A = np.array(mat[:9]).reshape(3, 3); t = np.array(mat[9:12])
        P = P @ A + t                                    # row vector x 3x3 modelling matrix + translation
    P = P * FT
    if len(P):
        lo = np.minimum(lo, P.min(axis=0)); hi = np.maximum(hi, P.max(axis=0))
    heads.append(dict(id=eid, nv=len(P), ni=int(M[k]['ni']), c=M[k]['c']))
    parts_p.append(P.astype('<f4').ravel()); parts_i.append(M[k]['I'])
if not np.isfinite(lo).all(): lo, hi = np.full(3, 1e18), np.full(3, -1e18)
hb = json.dumps(dict(meshes=heads), separators=(',', ':')).encode()
hb += b' ' * ((4 - len(hb) % 4) % 4)
with open(OUT_BIN, 'wb') as f:
    f.write(b'MSH1'); f.write(len(hb).to_bytes(4, 'little')); f.write(hb)
    for p in parts_p: f.write(p.tobytes())
    for i in parts_i: f.write(np.asarray(i, dtype='<u4').tobytes())
json.dump(dict(bounds=[lo.tolist(), hi.tolist()], labels={str(k): v for k, v in idlabel.items()},
               categories={str(k): v for k, v in cat_of.items()}), open(OUT, 'w'))
ids = {e for e, _, _ in placed if e}
print('placed meshes', len(heads), 'elements with geometry', len(ids))
