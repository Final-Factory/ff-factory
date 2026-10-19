# The tray app's icons (w1532), drawn from the portal's browser-tab favicon (web/index.html: a 32x32 SVG, a dark rounded
# square, an orange "F" stroke and an orange dot). Run with Pillow: python machine/tray/make-icons.py
#   fff.ico         the favicon itself: work runs
#   fff-paused.ico  the same "F" greyed, the dot turned into an orange pause sign: work on this PC is paused
# Each holds 16, 20, 24, 32, 40, 48, 64 and 256 px (the tray's small icon at 100% to 250% scale, Explorer's sizes).
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = [16, 20, 24, 32, 40, 48, 64, 256]
BG = (0x0B, 0x0F, 0x14, 255)
ORANGE = (0xFF, 0x9F, 0x1C, 255)
GREY = (0x8B, 0x95, 0xA1, 255)


def stroke(d, pts, width, colour, k):
    # A polyline with round caps and joins, in favicon units scaled by k (the SVG's stroke-linecap/linejoin round).
    scaled = [(x * k, y * k) for x, y in pts]
    d.line(scaled, fill=colour, width=round(width * k))
    r = width * k / 2
    for x, y in scaled:
        d.ellipse((x - r, y - r, x + r, y + r), fill=colour)


def draw(size, paused):
    ss = 16  # supersampling: drawn at 16x, then reduced with a box filter
    big = size * ss
    k = big / 32
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, big - 1, big - 1), radius=round(7 * k), fill=BG)
    f = GREY if paused else ORANGE
    stroke(d, [(8, 23), (8, 9), (21, 9)], 3.4, f, k)
    stroke(d, [(8, 16), (17, 16)], 3.4, f, k)
    if paused:
        # Two bars where the dot was (cx 24, cy 22, r 3), a little larger so they read at 16 px.
        for x0 in (20.6, 25.0):
            d.rounded_rectangle((x0 * k, 17.6 * k, (x0 + 2.8) * k, 26.4 * k), radius=round(0.7 * k), fill=ORANGE)
    else:
        d.ellipse(((24 - 3) * k, (22 - 3) * k, (24 + 3) * k, (22 + 3) * k), fill=ORANGE)
    return img.resize((size, size), Image.Resampling.BOX)


for name, paused in (('fff.ico', False), ('fff-paused.ico', True)):
    imgs = [draw(s, paused) for s in SIZES]
    imgs[-1].save(os.path.join(HERE, name), format='ICO', sizes=[(s, s) for s in SIZES], append_images=imgs[:-1])
print('wrote', ', '.join(n for n in ('fff.ico', 'fff-paused.ico')))
