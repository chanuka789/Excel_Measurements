#!/usr/bin/env python3
"""Read every element of any Revit DWFx (Architecture, Structure, ID, MEP) with its
Category > Family > Type position, level, properties and measurable quantities.

Usage: python3 -I elements.py <model.dwfx> <out.json>
"""
import sys, re, json, zipfile, collections
import xml.etree.ElementTree as ET

SRC, OUT = sys.argv[1], sys.argv[2]
NS = '{DWF-Content:1.0}'
clean = lambda s: re.sub(r'\s*\(\d+\)$', '', s or '').strip()

NUM = re.compile(r'^\s*(-?\d+(?:\.\d+)?)\s*([^\d\s][^\s]*)?\s*$')
LENGTHY = re.compile(r'length|height|width|depth|thick|perimeter|offset|elevation|diameter|radius|span|size$|'
                     r'cut length|rise|run|tread|riser|clearance|sill|head', re.I)
SKIP = re.compile(r'^(id|guid|ifcguid|type ifcguid|phase.*|export.*|omniclass.*|assembly code|keynote|'
                  r'.*classification.*number|.*\bnumber\b.*|mark|type mark|workset|design option|absorptance|roughness|.*survey|'
                  r'.*capacity.*|pile load.*|pile moments|pile shear.*|.*bar \(.*|type name|.*level elevation)$', re.I)
LEVEL_KEYS = ('Level', 'Reference Level', 'Base Constraint', 'Base Level', 'Schedule Level', 'Associated Level')


def quantity(name, value):
    """Return (value, unit) for a measurable numeric property, or None."""
    if value is None or SKIP.match(name): return None
    m = NUM.match(str(value))
    if not m: return None
    v, u = float(m.group(1)), (m.group(2) or '')
    if u in ('m³', 'm3'): return v, 'm3'
    if u in ('m²', 'm2'): return v, 'm2'
    if u in ('ft³', 'CF'): return v * 0.0283168, 'm3'
    if u in ('ft²', 'SF'): return v * 0.092903, 'm2'
    if u == 'mm': return v / 1000, 'm'
    if u == 'cm': return v / 100, 'm'
    if u == 'm': return v, 'm'
    if u in ('ft', "'"): return v * 0.3048, 'm'
    if u == '' and LENGTHY.search(name): return v / 1000, 'm'      # Revit DWF exports lengths in mm without a unit
    if u == '': return v, ''
    if u in ('°', 'kg', 'kN', 'L', 'l/s', 'm³/h', 'W', 'kW', 'Pa', 'A', 'V'): return v, u
    return None


z = zipfile.ZipFile(SRC)
elements, cats = [], collections.Counter()
creator = ''
for n in z.namelist():
    if n.endswith('descriptor.xml'):
        m = re.search(rb'name="Creator" value="([^"]+)"', z.read(n))
        if m: creator = m.group(1).decode(errors='ignore')
    if not n.endswith('.content.xml'): continue
    root = ET.fromstring(z.read(n))
    objs = root.find(NS + 'Objects')
    if objs is None: continue

    def walk(o, path, inherited, parent_id):
        lab = o.get('label') or ''
        props = {x.get('name'): x.get('value') for x in o.findall(NS + 'Property')}
        merged = dict(inherited); merged.update({k: v for k, v in props.items() if v not in (None, '')})
        m = re.search(r'\[(\d+)\]$', lab)
        here = parent_id
        if m:
            eid = int(m.group(1)); here = eid
            p = path + [lab]
            cat = clean(p[0]) if len(p) > 1 else 'Other'
            fam = clean(p[1]) if len(p) > 2 else cat
            typ = clean(p[2]) if len(p) > 3 else fam
            level = next((merged[k] for k in LEVEL_KEYS if merged.get(k)), '')
            q = {}
            for k, v in merged.items():
                r = quantity(k, v)
                if r: q[k] = [round(r[0], 6), r[1]]
            # derived: wall face area from length x height (Revit exports Area rounded to the project's area units)
            if 'Length' in q and 'Unconnected Height' in q and q['Length'][1] == 'm':
                q['Face area (L x H)'] = [round(q['Length'][0] * q['Unconnected Height'][0], 4), 'm2']
            elements.append(dict(
                id=eid, cat=cat, fam=fam, type=typ, level=level, parent=parent_id,
                name=re.sub(r'\s*\[\d+\]$', '', lab),
                mark=merged.get('Mark') or merged.get('Column Mark') or merged.get('Beam Reinf. Mark') or '',
                material=merged.get('Structural Material') or merged.get('Material') or '',
                props={k: v for k, v in merged.items() if v not in (None, '') and len(str(v)) < 200},
                q=q))
            cats[cat] += 1
            inherited_next = {}           # sub-parts do not re-use the element's own instance values
        else:
            inherited_next = merged
        for c in o.findall(NS + 'Object'):
            walk(c, path + [lab], inherited_next if not m else {}, here)

    for o in objs.findall(NS + 'Object'):
        walk(o, [], {}, None)

if not elements:
    sys.exit('ERROR: no element properties found in this DWFx (geometry-only export). Publish the DWFx from Revit with element properties.')

rev = re.search(r'Revit \d{4}', creator)
json.dump(dict(source=rev.group() if rev else (creator or 'unknown'), categories=cats, elements=elements),
          open(OUT, 'w'), separators=(',', ':'))
print('elements', len(elements), dict(cats))
