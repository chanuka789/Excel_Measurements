#!/usr/bin/env python3
"""DFWX_Structurel - build a structural concrete Measurement sheet + linked BOQ from a Revit DWFx export.

Usage:  python3 -I dwfx_structural.py <model.dwfx> <output.xlsx>
Then recalculate the workbook (LibreOffice) so formula values are cached.
"""
import sys, os, re, zipfile, collections
import xml.etree.ElementTree as ET
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.comments import Comment

SRC, OUT = sys.argv[1], sys.argv[2]
ELEM_JSON = sys.argv[3] if len(sys.argv) > 3 else None
SRCNAME = re.sub(r'^[0-9a-f]{8}-', '', os.path.basename(SRC))

# ============================================================== 1. READ DWFx
def num(s):
    if s is None: return None
    m = re.search(r'-?\d+(?:\.\d+)?', str(s))
    return float(m.group()) if m else None

def vol_m3(s):
    v = num(s)
    if v is None: return 0.0
    return v * 0.0283168 if 'ft' in str(s) else v

clean = lambda s: re.sub(r'\s*\(\d+\)$', '', s or '').strip()
D = '{DWF-Content:1.0}'
rows = []
z = zipfile.ZipFile(SRC)
creator = ''
for n in z.namelist():
    if n.endswith('descriptor.xml'):
        m = re.search(rb'name="Creator" value="([^"]+)"', z.read(n))
        if m: creator = m.group(1).decode(errors='ignore')
    if not n.endswith('.content.xml'): continue
    root = ET.fromstring(z.read(n))
    objs = root.find(D + 'Objects')
    if objs is None: continue
    def walk(o, path, inh):
        p = path + [o.get('label') or '']
        props = {x.get('name'): x.get('value') for x in o.findall(D + 'Property')}
        merged = dict(inh); merged.update(props)
        if 'Guid' in props or 'IfcGUID' in props:
            rows.append(dict(path=p, props=props, type_props=dict(inh)))
        for c in o.findall(D + 'Object'): walk(c, p, merged)
    for o in objs.findall(D + 'Object'): walk(o, [], {})
if not rows:
    sys.exit('ERROR: no element properties found in this DWFx (geometry-only export). Ask for a DWFx published from Revit with properties.')

CATS = ('Structural Framing', 'Walls', 'Structural Foundations', 'Structural Columns', 'Floors')
def is_steel(mat): return bool(re.search(r'steel|metal', str(mat or ''), re.I))

# ============================================================== 2. LEVELS
lev = {}
for x in rows:
    p = x['props']
    if p.get('Reference Level') and p.get('Reference Level Elevation') is not None:
        lev.setdefault(p['Reference Level'], num(p['Reference Level Elevation']))
for x in rows:
    p = x['props']
    if x['path'][0].startswith('Floors') and p.get('Level') and p.get('Elevation at Top') and p.get('Height Offset From Level') is not None:
        lev.setdefault(p['Level'], num(p['Elevation at Top']) - num(p['Height Offset From Level']))
slab_levels = {x['props'].get('Level') for x in rows if x['path'][0].startswith('Floors') and x['props'].get('Level')}
allnames = slab_levels | set(lev) | {x['props'].get(k) for x in rows for k in ('Base Level', 'Base Constraint') if x['props'].get(k)}
allnames.discard(None)
def elev(n): return lev.get(n, 1e9 if 'ROOF' in n.upper() else 0)
GROUND = next((n for n in allnames if 'GROUND' in n.upper()), None) or min(slab_levels or allnames, key=elev)
roofc = [n for n in slab_levels if 'ROOF' in n.upper()]
ROOF = roofc[0] if roofc else max(slab_levels - {GROUND} or {GROUND}, key=elev)
LORD = {'FOUNDATION': -1e9}
for n in allnames: LORD[n] = elev(n)
def slab_group(lvl):
    if lvl == GROUND: return 'GS'
    if elev(lvl) >= elev(ROOF): return 'RS'
    return 'FS'

# ============================================================== 3. ELEMENTS
GRADES = {'12': 'C12/15', '16': 'C16/20', '20': 'C20/25', '25': 'C25/30', '28': 'C28/35', '30': 'C30/37',
          '32': 'C32/40', '35': 'C35/45', '40': 'C40/50', '45': 'C45/55', '50': 'C50/60'}
def grade_of(mat):
    if not mat: return ''
    m = re.search(r'(\d+) ?MPa', mat)
    return GRADES.get(m.group(1), m.group(1) + ' MPa') if m else mat

slab_thk = set()
for x in rows:
    if x['path'][0].startswith('Floors') and 'Precast' not in str(x['type_props'].get('Structural Material')):
        m = re.search(r'-(\d+)\s*$', clean(x['path'][2] if len(x['path']) > 2 else ''))
        if m and int(m.group(1)) <= 300: slab_thk.add(int(m.group(1)) / 1000)
SNAPS = sorted({0.0} | slab_thk | {.15, .18, .2, .225, .25})
def snap(v):
    n = min(SNAPS, key=lambda s: abs(s - v))
    return (n, '') if abs(n - v) <= 0.04 else (round(max(v, 0), 2), 'Deduct derived from model - check')

def two_dims(t):
    m = re.search(r'(\d{2,4})\s*[xX]\s*(\d{2,4})', t)
    return (int(m[1]) / 1000, int(m[2]) / 1000) if m else None

E = []
for x in rows:
    cat, p, t = x['path'][0], x['props'], x['type_props']
    if not cat.startswith(CATS) or len(x['path']) < 3: continue
    typ = clean(x['path'][2]); fam = clean(x['path'][1])
    mat = p.get('Structural Material') or t.get('Structural Material')
    if is_steel(mat): continue
    O = vol_m3(p.get('Volume'))
    d = dict(mat=mat, id=int(num(p.get('Id')) or 0), desc=typ, mark='', lvl='', grade=grade_of(mat), no=1, L=None, W=None,
             D=None, K=None, M=None, O=O, note='', rebar='')
    tc = (t.get('Type Comments') or '').upper()
    if cat.startswith('Structural Foundations'):
        dims3 = re.findall(r'(\d{3,4})\s*[xX]\s*(\d{3,4})\s*[xX]\s*(\d{3,4})', typ)
        if 'FILL' in typ.upper():
            m = re.search(r'(\d+)\s*THK', typ.upper())
            d.update(sec='PC', code='PCF', kind='MODEL', rebar='PCF', lvl='FOUNDATION', D=int(m.group(1)) / 1000 if m else None,
                     note='Concrete fill over pile cap; model volume used')
        elif 'PILE CAP' in tc or 'Pile Cap' in fam or dims3:
            bw = bool(re.search(r'(^|[-_ ])BW[-_]', typ))
            L = num(p.get('Length')) / 1000 if p.get('Length') else (int(dims3[0][0]) / 1000 if dims3 else None)
            W = num(p.get('Width')) / 1000 if p.get('Width') else (int(dims3[0][1]) / 1000 if dims3 else None)
            Dp = int(dims3[0][2]) / 1000 if dims3 else None
            if None in (L, W, Dp):
                d.update(sec='PC', code='PC-BW' if bw else 'PC', kind='MODEL', rebar='PC', lvl='FOUNDATION',
                         note='Dimensions not found: model volume used, no formwork - check')
            else:
                d.update(sec='PC', code='PC-BW' if bw else 'PC', kind='PC', rebar='PC', lvl='FOUNDATION',
                         mark=t.get('Type Mark') or '', L=L, W=W, D=Dp)
            if d['grade'] and d['grade'] != 'C40/50':
                d['note'] = (d['note'] + '; ' if d['note'] else '') + 'Material in model = %s: check grade against specification' % (re.search(r'\d+ ?MPa', mat).group() if re.search(r'\d+ ?MPa', str(mat)) else mat)
        elif 'PILE' in tc or re.search(r'\bPile\b', fam + typ, re.I):
            m = re.search(r'Dia\.?\s*(\d+)', typ, re.I)
            dia = int(m.group(1)) / 1000 if m else 0.5
            top, bot = num(p.get('Elevation at Top')), num(p.get('Elevation at Bottom'))
            ln = (top - bot) / 1000 if top is not None and bot is not None else 0
            d.update(sec='PILE', code='PILE', kind='PILE', lvl='FOUNDATION', mark=t.get('Type Mark') or '',
                     L=dia, W=dia, D=ln, grade='', note='For information only - piles normally measured in piling package')
            if not m: d['note'] += '; diameter assumed 500 mm'
        else:
            d.update(sec='PC', code='FDN', kind='MODEL', rebar='PC', lvl='FOUNDATION',
                     note='Other foundation type: model volume used, no formwork - check')
    elif cat.startswith('Structural Framing'):
        lvl = p.get('Reference Level') or p.get('Level') or ''
        if 'Corbel' in typ:
            d.update(sec='FR', code='CORB', kind='CORB', rebar='CORB', lvl=lvl, grade=d['grade'] or 'C40/50',
                     L=(num(p.get('Corbel Depth')) or 0) / 1000, W=(num(p.get('Corbel Width')) or 0) / 1000,
                     D=(num(p.get('Corbel Height')) or 0) / 1000,
                     note='Model volume used (chamfered shape); formwork approximate' + ('' if mat else '; grade assumed C40/50'))
        elif 'Equipment' in fam or 'Equipment Base' in str(p.get('Comments')):
            d.update(sec='RF', code='EQB', kind='EQB', rebar='EQB', lvl=lvl, grade=d['grade'] or 'C28/36',
                     L=(num(p.get('Length')) or 0) / 1000, W=(num(p.get('Width')) or 0) / 1000, D=(num(p.get('Height')) or 0) / 1000,
                     note='Hollow base: model volume used' + ('' if mat else '; grade assumed C28/36'))
        else:
            dims = two_dims(typ)
            L = num(p.get('Cut Length') or p.get('Length'))
            mark = p.get('Beam Reinf. Mark') or p.get('Mark') or ''
            gb = lvl == GROUND
            sec, code, rb = ('GB', 'GB-BW' if mark.upper().startswith('BW') else 'GB', 'GB') if gb else ('FR', 'BM', 'BM')
            if not dims or not L or 'Step' in fam:
                d.update(sec=sec, code=code, kind='BMX', rebar=rb, lvl=lvl, mark=mark, grade=d['grade'] or 'C40/50',
                         L=(L or 0) / 1000, W=dims[0] if dims else 0, D=num(re.search(r'x(\d+)', typ).group(1)) / 1000 if re.search(r'x(\d+)', typ) else 0, K=0,
                         note='Non-standard beam: model volume used, formwork approximate')
            else:
                b, h = dims; L = L / 1000
                k, n = snap(h - O / (L * b)) if O else (0, '')
                d.update(sec=sec, code=code, kind='GB' if gb else 'BM', rebar=rb, lvl=lvl, mark=mark, L=L, W=b, D=h, K=k,
                         note=n or ('Depth reduced by slab thickness (slab measured over beam)' if k else ''))
    elif cat.startswith('Structural Columns'):
        dims = two_dims(typ); H = (num(p.get('Length')) or 0) / 1000
        lvl = p.get('Base Level') or ''
        if not dims or not H:
            d.update(sec='FR', code='COL', kind='MODEL', rebar='COL', lvl=lvl, note='Column size not in type name: model volume used, no formwork - check')
        else:
            b, dd = dims
            k = round(H - O / (b * dd), 2) if O else 0
            k = 0 if k < 0.03 else k
            d.update(sec='FR', code='COL', kind='COL', rebar='COL', lvl=lvl, mark=p.get('Column Mark') or '',
                     L=b, W=dd, D=H, K=k, note='Deduct = overlap with beams/slabs (derived from model)' if k else '')
        if p.get('Remarks'): d['note'] = (p['Remarks'].title() + '. ' + d['note']).strip()
    elif cat.startswith('Walls'):
        w = (num(t.get('Width')) or 0) / 1000
        L = (num(p.get('Length')) or 0) / 1000
        H = (num(p.get('Unconnected Height')) or 0) / 1000
        if not H and L and w: H = round(O / (L * w), 3)
        lvl = p.get('Base Constraint') or ''
        if 'Precast' in typ or 'Precast' in str(mat):
            d.update(sec='PRE', code='PCW', kind='PCW', lvl=lvl, L=L, W=w, D=H, K=0, grade='Precast',
                     note='Precast panel: measured in m2 (one face)')
        elif 'Boundary Wall Base' in typ:
            d.update(sec='GB', code='BWB', kind='BWB', rebar='BWB', lvl=lvl, mark=t.get('Type Mark') or '',
                     L=L, W=w, D=H, K=0, note='Below ground: waterproofing both faces')
        else:
            th = int(round(w * 1000))
            code = ('UW-%d' if 'Upstand' in typ else 'W-%d') % th
            below = lvl == GROUND and (num(p.get('Base Offset')) or 0) < 0
            d.update(sec='FR', code=code, kind='UW', rebar='UW', lvl=lvl, L=L, W=w, D=H, K=0, wp=below,
                     note='At ground floor: waterproofing to one face (assumed)' if below else '')
    elif cat.startswith('Floors'):
        lvl = p.get('Level') or ''
        if re.search(r'STEP|Light ?weight', typ, re.I):
            d.update(sec='FL', code='STEP', kind='MODEL', rebar='STEP', lvl=lvl, grade='LWC C20/25',
                     note='Light weight concrete steps; model volume used')
        else:
            m = re.search(r'-(\d+)\s*$', typ)
            th = int(m.group(1)) if m else None
            if not th and num(p.get('Area')): th = int(round(O / num(p.get('Area')) * 1000 / 5) * 5)
            per = (num(p.get('Perimeter')) or 0) / 1000
            g = slab_group(lvl)
            if 'Precast' in str(mat):
                d.update(sec='PRE', code='PRES', kind='PRES', lvl=lvl, D=th / 1000, M=per, grade='Precast',
                         note='Precast slab (model material): measured in m2')
            else:
                d.update(sec=g, code='%s-%d' % (g, th), kind='GS' if g == 'GS' else 'SS', rebar=g, lvl=lvl, D=th / 1000, M=per,
                         note='Edge formwork uses full perimeter - includes internal joints, check')
    else:
        continue
    E.append(d)

# ============================================================== 4. STYLES / RATES
BLUE = '0A5082'
def F(**k): return Font(name='Arial', size=k.pop('size', 9), **k)
thin = Side(style='thin', color='BFBFBF')
BD = Border(left=thin, right=thin, top=thin, bottom=thin)
HFILL = PatternFill('solid', fgColor=BLUE); SFILL = PatternFill('solid', fgColor='D9E6F2')
TFILL = PatternFill('solid', fgColor='F2F2F2'); YFILL = PatternFill('solid', fgColor='FFF2CC')
INP = '0000FF'; LNK = '008000'

wb = Workbook()
R = wb.active; R.title = 'Rates'
R['A1'] = 'INPUTS & ASSUMPTIONS'; R['A1'].font = F(bold=True, size=13, color=BLUE)
R['A2'] = 'Yellow cells with blue text are inputs. Change them and the Measurement and BOQ sheets update.'
R['A2'].font = F(italic=True)
for i, h in enumerate(['Rebar code', 'Element', 'Rebar rate (kg/m3)', 'Source'], 1):
    c = R.cell(4, i, h); c.font = F(bold=True, color='FFFFFF'); c.fill = HFILL; c.border = BD
    c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
RB = [('PC', 'Pile caps', 120, 'Your BOQ'), ('PCF', 'Pile cap concrete fill', 0, 'Assumed plain fill - check'),
      ('GB', 'Ground beams', 180, 'Your BOQ'), ('BWB', 'Boundary wall base', 100, 'Assumed as walls - check'),
      ('GS', 'Ground slab (slab on grade)', 130, 'Your BOQ'), ('COL', 'Columns', 200, 'Your BOQ'),
      ('BM', 'Beams', 180, 'Your BOQ'), ('UW', 'Upstand walls / RC walls', 100, 'Your BOQ'),
      ('CORB', 'Corbels', 180, 'Your BOQ'), ('FS', 'Suspended slabs', 120, 'Your BOQ'),
      ('RS', 'Roof slabs', 120, 'Your BOQ'), ('EQB', 'MEP equipment bases', 110, 'Your BOQ'),
      ('STEP', 'Light weight concrete steps', 0, 'No rebar in LWC steps (your BOQ)')]
for i, (a, b, c, s) in enumerate(RB):
    r = 5 + i
    R.cell(r, 1, a); R.cell(r, 2, b); R.cell(r, 3, c); R.cell(r, 4, s)
    for j in range(1, 5): R.cell(r, j).border = BD; R.cell(r, j).font = F()
    R.cell(r, 3).font = F(color=INP); R.cell(r, 3).fill = YFILL
RLAST = 5 + len(RB) - 1
RROW = {a: 5 + i for i, (a, *_) in enumerate(RB)}
r = RLAST + 2
R.cell(r, 1, 'Other inputs').font = F(bold=True, size=10, color=BLUE)
R.cell(r + 1, 1, 'BLIND'); R.cell(r + 1, 2, 'Blinding thickness (m)'); R.cell(r + 1, 3, 0.05); R.cell(r + 1, 4, 'Your BOQ (50 mm)')
for j in range(1, 5): R.cell(r + 1, j).border = BD; R.cell(r + 1, j).font = F()
R.cell(r + 1, 3).font = F(color=INP); R.cell(r + 1, 3).fill = YFILL
BLIND_REF = 'Rates!$C$%d' % (r + 1)
for col, w in zip('ABCD', [12, 34, 18, 36]): R.column_dimensions[col].width = w

# ============================================================== 5. MEASUREMENT
M = wb.create_sheet('Measurement')
HDR = ['BOQ code', 'Revit ID', 'Element / type', 'Mark', 'Level', 'Concrete grade', 'No.',
       'Length (m)', 'Width (m)', 'Depth / height / thk (m)', 'Deduct depth (m)', 'Plan / section area (m2)',
       'Perimeter (m)', 'Volume (m3)', 'Model volume (m3)', 'Difference (m3)',
       'Formwork - sides & soffits (m2)', 'Formwork - slab edges (m2)', 'Rebar code', 'Rebar rate (kg/m3)',
       'Rebar (kg)', 'Blinding area (m2)', 'Blinding volume (m3)', 'Waterproofing (m2)', 'Other qty', 'Unit', 'Notes']
COL = {h: get_column_letter(i + 1) for i, h in enumerate(HDR)}
c_ = lambda h: COL[h]
M['A1'] = 'MEASUREMENT SHEET - STRUCTURAL CONCRETE'; M['A1'].font = F(bold=True, size=13, color=BLUE)
M['A2'] = ('Source: %s (%s export). One row per model element. '
           'Blue = taken from the model, yellow = assumption you can change, black = formula.') % (SRCNAME, (re.search(r'Revit \d{4}', creator).group() if re.search(r'Revit \d{4}', creator) else 'Revit'))
M['A2'].font = F(italic=True)
HR = 4
for i, h in enumerate(HDR, 1):
    c = M.cell(HR, i, h); c.font = F(bold=True, color='FFFFFF'); c.fill = HFILL; c.border = BD
    c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
M.row_dimensions[HR].height = 42
NUMCOLS = ['Volume (m3)', 'Model volume (m3)', 'Difference (m3)', 'Formwork - sides & soffits (m2)',
           'Formwork - slab edges (m2)', 'Rebar (kg)', 'Blinding area (m2)', 'Blinding volume (m3)', 'Waterproofing (m2)']
FIRST = HR + 1
TOK = '{LAST}'
def rng(h): return '$%s$%d:$%s$%s' % (c_(h), FIRST, c_(h), TOK)
FMT = {'Length (m)': '0.000', 'Width (m)': '0.000', 'Depth / height / thk (m)': '0.000', 'Deduct depth (m)': '0.000',
       'Plan / section area (m2)': '#,##0.00', 'Perimeter (m)': '#,##0.00', 'Volume (m3)': '#,##0.00',
       'Model volume (m3)': '#,##0.00', 'Difference (m3)': '#,##0.00;[Red]-#,##0.00;-',
       'Formwork - sides & soffits (m2)': '#,##0.00', 'Formwork - slab edges (m2)': '#,##0.00',
       'Rebar rate (kg/m3)': '0', 'Rebar (kg)': '#,##0.0', 'Blinding area (m2)': '#,##0.00',
       'Blinding volume (m3)': '#,##0.000', 'Waterproofing (m2)': '#,##0.00', 'Other qty': '#,##0.00'}

def formulas(d, r):
    G, H, I, J, K, L, Mp, N, O = [c_(h) + str(r) for h in ['No.', 'Length (m)', 'Width (m)', 'Depth / height / thk (m)',
                                  'Deduct depth (m)', 'Plan / section area (m2)', 'Perimeter (m)', 'Volume (m3)', 'Model volume (m3)']]
    k = d['kind']; f = {}
    if k in ('PC', 'GB', 'BM', 'COL', 'UW', 'BWB', 'CORB', 'EQB', 'BMX', 'PCW'): f['Plan / section area (m2)'] = '=%s*%s' % (H, I)
    if k in ('GS', 'SS', 'PRES'): f['Plan / section area (m2)'] = '=%s/%s' % (O, J)
    if k in ('PC', 'GB', 'BM', 'COL', 'UW', 'BWB'): f['Volume (m3)'] = '=%s*%s*(%s-%s)' % (G, L, J, K)
    elif k in ('GS', 'SS'): f['Volume (m3)'] = '=%s*%s*%s' % (G, L, J)
    elif k == 'PILE': f['Volume (m3)'] = '=%s*PI()/4*%s^2*%s' % (G, H, J)
    elif k in ('PCW', 'PRES'): f['Volume (m3)'] = None
    else: f['Volume (m3)'] = '=%s' % O
    if f['Volume (m3)']: f['Difference (m3)'] = '=%s-%s' % (N, O)
    fw = {'PC': '=%s*2*(%s+%s)*%s' % (G, H, I, J), 'GB': '=%s*2*%s*(%s-%s)' % (G, H, J, K),
          'BM': '=%s*%s*(%s+2*(%s-%s))' % (G, H, I, J, K), 'BMX': '=%s*%s*(%s+2*%s)' % (G, H, I, J),
          'COL': '=%s*2*(%s+%s)*(%s-%s)' % (G, H, I, J, K), 'UW': '=%s*2*%s*%s' % (G, H, J),
          'BWB': '=%s*2*%s*%s' % (G, H, J), 'SS': '=%s*%s' % (G, L), 'EQB': '=%s*2*(%s+%s)*%s' % (G, H, I, J),
          'CORB': '=%s*(%s*%s+2*%s*%s)' % (G, I, J, H, J)}
    if k == 'BMX' and d['sec'] == 'GB': fw['BMX'] = '=%s*2*%s*%s' % (G, H, J)
    if k in fw: f['Formwork - sides & soffits (m2)'] = fw[k]
    if k in ('GS', 'SS'): f['Formwork - slab edges (m2)'] = '=%s*%s*%s' % (G, Mp, J)
    if d.get('rebar'):
        f['Rebar rate (kg/m3)'] = '=IFERROR(INDEX(Rates!$C$5:$C$%d,MATCH(%s%d,Rates!$A$5:$A$%d,0)),0)' % (RLAST, c_('Rebar code'), r, RLAST)
        f['Rebar (kg)'] = '=%s*%s%d' % (N, c_('Rebar rate (kg/m3)'), r)
    if k in ('PC', 'GB', 'BWB', 'GS'): f['Blinding area (m2)'] = '=%s*%s' % (G, L)
    if 'Blinding area (m2)' in f: f['Blinding volume (m3)'] = '=%s%d*%s' % (c_('Blinding area (m2)'), r, BLIND_REF)
    wp = {'PC': '=%s*(%s+2*(%s+%s)*%s)' % (G, L, H, I, J), 'GB': '=%s*%s*(%s+2*(%s-%s))' % (G, H, I, J, K),
          'GS': '=%s*%s' % (G, L), 'BWB': '=%s*2*%s*%s' % (G, H, J)}
    if k in wp: f['Waterproofing (m2)'] = wp[k]
    if k == 'UW' and d.get('wp'): f['Waterproofing (m2)'] = '=%s*%s*%s' % (G, H, J)
    if k == 'PCW': f['Other qty'] = '=%s*%s*%s' % (G, H, J); f['Unit'] = 'm2'
    if k == 'PRES': f['Other qty'] = '=%s*%s' % (G, L); f['Unit'] = 'm2'
    if k == 'PILE': f['Other qty'] = '=%s*%s' % (G, J); f['Unit'] = 'm'
    return f

def put(r, h, v, font=None, fill=None, fmt=None):
    c = M.cell(r, HDR.index(h) + 1, v); c.font = font or F(); c.border = BD
    if fill: c.fill = fill
    if fmt: c.number_format = fmt
    return c
def fill_blanks(r):
    for h in HDR:
        if M.cell(r, HDR.index(h) + 1).value is None: put(r, h, None, fmt=FMT.get(h))

susp_levels = sorted({d['lvl'] for d in E if d['sec'] == 'FS'}, key=lambda n: LORD.get(n, 0))
roof_levels = sorted({d['lvl'] for d in E if d['sec'] == 'RS'}, key=lambda n: LORD.get(n, 0))
def sec_title(code, default):
    return default
SECTIONS = [('PC', 'FOUNDATIONS - PILE CAPS'), ('GB', 'FOUNDATIONS - GROUND BEAMS & BOUNDARY WALL BASE'),
            ('GS', 'FOUNDATIONS - GROUND FLOOR SLABS (SLAB ON GRADE)'),
            ('FR', 'CONCRETE FRAMES - COLUMNS, BEAMS, UPSTAND WALLS, CORBELS'),
            ('FL', 'FLOORS - LIGHT WEIGHT CONCRETE STEPS'),
            ('FS', 'FLOORS - ' + (' / '.join(susp_levels) if susp_levels else 'SUSPENDED') + ' SLABS'),
            ('RS', 'ROOF STRUCTURE - ROOF SLABS'), ('RF', 'ROOF STRUCTURE - EQUIPMENT BASES'),
            ('PRE', 'PRECAST ELEMENTS (FOR INFORMATION - CHECK SCOPE)'),
            ('PILE', 'PILES (FOR INFORMATION ONLY - NOT LINKED TO BOQ)')]
CORD = ['PC', 'PC-BW', 'FDN', 'PCF', 'GB', 'GB-BW', 'BWB', 'COL', 'BM']
def code_key(c):
    if c in CORD: return (CORD.index(c), 0)
    m = re.match(r'(UW|W)-(\d+)', c)
    if m: return (20 + (0 if m[1] == 'UW' else 1), int(m[2]))
    return (40, c)

r = FIRST
for sec, title in SECTIONS:
    items = [d for d in E if d['sec'] == sec]
    if not items: continue
    items.sort(key=lambda d: (code_key(d['code']), LORD.get(d['lvl'], 1e9), d['desc'], d['mark'], d['id']))
    for j in range(1, len(HDR) + 1): M.cell(r, j).fill = SFILL; M.cell(r, j).border = BD
    M.cell(r, 1, title).font = F(bold=True, size=10, color=BLUE)
    r += 1; start = r
    for d in items:
        f = formulas(d, r)
        put(r, 'BOQ code', d['code'], F(bold=True))
        put(r, 'Revit ID', d['id'], F(color=INP))
        put(r, 'Element / type', d['desc'], F(color=INP))
        put(r, 'Mark', d['mark'] or None, F(color=INP))
        put(r, 'Level', d['lvl'], F(color=INP))
        put(r, 'Concrete grade', d['grade'] or None, F(color=INP))
        put(r, 'No.', d['no'], F(color=INP), fmt='0')
        for h, key in [('Length (m)', 'L'), ('Width (m)', 'W'), ('Depth / height / thk (m)', 'D'), ('Perimeter (m)', 'M')]:
            put(r, h, d[key], F(color=INP), fmt=FMT[h])
        if d['K'] is not None: put(r, 'Deduct depth (m)', d['K'], F(color=INP), YFILL, FMT['Deduct depth (m)'])
        put(r, 'Model volume (m3)', d['O'], F(color=INP), fmt=FMT['Model volume (m3)'])
        put(r, 'Rebar code', d['rebar'] or None, F(color=INP))
        for h, v in f.items():
            if v is not None: put(r, h, v, fmt=FMT.get(h))
        put(r, 'Notes', d['note'].strip('; ') or None, F(italic=True, color='7F7F7F'))
        fill_blanks(r)
        r += 1
    end = r - 1
    if sec == 'GS':
        put(r, 'BOQ code', 'GS-DED', F(bold=True))
        put(r, 'Element / type', 'Deduct ground beam footprint (blinding & waterproofing under slab)', F(italic=True))
        put(r, 'Level', GROUND)
        put(r, 'Blinding area (m2)', '=-SUMIFS(%s,%s,"GB")' % (rng('Plan / section area (m2)'), rng('BOQ code')), fmt=FMT['Blinding area (m2)'])
        put(r, 'Blinding volume (m3)', '=%s%d*%s' % (c_('Blinding area (m2)'), r, BLIND_REF), fmt=FMT['Blinding volume (m3)'])
        put(r, 'Waterproofing (m2)', '=%s%d' % (c_('Blinding area (m2)'), r), fmt=FMT['Waterproofing (m2)'])
        put(r, 'Notes', 'Slab area includes the area over ground beams; beams have their own blinding & waterproofing', F(italic=True, color='7F7F7F'))
        fill_blanks(r); r += 1; end = r - 1
    if sec in ('FS', 'RS'):
        for lv in (susp_levels if sec == 'FS' else roof_levels):
            put(r, 'BOQ code', sec + '-DED', F(bold=True))
            put(r, 'Element / type', 'Deduct beam soffits under slabs (%s)' % lv.title(), F(italic=True))
            put(r, 'Level', lv)
            put(r, 'Formwork - sides & soffits (m2)', '=-SUMIFS(%s,%s,"BM",%s,"%s",%s,">0")' % (
                rng('Plan / section area (m2)'), rng('BOQ code'), rng('Level'), lv, rng('Deduct depth (m)')),
                fmt=FMT['Formwork - sides & soffits (m2)'])
            put(r, 'Notes', 'Beam soffits are measured with the beams, so they are taken out of the slab soffit', F(italic=True, color='7F7F7F'))
            fill_blanks(r); r += 1
        end = r - 1
    put(r, 'Element / type', 'Sub-total ' + title.split(' (')[0].title(), F(bold=True))
    for h in NUMCOLS:
        put(r, h, '=SUBTOTAL(9,%s%d:%s%d)' % (c_(h), start, c_(h), end), F(bold=True), fmt=FMT[h])
    for j in range(1, len(HDR) + 1):
        M.cell(r, j).fill = TFILL; M.cell(r, j).border = BD
        if not M.cell(r, j).font.bold: M.cell(r, j).font = F(bold=True)
    r += 2
LAST = r - 2
for row in M.iter_rows(min_row=FIRST, max_row=LAST):
    for c in row:
        if isinstance(c.value, str) and TOK in c.value: c.value = c.value.replace(TOK, str(LAST))
GT = LAST + 2
put(GT, 'Element / type', 'GRAND TOTAL (in-situ concrete only: excl. piles and precast)', F(bold=True, color='FFFFFF'), HFILL)
for h in NUMCOLS:
    col = c_(h); a = '%s%d:%s%d' % (col, FIRST, col, LAST); cc = '$A$%d:$A$%d' % (FIRST, LAST)
    put(GT, h, '=SUBTOTAL(9,%s)-SUMIFS(%s,%s,"PILE")-SUMIFS(%s,%s,"PCW")-SUMIFS(%s,%s,"PRES")' % (a, a, cc, a, cc, a, cc),
        F(bold=True, color='FFFFFF'), HFILL, FMT[h])
for j in range(1, len(HDR) + 1): M.cell(GT, j).fill = HFILL
widths = {'BOQ code': 9, 'Revit ID': 9, 'Element / type': 40, 'Mark': 7, 'Level': 15, 'Concrete grade': 10, 'No.': 5,
          'Notes': 55, 'Unit': 6, 'Rebar code': 7}
for h in HDR: M.column_dimensions[c_(h)].width = widths.get(h, 11)
M.freeze_panes = M.cell(FIRST, 4)
M.auto_filter.ref = 'A%d:%s%d' % (HR, c_('Notes'), LAST)
M.sheet_view.zoomScale = 90
M.cell(HR, HDR.index('Deduct depth (m)') + 1).comment = Comment(
    'Depth taken out of the element because another element is measured through it. Beams: slab thickness '
    '(slab measured over beam). Columns: overlap with beams/slabs. Derived from the model volumes - change if needed.', 'QS')
M.cell(HR, HDR.index('Model volume (m3)') + 1).comment = Comment(
    'Volume exported by Revit, rounded to 2 decimals. Used as a check, except for shaped items '
    '(equipment bases, corbels, fill, steps, non-standard beams) where it is used directly.', 'QS')

# ============================================================== 6. BOQ
codes = {d['code'] for d in E}
def present(prefix): return sorted([c for c in codes if c.startswith(prefix + '-') and c[len(prefix) + 1:].isdigit()],
                                   key=lambda c: int(c.split('-')[1]))
B = wb.create_sheet('BOQ', 0)
B['A1'] = 'BILL OF QUANTITIES - STRUCTURAL CONCRETE WORKS'; B['A1'].font = F(bold=True, size=13, color=BLUE)
B['A2'] = 'All quantities are formulas linked to the Measurement sheet (SUMIFS on the BOQ code). Green = linked quantity. Enter rates in column E.'
B['A2'].font = F(italic=True, size=9)
for i, h in enumerate(['Item', 'Description', 'Qty', 'Unit', 'Rate', 'Amount', 'Linked to (code / column)'], 1):
    c = B.cell(4, i, h); c.font = F(bold=True, color='FFFFFF', size=10); c.fill = HFILL; c.border = BD
    c.alignment = Alignment(horizontal='center', vertical='center')
def mrng(h): return 'Measurement!$%s$%d:$%s$%d' % (COL[h], FIRST, COL[h], LAST)
VOL, FW, FWE, REB = 'Volume (m3)', 'Formwork - sides & soffits (m2)', 'Formwork - slab edges (m2)', 'Rebar (kg)'
BLV, WP, OTH = 'Blinding volume (m3)', 'Waterproofing (m2)', 'Other qty'
UNIT = {VOL: 'm3', FW: 'm2', FWE: 'm2', REB: 'kg', BLV: 'm3', WP: 'm2', OTH: 'm2'}
SHORT = {VOL: 'Volume', FW: 'Formwork', FWE: 'Slab edges', REB: 'Rebar', BLV: 'Blinding vol', WP: 'Waterproofing', OTH: 'Other qty'}
def B10(**k):
    k.setdefault('size', 10); return F(**k)
br = [5]; letter = [0]; conc_rows = []

def has(code):
    if code.endswith('*'): return any(c.startswith(code[:-1]) and not c.endswith('DED') for c in codes)
    return code in codes
def heading(text, level):
    r = br[0]; c = B.cell(r, 2, text)
    if level == 1:
        c.font = B10(bold=True, size=11, color=BLUE)
        for j in range(1, 8): B.cell(r, j).fill = SFILL
        letter[0] = 0
    elif level == 2: c.font = B10(bold=True, underline='single')
    else: c.font = B10(); c.alignment = Alignment(wrap_text=True, vertical='top')
    for j in range(1, 8): B.cell(r, j).border = BD
    br[0] += 1
def item(desc, col, code, rebar_code=None, conc=False):
    r = br[0]; letter[0] += 1; n = letter[0]
    B.cell(r, 1, chr(64 + n) if n <= 26 else chr(64 + (n - 1) // 26) + chr(65 + (n - 1) % 26))
    B.cell(r, 2, '="%s ("&TEXT(Rates!$C$%d,"0")&" kg/m3)"' % (desc, RROW[rebar_code]) if rebar_code else desc)
    B.cell(r, 3, '=SUMIFS(%s,%s,$H$%d)' % (mrng(col), mrng('BOQ code'), r)).font = B10(color=LNK)
    B.cell(r, 3).number_format = '#,##0.00;-#,##0.00;-'
    B.cell(r, 4, UNIT[col]); B.cell(r, 5).fill = YFILL; B.cell(r, 5).number_format = '#,##0.00'
    B.cell(r, 6, '=C%d*E%d' % (r, r)).number_format = '#,##0.00;-#,##0.00;-'
    B.cell(r, 7, '%s  /  %s' % (code, SHORT[col])).font = F(size=8, color='7F7F7F')
    B.cell(r, 8, code).font = F(size=8, color='BFBFBF')
    for j in range(1, 8):
        B.cell(r, j).border = BD
        if j not in (3, 7): B.cell(r, j).font = B10()
    B.cell(r, 2).alignment = Alignment(wrap_text=True, vertical='top')
    if conc: conc_rows.append(r)
    br[0] += 1
def gap():
    for j in range(1, 8): B.cell(br[0], j).border = BD
    br[0] += 1
def group(head, specs, hdr2=None, sub=None):
    """specs: list of (desc, col, code, rebar_code, conc). Writes headings only if any item present."""
    live = [s for s in specs if has(s[2])]
    if not live: return False
    if hdr2: heading(hdr2, 2)
    if head: heading(head, 3)
    if sub: heading(sub, 2)
    for s in live: item(*s)
    return True

SPEC = 'complete in accordance with the Drawings and Specification.'
RC = lambda g: 'Supply and installation of poured in place reinforced in-situ cement concrete; grade %s; %s' % (g, SPEC)
REBAR = 'Supply and installation of high yield reinforcement steel bars; ' + SPEC
FORM = 'Supply and installation of formwork; ' + SPEC
def grade_for(codeset):
    g = collections.Counter(d['grade'] for d in E if d['code'] in codeset and d['grade'])
    return g.most_common(1)[0][0] if g else 'C40/50'
def mm(c): return int(c.split('-')[1])

# ---- C2 concrete
heading('C2 POURED CONCRETE', 1)
heading('Foundations', 2)
group('Supply and installation of poured in place plain in-situ cement concrete; grade C15/20; ' + SPEC,
      [('To pile caps; 50mm thick', BLV, 'PC', None, False), ('To ground beams; 50mm thick', BLV, 'GB', None, False),
       ('To boundary wall pile caps; 50mm thick', BLV, 'PC-BW', None, False),
       ('To boundary wall tie beams; 50mm thick', BLV, 'GB-BW', None, False),
       ('To boundary wall base; 50mm thick', BLV, 'BWB', None, False),
       ('To ground floor slab; 50mm thick', BLV, 'GS-*', None, False)], sub='Horizontal work; in blinding')
gap()
pcg = grade_for({'PC', 'PC-BW'})
if has('PC') or has('PC-BW'):
    pmat = next((re.search(r'\d+ ?MPa', str(d['mat'])).group() for d in E if d['code'] in ('PC', 'PC-BW') and re.search(r'\d+ ?MPa', str(d.get('mat')))), '')
    heading(RC(pcg + ('' if pcg == 'C40/50' else ' (model material %s - verify against specification)' % pmat)), 3)
    heading('Horizontal work; in structure', 2)
    if has('PC'): item('To pile caps', VOL, 'PC', None, True)
    if has('PC-BW'): item('To boundary wall pile caps', VOL, 'PC-BW', None, True)
    gap()
fd = [('To other foundations', VOL, 'FDN', None, True), ('To pile cap concrete fill', VOL, 'PCF', None, True),
      ('To ground beams and tie beams', VOL, 'GB', None, True), ('To boundary wall tie beams', VOL, 'GB-BW', None, True),
      ('To boundary wall base 280mm thick', VOL, 'BWB', None, True)] + \
     [('To ground slab %d mm' % mm(c), VOL, c, None, True) for c in present('GS')]
if group(RC('C40/50'), fd, sub='Horizontal work; in structure'): gap()
heading('Concrete Frames', 2)
fr = [('To columns', VOL, 'COL', None, True), ('To beams', VOL, 'BM', None, True)] + \
     [('To upstand walls %dmm thick' % mm(c), VOL, c, None, True) for c in present('UW')] + \
     [('To RC wall %dmm thick' % mm(c), VOL, c, None, True) for c in present('W')] + [('To corbels', VOL, 'CORB', None, True)]
group(RC('C40/50'), fr); gap()
if has('STEP') or present('FS'):
    heading('Floors', 2)
    group('Supply and installation of light weight concrete; grade C20/25; ' + SPEC, [('To steps', VOL, 'STEP', None, True)])
    group(RC('C40/50'), [('To slab %d mm' % mm(c), VOL, c, None, True) for c in present('FS')]); gap()
if has('EQB') or present('RS'):
    heading('Roof Structure', 2)
    group(RC(grade_for({'EQB'}) + ' (assumed as your BOQ - verify)'), [('To MEP equipment base', VOL, 'EQB', None, True)])
    group(RC('C40/50'), [('To slab %d mm' % mm(c), VOL, c, None, True) for c in present('RS')]); gap()
if group('Supply and installation of precast concrete units; ' + SPEC,
         [('Boundary wall panels 120mm thick', OTH, 'PCW', None, False), ('Slab %s thick (modelled as precast)' % ('/'.join(sorted({'%dmm' % round(d['D'] * 1000) for d in E if d['code'] == 'PRES'})) or ''), OTH, 'PRES', None, False)],
         'Precast Concrete (for information - check if in this package)'): gap()
# ---- reinforcement
heading('C2 REINFORCEMENT', 1)
if group(REBAR, [('To pile caps', REB, 'PC', 'PC', False), ('To boundary wall pile caps', REB, 'PC-BW', 'PC', False),
                 ('To other foundations', REB, 'FDN', 'PC', False), ('To pile cap concrete fill', REB, 'PCF', 'PCF', False),
                 ('To ground beams and tie beams', REB, 'GB', 'GB', False), ('To boundary wall tie beams', REB, 'GB-BW', 'GB', False),
                 ('To boundary wall base', REB, 'BWB', 'BWB', False), ('To slab on grade', REB, 'GS-*', 'GS', False)], 'Foundations'): gap()
if group(REBAR, [('To columns', REB, 'COL', 'COL', False), ('To beams', REB, 'BM', 'BM', False)] +
         [('To upstand walls %dmm thick' % mm(c), REB, c, 'UW', False) for c in present('UW')] +
         [('To RC wall %dmm thick' % mm(c), REB, c, 'UW', False) for c in present('W')] +
         [('To corbels', REB, 'CORB', 'CORB', False)], 'Concrete Frames'): gap()
if group(REBAR, [('To suspended slab', REB, 'FS-*', 'FS', False)], 'Floors'): gap()
if group(REBAR, [('To roof slabs', REB, 'RS-*', 'RS', False), ('To MEP equipment base', REB, 'EQB', 'EQB', False)], 'Roof Structure'): gap()
# ---- shuttering
heading('C4 SHUTTERING', 1)
if group(FORM, [('To sides of pile caps', FW, 'PC', None, False), ('To sides of boundary wall pile caps', FW, 'PC-BW', None, False),
                ('To sides of ground beams and tie beams', FW, 'GB', None, False),
                ('To sides of boundary wall tie beams', FW, 'GB-BW', None, False),
                ('To sides of boundary wall base', FW, 'BWB', None, False)] +
         [('To sides and edges of ground slabs (thickness %dmm)' % mm(c), FWE, c, None, False) for c in present('GS')], 'Foundations'): gap()
if group(FORM, [('To columns', FW, 'COL', None, False), ('To beams (soffits and sides)', FW, 'BM', None, False)] +
         [('To %dmm thick upstand walls' % mm(c), FW, c, None, False) for c in present('UW')] +
         [('To %dmm thick RC wall' % mm(c), FW, c, None, False) for c in present('W')] +
         [('To corbels', FW, 'CORB', None, False)], 'Concrete Frames'): gap()
if group(FORM, [('To soffit of slabs (net of beam soffits)', FW, 'FS-*', None, False),
                ('To sides of slabs', FWE, 'FS-*', None, False)], 'Floors'): gap()
if group(FORM, [('To soffit of roof slabs (net of beam soffits)', FW, 'RS-*', None, False),
                ('To sides of roof slabs', FWE, 'RS-*', None, False),
                ('To sides of equipment base', FW, 'EQB', None, False)], 'Roof Structure'): gap()
# ---- waterproofing
heading('WATERPROOFING TO SUBSTRUCTURE', 1)
group('Supply and application of waterproofing membrane / coating to concrete surfaces in contact with the ground; '
      'including laps, protection board and all associated works; ' + SPEC,
      [('To underside of ground slab (horizontal)', WP, 'GS-*', None, False),
       ('To sides and bottom of pile caps', WP, 'PC', None, False),
       ('To sides and bottom of boundary wall pile caps', WP, 'PC-BW', None, False),
       ('To sides and bottom of ground beams and tie beams', WP, 'GB', None, False),
       ('To sides and bottom of boundary wall tie beams', WP, 'GB-BW', None, False),
       ('To both faces of boundary wall base', WP, 'BWB', None, False)] +
      ([('To external face of upstand walls at ground floor', WP, 'UW-*', None, False)] if any(d.get('wp') for d in E) else []))
gap()
LASTB = br[0] - 1; r = br[0]
B.cell(r, 2, 'TOTAL CARRIED TO COLLECTION').font = B10(bold=True)
B.cell(r, 6, '=SUM(F5:F%d)' % LASTB).font = B10(bold=True); B.cell(r, 6).number_format = '#,##0.00;-#,##0.00;-'
for j in range(1, 8): B.cell(r, j).border = Border(top=Side(style='medium'), bottom=Side(style='double'))
for col, w in zip('ABCDEFGH', [6, 62, 12, 6, 11, 14, 22, 8]): B.column_dimensions[col].width = w
B.column_dimensions['H'].hidden = True
B.freeze_panes = 'A5'

# ============================================================== 7. READ ME
Rm = wb.create_sheet('Read Me', 0)
lines = [
    ('HOW THIS WORKBOOK WORKS', 'h'),
    ('Source model: %s (%s export).' % (SRCNAME, re.search(r'Revit \d{4}', creator).group() if re.search(r'Revit \d{4}', creator) else 'Revit'), ''),
    ('Levels detected: ground = %s, roof = %s, suspended floors = %s.' % (GROUND, ROOF, ', '.join(susp_levels) or 'none'), ''),
    ('1. Measurement sheet: one row per model element. Dimensions come from the model; volume, formwork, rebar, '
     'blinding and waterproofing are formulas.', ''),
    ('2. BOQ sheet: every quantity is a SUMIFS formula that adds the Measurement column for its BOQ code '
     '(column G shows the link). Change a dimension and the BOQ updates.', ''),
    ('3. Rates sheet: rebar rates (kg/m3) and blinding thickness. The rebar BOQ descriptions update with the rate.', ''),
    ('', ''),
    ('COLOUR LEGEND', 'h'),
    ('Blue text = taken from the model  |  Yellow fill = assumption you can change  |  Black = formula  |  Green = linked from another sheet', ''),
    ('', ''),
    ('MEASUREMENT RULES USED', 'h'),
    ('Volume = No. x plan/section area x (depth - deduct). Slabs are measured over beams; beams measured below slab.', ''),
    ('Pile caps: L x W from model, depth from type name. Formwork = 4 sides. Waterproofing = sides + bottom. Blinding = plan area.', ''),
    ('Ground beams: formwork = 2 sides x (depth - slab). No soffit formwork (on blinding). Waterproofing = sides + bottom.', ''),
    ('Suspended beams: formwork = soffit + 2 sides x (depth - slab). Slab soffits are reduced by the beam soffits (deduct rows).', ''),
    ('Columns: formwork = perimeter x (height - overlap with beams/slabs).', ''),
    ('Walls: formwork = 2 faces x length x height. Ground floor upstands below level: waterproofing to one face.', ''),
    ('Slabs: plan area = model volume / thickness (the model exports area rounded to whole m2). Slab edge formwork = perimeter x thickness.', ''),
    ('Ground slab: no soffit formwork; blinding and waterproofing to underside, less ground beam footprint.', ''),
    ('Equipment bases, corbels, pile cap fill, steps, non-standard beams: model volume used because the shapes are not simple boxes.', ''),
    ('Rebar = concrete volume x kg/m3 rate (Rates sheet).', ''),
    ('', ''),
    ('ITEMS TO CHECK', 'h'),
    ('Concrete grades come from the model material. Pile cap grade often differs from the specification - check.', ''),
    ('Slab edge formwork uses the full slab perimeter, so it includes edges against other slabs. Reduce if needed.', ''),
    ('"Deduct depth" values were worked out from model volumes. Rows marked "check" in Notes did not match a slab thickness.', ''),
    ('No split by building or zone: the model has no location field. Add a code suffix if you need it.', ''),
    ('Not included: piles (listed for information only), stairs, structural steel, lintels, blockwork.', ''),
    ('Waterproofing scope is assumed (surfaces in contact with ground). Confirm against the waterproofing specification.', ''),
    ('', ''),
    ('QUICK CHECKS', 'h'),
]
for i, (t, s) in enumerate(lines, 1):
    c = Rm.cell(i, 1, t); c.font = F(bold=True, size=11, color=BLUE) if s == 'h' else F(size=10)
    c.alignment = Alignment(wrap_text=True)
rr = len(lines) + 1
chk = [('In-situ concrete in BOQ (m3)', '=SUM(%s)' % ','.join('BOQ!C%d' % x for x in conc_rows) if conc_rows else '=0'),
       ('Measurement total in-situ volume (m3)', '=Measurement!%s%d' % (COL['Volume (m3)'], GT)),
       ('Model volume, same elements (m3)', '=Measurement!%s%d' % (COL['Model volume (m3)'], GT)),
       ('Difference measured vs model (m3)', '=B%d-B%d' % (rr + 1, rr + 2))]
for i, (a, f) in enumerate(chk):
    Rm.cell(rr + i, 1, a).font = F(size=10)
    c = Rm.cell(rr + i, 2, f); c.font = F(color=LNK, bold=True, size=10); c.number_format = '#,##0.00'
Rm.cell(rr + 4, 1, 'Note: the first two lines must match. Small differences against the model come from pile caps measured as full boxes '
        '(the model cuts them where piles and slabs meet) and from the model rounding each volume to 2 decimals. See the Difference column.').font = F(italic=True, size=9)
Rm.column_dimensions['A'].width = 120; Rm.column_dimensions['B'].width = 16

wb.move_sheet('Rates', offset=10)
wb.active = 1
for ws in wb:
    big = ws.title == 'Measurement'
    ws.page_setup.orientation = 'landscape' if big else 'portrait'
    ws.page_setup.paperSize = ws.PAPERSIZE_A3 if big else ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
B.print_title_rows = '4:4'; M.print_title_rows = '4:4'
wb.save(OUT)
if ELEM_JSON:
    import json
    json.dump({'ground': GROUND, 'roof': ROOF, 'elements': [dict(id=d['id'], code=d['code'], level=d['lvl'], desc=d['desc'], mark=d['mark'], grade=d['grade']) for d in E]}, open(ELEM_JSON, 'w'))
cnt = collections.Counter(d['code'] for d in E)
print('Saved', OUT)
print('Elements:', len(E), '| ground:', GROUND, '| roof:', ROOF, '| suspended:', susp_levels)
print('Codes:', dict(sorted(cnt.items())))
print('Flagged rows:', sum(1 for d in E if 'check' in d['note']))
