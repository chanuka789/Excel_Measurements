"""Checks py/sheets.py on a small XPS FixedPage like those inside DWFx 2D sheets."""
import os, subprocess, sys, tempfile, unittest, zipfile, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = '''<FixedPage xmlns="http://schemas.microsoft.com/xps/2005/06" Width="1122" Height="793">
  <Canvas RenderTransform="1,0,0,1,10,20">
    <Path Data="F1 M 0,0 L 100,0 100,50 0,50 Z" Fill="#FFEEEEEE" Stroke="#FF000000" StrokeThickness="0.5"/>
    <Path Stroke="#80FF0000" StrokeThickness="2"><Path.Data><PathGeometry Figures="M 10,10 L 90,40"/></Path.Data></Path>
    <Glyphs UnicodeString="A-101 PLAN &amp; SECTION" OriginX="5" OriginY="70" FontRenderingEmSize="12" Fill="#FF000000"/>
  </Canvas>
</FixedPage>'''

class SheetsTest(unittest.TestCase):
    def test_fixed_page_to_svg(self):
        d = tempfile.mkdtemp()
        src = os.path.join(d, 'm.dwfx')
        with zipfile.ZipFile(src, 'w') as z:
            z.writestr('dwf/documents/x/sections/s1/Sheet A-101.fpage', PAGE)
        subprocess.run([sys.executable, '-I', os.path.join(ROOT, 'py', 'sheets.py'), src, os.path.join(d, 'out')], check=True, capture_output=True)
        sheets = json.load(open(os.path.join(d, 'out', 'sheets.json')))
        self.assertEqual(sheets[0]['name'], 'Sheet A-101')
        svg = open(os.path.join(d, 'out', 'sheet-1.svg')).read()
        self.assertIn('viewBox="0 0 1122 793"', svg)
        self.assertIn('transform="matrix(1,0,0,1,10,20)"', svg)
        self.assertIn('d="M 0,0 L 100,0 100,50 0,50 Z" fill="#EEEEEE"', svg)
        self.assertIn('stroke-opacity="0.502"', svg)
        self.assertIn('A-101 PLAN &amp; SECTION</text>', svg)

if __name__ == '__main__':
    unittest.main()
