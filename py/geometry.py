#!/usr/bin/env python3
"""Place decoded W3D meshes in the model and link each one to its Revit element ID.

Usage: python3 -I geometry.py <model.dwfx> <meshes.json> <out_geometry.json>

The open-source decoder returns shells in stream order only. This script reads the HSF
segment structure to (1) find which model node each shell belongs to, (2) resolve that node
to a Revit element through the DWFx Instance / Object XML, and (3) place shells that are
defined once in "Include Library" segments and re-used with a modelling matrix.
"""
import sys, re, zlib, json, struct, bisect, base64, zipfile, collections
import xml.etree.ElementTree as ET

SRC, MESHES, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
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

M = json.load(open(MESHES))['meshes']
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

def f32(b64): return struct.unpack('<%df' % (len(base64.b64decode(b64)) // 4), base64.b64decode(b64))

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
out, lo, hi = [], [1e18] * 3, [-1e18] * 3
for eid, k, mat in placed:
    P = list(f32(M[k]['p']))
    pts = []
    for j in range(0, len(P), 3):
        x, y, zc = P[j], P[j + 1], P[j + 2]
        if mat:
            a = mat
            x, y, zc = (x * a[0] + y * a[3] + zc * a[6] + a[9], x * a[1] + y * a[4] + zc * a[7] + a[10], x * a[2] + y * a[5] + zc * a[8] + a[11])
        x, y, zc = x * FT, y * FT, zc * FT
        pts += [x, y, zc]
        for c, v in enumerate((x, y, zc)):
            lo[c] = min(lo[c], v); hi[c] = max(hi[c], v)
    out.append(dict(id=eid, p=base64.b64encode(struct.pack('<%df' % len(pts), *pts)).decode(), i=M[k]['i'], c=M[k]['c']))

json.dump(dict(meshes=out, bounds=[lo, hi], labels={str(k): v for k, v in idlabel.items()},
               categories={str(k): v for k, v in cat_of.items()}), open(OUT, 'w'))
ids = {e for e, _, _ in placed if e}
print('placed meshes', len(out), 'elements with geometry', len(ids))
