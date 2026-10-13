"""Checks the generic element reader (py/elements.py) on the synthetic DWFx from tests/helpers.js."""
import json, os, subprocess, sys, tempfile, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ElementsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        src = os.path.join(cls.tmp, 'model.dwfx')
        subprocess.run(['node', '--input-type=module', '-e',
                        f"import {{ makeDwfx }} from './tests/helpers.js'; await makeDwfx({json.dumps(src)});"],
                       cwd=ROOT, check=True)
        out = os.path.join(cls.tmp, 'out.json')
        subprocess.run([sys.executable, '-I', os.path.join(ROOT, 'py', 'elements.py'), src, out], check=True)
        with open(out) as f:
            cls.data = json.load(f)
        cls.by = {e['id']: e for e in cls.data['elements']}

    def test_every_element_is_read_with_its_tree_position(self):
        self.assertEqual(len(self.data['elements']), 3)
        w = self.by[1001]
        self.assertEqual((w['cat'], w['fam'], w['type'], w['level']), ('Walls', 'Basic Wall', 'Generic - 200', 'Level 1'))

    def test_quantities_are_in_metres(self):
        q = self.by[1001]['q']
        self.assertEqual(q['Length'], [5.0, 'm'])          # 5000 mm
        self.assertEqual(q['Area'], [15.0, 'm2'])
        self.assertEqual(q['Volume'], [3.0, 'm3'])
        self.assertEqual(self.by[2001]['q']['Cut Length'], [4.0, 'm'])

    def test_level_falls_back_to_reference_level(self):
        self.assertEqual(self.by[2001]['level'], 'Level 2')


if __name__ == '__main__':
    unittest.main()
