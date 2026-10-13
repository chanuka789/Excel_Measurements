#!/usr/bin/env python3
"""Convert the 2D sheets inside a DWFx (XPS FixedPage parts) to SVG files.

Usage: python3 -I sheets.py <model.dwfx> <out_dir>
Writes out_dir/sheet-<n>.svg and out_dir/sheets.json ([{"index": n, "name": ..., "width": .., "height": ..}]).
Paths, fills, strokes, transforms and text are converted; images and gradients are skipped.
"""
import sys, os, re, json, zipfile, html
import xml.etree.ElementTree as ET

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
X = '{http://schemas.microsoft.com/xps/2005/06}'
z = zipfile.ZipFile(SRC)
pages = sorted(n for n in z.namelist() if n.lower().endswith('.fpage'))

def colour(v):
    if not v or v.startswith('{'):
        return None, 1.0
    v = v.strip()
    if v.startswith('#'):
        h = v[1:]
        if len(h) == 8:
            return '#' + h[2:], int(h[:2], 16) / 255
        if len(h) == 6:
            return '#' + h, 1.0
    if v.startswith('sc#'):
        parts = [float(p) for p in v[3:].split(',')]
        if len(parts) == 4:
            a, r, g, b = parts
        else:
            a, (r, g, b) = 1.0, parts[:3]
        return '#%02x%02x%02x' % tuple(max(0, min(255, round(c * 255))) for c in (r, g, b)), a
    return None, 1.0

def matrix(v):
    if not v or v.startswith('{'):
        return ''
    p = [float(x) for x in re.split(r'[ ,]+', v.strip()) if x]
    return f' transform="matrix({",".join("%g" % x for x in p)})"' if len(p) == 6 else ''

def path_data(d):
    d = re.sub(r'^\s*F\s*[01]\s*', '', d or '')
    return d if re.match(r'^\s*[Mm]', d) else ''

def esc(s):
    return html.escape(s, quote=True)

def convert(el, out, depth=0):
    tag = el.tag.replace(X, '')
    op = el.get('Opacity')
    opa = f' opacity="{op}"' if op and op != '1' else ''
    if tag == 'Canvas':
        out.append(f'<g{matrix(el.get("RenderTransform"))}{opa}>')
        for c in el:
            convert(c, out, depth + 1)
        out.append('</g>')
    elif tag == 'Path':
        d = path_data(el.get('Data'))
        if not d:
            geo = el.find(f'{X}Path.Data/{X}PathGeometry')
            if geo is not None:
                d = path_data(geo.get('Figures'))
        if not d:
            return
        fill, fa = colour(el.get('Fill'))
        stroke, sa = colour(el.get('Stroke'))
        sw = el.get('StrokeThickness') or '1'
        attrs = f' d="{esc(d)}" fill="{fill or "none"}"'
        if fill and fa < 1: attrs += f' fill-opacity="{fa:.3g}"'
        if stroke:
            attrs += f' stroke="{stroke}" stroke-width="{sw}"'
            if sa < 1: attrs += f' stroke-opacity="{sa:.3g}"'
            cap = (el.get('StrokeStartLineCap') or '').lower()
            if cap in ('round', 'square'): attrs += f' stroke-linecap="{cap}"'
            join = (el.get('StrokeLineJoin') or '').lower()
            if join in ('round', 'bevel'): attrs += f' stroke-linejoin="{join}"'
        out.append(f'<path{attrs}{matrix(el.get("RenderTransform"))}{opa}/>')
    elif tag == 'Glyphs':
        text = el.get('UnicodeString') or ''
        if not text or text.startswith('{}'):
            text = text[2:] if text.startswith('{}') else text
        if not text.strip():
            return
        fill, fa = colour(el.get('Fill'))
        size = el.get('FontRenderingEmSize') or '10'
        out.append(f'<text x="{el.get("OriginX", "0")}" y="{el.get("OriginY", "0")}" font-size="{size}" font-family="Arial, sans-serif" fill="{fill or "#000"}"'
                   f'{matrix(el.get("RenderTransform"))}{opa}>{esc(text)}</text>')

sheets = []
for i, name in enumerate(pages, 1):
    try:
        root = ET.fromstring(z.read(name))
    except ET.ParseError:
        continue
    w = float(root.get('Width') or 1000); h = float(root.get('Height') or 700)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {h:g}" width="{w:g}" height="{h:g}"><rect width="100%" height="100%" fill="#fff"/>']
    for c in root:
        convert(c, out)
    out.append('</svg>')
    open(os.path.join(OUT, f'sheet-{i}.svg'), 'w', encoding='utf-8').write(''.join(out))
    label = re.sub(r'\.fpage$', '', name.split('/')[-1], flags=re.I)
    sheets.append(dict(index=i, name=label, width=w, height=h, part=name))
json.dump(sheets, open(os.path.join(OUT, 'sheets.json'), 'w'))
print('sheets', len(sheets))
