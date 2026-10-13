"""Checks py/pack.py: binary layout, exact quantities, orientation repair and up-axis detection."""
import base64, json, os, struct, subprocess, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def box(x0, y0, z0, dx, dy, dz, flip_one=False):
    """Closed box, outward normals, Y up. Returns base64 positions/indices (pack.py input is already in metres)."""
    p = [(x0, y0, z0), (x0 + dx, y0, z0), (x0 + dx, y0 + dy, z0), (x0, y0 + dy, z0),
         (x0, y0, z0 + dz), (x0 + dx, y0, z0 + dz), (x0 + dx, y0 + dy, z0 + dz), (x0, y0 + dy, z0 + dz)]
    f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (2, 3, 7), (2, 7, 6), (1, 2, 6), (1, 6, 5), (0, 4, 7), (0, 7, 3)]
    if flip_one:
        f[3] = (4, 7, 6)
    pts = [c for v in p for c in v]
    idx = [i for t in f for i in t]
    return base64.b64encode(struct.pack('<%df' % len(pts), *pts)).decode(), base64.b64encode(struct.pack('<%dI' % len(idx), *idx)).decode()

class PackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        d = tempfile.mkdtemp()
        meshes = []
        p, i = box(0, 0, 0, 2, 0.2, 3); meshes.append({'id': 10, 'p': p, 'i': i, 'c': 0})          # slab 2 x 3 x 0.2 (Y up)
        p, i = box(5, 0, 0, 0.3, 3, 0.3, flip_one=True); meshes.append({'id': 20, 'p': p, 'i': i, 'c': 0})  # column, one bad triangle
        p, i = box(9, 0, 0, 1, 1, 1); meshes.append({'id': None, 'p': p, 'i': i, 'c': 0})       # unmapped geometry
        json.dump({'meshes': meshes, 'categories': {'10': 'Floors', '20': 'Structural Columns'}}, open(os.path.join(d, 'g.json'), 'w'))
        subprocess.run([sys.executable, '-I', os.path.join(ROOT, 'py', 'pack.py'), os.path.join(d, 'g.json'), os.path.join(d, 'g.bin'), os.path.join(d, 'm.json')], check=True, capture_output=True)
        cls.bin = open(os.path.join(d, 'g.bin'), 'rb').read()
        cls.m = json.load(open(os.path.join(d, 'm.json')))

    def test_binary_header_and_ranges(self):
        self.assertEqual(self.bin[:4], b'DWG2')
        hl = struct.unpack('<I', self.bin[4:8])[0]
        h = json.loads(self.bin[8:8 + hl])
        self.assertEqual(h['up'], 'y')
        self.assertEqual(h['nTris'], 36)
        self.assertEqual(len(self.bin), 8 + hl + h['nVerts'] * 12 + h['nTris'] * 12 + h['nEdges'] * 8)
        ids = [e[0] for e in h['elements']]
        self.assertEqual(ids, [-1, 10, 20])
        self.assertEqual(h['elements'][1][6], 12)          # a box has 12 sharp edges

    def test_exact_quantities(self):
        s = self.m['10']
        self.assertTrue(s['solid'])
        self.assertAlmostEqual(s['vol'], 1.2, places=5)
        self.assertAlmostEqual(s['bottom'], 6, places=5)
        self.assertAlmostEqual(s['top'], 6, places=5)
        self.assertAlmostEqual(s['side'], 2 * (2 * 0.2) + 2 * (3 * 0.2), places=5)
        self.assertAlmostEqual(s['plan'], 6, places=5)

    def test_orientation_is_repaired(self):
        c = self.m['20']
        self.assertTrue(c['oriented'])
        self.assertTrue(c['solid'])
        self.assertAlmostEqual(c['vol'], 0.27, places=5)

if __name__ == '__main__':
    unittest.main()
