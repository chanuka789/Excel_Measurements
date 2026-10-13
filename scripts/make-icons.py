"""Draws the ribbon button icons (16/32/80 px PNG) into public/assets/ribbon/. Run: python3 scripts/make-icons.py"""
from PIL import Image, ImageDraw
import os
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'ribbon')
os.makedirs(OUT, exist_ok=True)
INK, BLUE, AMBER, GREEN = (66, 66, 66, 255), (15, 108, 189, 255), (242, 169, 0, 255), (16, 124, 16, 255)
S = 320  # draw big on a 32-unit grid, then downscale

def canvas(): return Image.new('RGBA', (S, S), (0, 0, 0, 0))
def u(*v): return [x * S / 32 for x in v]
def W(n): return max(1, int(n * S / 32))

def cube(d, x, y, s, fill=None, col=INK):
    top = u(x, y + s * .25, x + s * .5, y, x + s, y + s * .25, x + s * .5, y + s * .5)
    d.polygon(top, fill=fill, outline=col, width=W(2))
    d.polygon(u(x, y + s * .25, x + s * .5, y + s * .5, x + s * .5, y + s, x, y + s * .75), outline=col, width=W(2))
    d.polygon(u(x + s, y + s * .25, x + s * .5, y + s * .5, x + s * .5, y + s, x + s, y + s * .75), outline=col, width=W(2))

def projects(d):
    d.rounded_rectangle(u(3, 8, 29, 27), radius=W(2), outline=INK, width=W(2))
    d.polygon(u(3, 8, 3, 5, 12, 5, 14, 8), outline=INK, fill=None, width=W(2))
    cube(d, 11, 11, 11, col=BLUE)
def elements(d):
    for i, y in enumerate([5, 13, 21]):
        x = 4 + (0 if i == 0 else 6)
        d.rectangle(u(x, y, x + 6, y + 6), outline=BLUE if i == 1 else INK, width=W(2))
        d.line(u(x + 9, y + 3, 29, y + 3), fill=INK, width=W(2))
    d.line(u(7, 11, 7, 24, 10, 24), fill=INK, width=W(2)); d.line(u(7, 16, 10, 16), fill=INK, width=W(2))
def measure(d):
    d.polygon(u(3, 22, 22, 3, 29, 10, 10, 29), outline=INK, width=W(2))
    for i in range(5):
        a = 7 + i * 3.6; d.line(u(a, 22 - i * 3.6 - 0, a + 3 - (i % 2) * 1.5, 25 - i * 3.6 - 0), fill=BLUE, width=W(2))
def ai(d):
    d.polygon(u(14, 3, 17, 12, 26, 15, 17, 18, 14, 27, 11, 18, 2, 15, 11, 12), fill=BLUE)
    d.polygon(u(25, 2, 26.5, 6, 30, 7, 26.5, 8, 25, 12, 23.5, 8, 20, 7, 23.5, 6), fill=AMBER)
def fitv(d):
    for (x, y, dx, dy) in [(3, 3, 1, 1), (29, 3, -1, 1), (3, 29, 1, -1), (29, 29, -1, -1)]:
        d.line(u(x, y + 7 * dy, x, y, x + 7 * dx, y), fill=INK, width=W(2.4), joint='curve')
    cube(d, 10, 9, 12, col=BLUE)
def showall(d):
    d.ellipse(u(2, 9, 30, 23), outline=INK, width=W(2)); d.ellipse(u(11, 11, 21, 21), fill=BLUE)
def isolate(d):
    for x, y in [(2, 2), (21, 2), (2, 21), (21, 21)]:
        d.rectangle(u(x, y, x + 9, y + 9), outline=(170, 170, 170, 255), width=W(1.5))
    cube(d, 9, 8, 14, fill=AMBER, col=INK)
def clear(d):
    d.rectangle(u(4, 4, 22, 22), outline=INK, width=W(2))
    d.ellipse(u(16, 16, 30, 30), fill=(197, 15, 31, 255)); d.line(u(20, 20, 26, 26), fill='white', width=W(2.2)); d.line(u(26, 20, 20, 26), fill='white', width=W(2.2))
def fromexcel(d):
    d.rectangle(u(2, 6, 16, 26), outline=GREEN, width=W(2))
    for y in (11, 16, 21): d.line(u(2, y, 16, y), fill=GREEN, width=W(1.5))
    d.line(u(9, 6, 9, 26), fill=GREEN, width=W(1.5))
    d.line(u(17, 16, 23, 16), fill=INK, width=W(2)); d.polygon(u(22, 13, 26, 16, 22, 19), fill=INK)
    cube(d, 20, 4, 10, col=BLUE)
def refresh(d):
    d.arc(u(5, 5, 27, 27), 200, 470, fill=BLUE, width=W(2.6)); d.polygon(u(5, 6, 6, 14, 13, 11), fill=BLUE)
def admin(d):
    import math
    pts = []
    for i in range(16):
        r = 13 if i % 2 == 0 else 10
        a = i * math.pi / 8
        pts += [16 + r * math.cos(a), 16 + r * math.sin(a)]
    d.polygon(u(*pts), outline=INK, width=W(2)); d.ellipse(u(12, 12, 20, 20), outline=BLUE, width=W(2.4))
def group(d):
    d.rounded_rectangle(u(1, 1, 31, 31), radius=W(6), fill=BLUE)
    d.polygon(u(16, 5, 26, 10.5, 26, 21.5, 16, 27, 6, 21.5, 6, 10.5), outline='white', width=W(2))
    d.line(u(6, 10.5, 16, 16, 26, 10.5), fill=AMBER, width=W(2)); d.line(u(16, 16, 16, 27), fill=AMBER, width=W(2))

ICONS = dict(projects=projects, elements=elements, measure=measure, ai=ai, fit=fitv, showall=showall, isolate=isolate,
             clear=clear, fromexcel=fromexcel, refresh=refresh, admin=admin, group=group)
for name, fn in ICONS.items():
    im = canvas(); fn(ImageDraw.Draw(im))
    for size in (16, 32, 80):
        im.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f'{name}-{size}.png'))
print('icons:', len(ICONS) * 3)
