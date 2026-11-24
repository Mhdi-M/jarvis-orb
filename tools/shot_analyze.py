from PIL import Image
from collections import Counter

P = r"C:\Users\you\AppData\Local\hermes\cache\scratch\hermes-shot.png"
im = Image.open(P).convert("RGB")
W, H = im.size
print("size", W, H)

# ---- palette of the whole screen
small = im.resize((W // 3, H // 3))
c = Counter(small.getdata())
print("\ntop colours (whole screen):")
for rgb, n in c.most_common(12):
    print("   #%02x%02x%02x  %5.2f%%" % (rgb[0], rgb[1], rgb[2], 100 * n / (small.size[0] * small.size[1])))

# ---- find the app window: the largest rectangle whose colour differs from the desktop
# sample a horizontal line through the middle to find x boundaries
def row_colors(y):
    return [im.getpixel((x, y)) for x in range(0, W, 4)]

mid = row_colors(H // 2)
# find the most common colour in the middle band (the app background)
bg = Counter(mid).most_common(1)[0][0]
print("\nmiddle-row background:", "#%02x%02x%02x" % bg)


def spans(values, pred):
    out, start = [], None
    for i, v in enumerate(values):
        if pred(v) and start is None:
            start = i
        elif not pred(v) and start is not None:
            out.append((start, i))
            start = None
    if start is not None:
        out.append((start, len(values)))
    return out


def close(a, b, tol=6):
    return all(abs(a[i] - b[i]) <= tol for i in range(3))


# ---- vertical structure in the middle of the screen: panels vs chat background
col_x = W // 2
column = [im.getpixel((col_x, y)) for y in range(H)]
bands = []
prev = None
for y, px in enumerate(column):
    key = close(px, bg, 8)
    if prev is None or key != prev:
        bands.append((y, key))
        prev = key
print("\nbackground bands down the middle column (y, is-app-bg):")
print("  ", bands[:14])

# ---- text lines in the central chat column: bright pixels per row
x0, x1 = int(W * 0.30), int(W * 0.72)
rows = []
for y in range(H):
    bright = 0
    for x in range(x0, x1, 2):
        r, g, b = im.getpixel((x, y))
        if r + g + b > 330:
            bright += 1
    rows.append(bright)
lines = spans(rows, lambda v: v > 3)
gaps = [lines[i + 1][0] - lines[i][0] for i in range(len(lines) - 1)]
print("\ntext lines found in the chat column:", len(lines))
if gaps:
    gaps_sorted = sorted(gaps)
    print("row pitch (px): median", gaps_sorted[len(gaps_sorted) // 2],
          " min", min(gaps), " max", max(gaps))
print("first lines (y0,y1,height):", [(a, b, b - a) for a, b in lines[:8]])

# ---- left edge of text: where does content start inside the chat column?
xs = []
for y in range(H // 3, 2 * H // 3):
    for x in range(int(W * 0.20), int(W * 0.80)):
        r, g, b = im.getpixel((x, y))
        if r + g + b > 330:
            xs.append(x)
            break
print("\ntext left edges sample:", sorted(Counter(xs).items(), key=lambda kv: -kv[1])[:6])

# ---- distinct card / bubble colours around sample text lines
if lines:
    for a, b in lines[2:6]:
        y = (a + b) // 2
        row = [im.getpixel((x, y)) for x in range(int(W * 0.18), int(W * 0.86), 3)]
        cc = Counter(row).most_common(3)
        print("line y=%d colours:" % y, [("#%02x%02x%02x" % k, n) for k, n in cc])
