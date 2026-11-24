from PIL import Image
from collections import Counter
import colorsys

P = r"C:\Users\you\AppData\Local\hermes\cache\scratch\hermes-shot.png"
im = Image.open(P).convert("RGB")
W, H = im.size

# ---- chat area only
x0, x1, y0, y1 = int(W * 0.15), int(W * 0.85), int(H * 0.08), int(H * 0.95)
area = im.crop((x0, y0, x1, y1))
c = Counter(area.getdata())
print("chat area top colours:")
total = area.size[0] * area.size[1]
for rgb, n in c.most_common(10):
    print("   #%02x%02x%02x  %5.2f%%" % (rgb[0], rgb[1], rgb[2], 100 * n / total))

# ---- any saturated colour (an accent) in the whole screen
print("\nsaturated colours (accent hunt):")
acc = Counter()
for rgb, n in Counter(im.resize((W // 2, H // 2)).getdata()).most_common(400):
    r, g, b = [v / 255 for v in rgb]
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    if s > 0.25 and v > 0.25:
        acc[rgb] += n
for rgb, n in acc.most_common(8):
    h, s, v = colorsys.rgb_to_hsv(*[x / 255 for x in rgb])
    print("   #%02x%02x%02x  sat %.2f val %.2f  hue %3d  n=%d" %
          (rgb[0], rgb[1], rgb[2], s, v, int(h * 360), n))

# ---- look for card rectangles: rows where a lighter panel tone dominates a band
panel = (15, 22, 33)   # #0f1621
def near(px, ref, tol=5):
    return all(abs(px[i] - ref[i]) <= tol for i in range(3))

bands = []
cur = None
for y in range(y0, y1, 2):
    row = [im.getpixel((x, y)) for x in range(x0, x1, 6)]
    frac = sum(1 for p in row if near(p, panel)) / len(row)
    on = frac > 0.25
    if cur is None or on != cur[2]:
        bands.append((y, on))
        cur = (y, on, on)
print("\npanel-tone bands (y, is_panel):", bands[:12])

# ---- left/right extent of the panel tone on a panel row
for y, on in bands:
    if on:
        xs = [x for x in range(x0, x1) if near(im.getpixel((x, y)), panel)]
        if xs:
            print("panel row y=%d spans x %d..%d (%.0f%% of chat width)" %
                  (y, min(xs), max(xs), 100 * (max(xs) - min(xs)) / (x1 - x0)))
        break
