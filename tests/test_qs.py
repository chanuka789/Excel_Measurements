"""Hand-calculated test models for py/qs.py (formwork faces, contact, propping height, ground, roof, overlaps).
Every expected value below is worked out by hand from the box sizes (Y is up; plan axes are X and Z)."""
import json, os, subprocess, sys, tempfile, unittest
from test_pack import box, ROOT

def run(elements, cats):
    d = tempfile.mkdtemp()
    meshes = []
    for eid, (x, y, z, dx, dy, dz) in elements.items():
        p, i = box(x, y, z, dx, dy, dz); meshes.append({'id': eid, 'p': p, 'i': i, 'c': 0})
    json.dump({'meshes': meshes, 'categories': {str(k): v for k, v in cats.items()}}, open(os.path.join(d, 'g.json'), 'w'))
    py = lambda *a: subprocess.run([sys.executable, '-I', *a], check=True, capture_output=True)
    py(os.path.join(ROOT, 'py', 'pack.py'), os.path.join(d, 'g.json'), os.path.join(d, 'g.bin'), os.path.join(d, 'm.json'))
    py(os.path.join(ROOT, 'py', 'qs.py'), os.path.join(d, 'g.bin'), os.path.join(d, 'g.json'), os.path.join(d, 'q.json'))
    return json.load(open(os.path.join(d, 'q.json')))

class QsTest(unittest.TestCase):
    def near(self, a, b, tol=0.002):
        self.assertAlmostEqual(a, b, delta=max(tol, abs(b) * 0.001))

    def test_raised_slab_alone(self):
        q = run({1: (0, 3.0, 0, 6, 0.2, 8)}, {1: 'Floors'})['elements']['1']
        self.near(q['ground'], 48)            # nothing below: on ground
        self.near(q['soffit'], 0)
        self.near(q['side'], 2 * (6 + 8) * 0.2)
        self.near(q['topExposed'], 48)
        self.near(q['exposedPerim'], 28)
        self.assertTrue(all(s[4] for s in q['sides']))        # 200 mm edges are narrow
        self.near(sum(s[5] for s in q['sides']), 2 * (6 + 8))  # edge length 28 m

    def test_suspended_slab_over_ground_slab_propping(self):
        r = run({1: (0, 3.0, 0, 6, 0.2, 8), 2: (-1, -0.2, -1, 8, 0.2, 10)}, {1: 'Floors', 2: 'Floors'})['elements']
        self.near(r['1']['soffit'], 48); self.near(r['1']['soffitBands']['0-3'], 48)   # 3.0 m clear: first band
        self.near(r['2']['ground'], 80)
        self.near(r['2']['topExposed'], 80 - 48)                                     # part of the ground slab is under the slab

    def test_beam_under_slab(self):
        # slab 6 x 8 x 0.2 at 3.0-3.2; beam 300 wide x 500 deep below it (2.5-3.0), 6 m long; ground slab at 0
        r = run({1: (0, 3.0, 0, 6, 0.2, 8), 2: (0, 2.5, 3.85, 6, 0.5, 0.3), 3: (-1, -0.2, -1, 8, 0.2, 10)},
                {1: 'Floors', 2: 'Structural Framing', 3: 'Floors'})['elements']
        s, b = r['1'], r['2']
        self.near(s['soffit'], 48 - 6 * 0.3)                 # slab soffit less the beam bearing
        self.near(b['covered']['Floors'], 6 * 0.3)           # beam top touches the slab
        self.near(b['soffit'], 6 * 0.3); self.near(b['soffitBands']['0-3'], 1.8)   # 2.5 m propping
        self.near(b['side'], 2 * 6 * 0.5 + 2 * 0.3 * 0.5)    # two sides + two ends
        self.near(s['soffitBands']['0-3'], 46.2)

    def test_unjoined_beam_overlapping_slab(self):
        # the same beam modelled 700 deep through the slab (2.5-3.2): its sides inside the slab are not formwork
        q = run({1: (0, 3.0, 0, 6, 0.2, 8), 2: (0, 2.5, 3.85, 6, 0.7, 0.3), 3: (-1, -0.2, -1, 8, 0.2, 10)},
                {1: 'Floors', 2: 'Structural Framing', 3: 'Floors'})
        s, b = q['elements']['1'], q['elements']['2']
        self.near(b['side'], 2 * 6 * 0.5 + 2 * 0.3 * 0.7)    # sides below the slab only; full-height ends (flush with the slab edge)
        self.near(s['soffit'], 46.2)
        self.near(b['top'] + s['top'], 48)                   # the shared top is counted once
        self.near(s['side'], 2 * (6 + 8) * 0.2 - 2 * 0.3 * 0.2)   # the edge strips shared with the beam ends are the beam's
        ov = q['overlaps']
        self.assertEqual(len(ov), 1); self.near(ov[0][2], 6 * 0.3 * 0.2)

    def test_column_on_footing(self):
        r = run({1: (0, -0.5, 0, 1.5, 0.5, 1.5), 2: (0.55, 0, 0.55, 0.4, 3.0, 0.4)}, {1: 'Structural Foundations', 2: 'Structural Columns'})['elements']
        f, c = r['1'], r['2']
        self.near(f['ground'], 2.25)
        self.near(f['side'], 4 * 1.5 * 0.5)
        self.assertTrue(all(sd[4] for sd in f['sides']))     # 500 high: narrow, measured in m by NRM2
        self.near(f['top'], 2.25 - 0.16)                     # less the column bearing
        self.near(c['covered']['Structural Foundations'], 0.16)
        self.near(c['side'], 4 * 0.4 * 3.0)
        self.near(c['topExposed'], 0.16)

    def test_outer_faces_of_a_basement_wall(self):
        # basement: slab 10 x 10, one wall along the edge x = 0..0.3, 3 m high
        r = run({1: (0, -0.3, 0, 10, 0.3, 10), 2: (0, 0, 0, 0.3, 3.0, 10)}, {1: 'Floors', 2: 'Walls'})['elements']
        sides = r['2']['sides']
        outer = sum(sd[0] for sd in sides if sd[3]); inner = sum(sd[0] for sd in sides if not sd[3])
        self.near(outer, 10 * 3.0 + 2 * 0.3 * 3.0)           # the face at x = 0 and both wall ends look out of the building
        self.near(inner, 10 * 3.0)                           # the face towards the inside

if __name__ == '__main__':
    unittest.main()
