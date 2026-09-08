#!/usr/bin/env python3
"""
Build the app icons from joystick.png.

joystick.png is the source artwork: 512x512, RGBA, transparent background,
with a cable trailing off the top. Icons cannot ship transparency — iOS fills
it with black on the home screen — so this composites the art onto a light
tile, centred on its own bounding box rather than the image's, and writes the
sizes iOS, Android and browsers ask for.

No image library needed: PNG decode, box-filter resize and encode are all
done here with zlib.

    python3 tools/make_icons.py
"""

import pathlib
import struct
import sys
import zlib

SIZE = 512
BG_TOP = (0xFF, 0xFF, 0xFF)
BG_BOTTOM = (0xEC, 0xF0, 0xF7)   # barely there, keeps the tile from looking flat


# ----------------------------------------------------------------- decode

def read_png(path):
    """Decode an 8-bit RGBA, non-interlaced PNG into (w, h, bytearray)."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        sys.exit(f"{path} is not a PNG")

    pos, idat, hdr = 8, bytearray(), None
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            hdr = struct.unpack(">IIBBBBB", body)
        elif tag == b"IDAT":
            idat += body
        pos += 12 + length

    w, h, depth, colour, _, _, interlace = hdr
    if (depth, colour, interlace) != (8, 6, 0):
        sys.exit(f"{path}: need 8-bit RGBA, non-interlaced (got depth={depth} colour={colour})")

    raw = zlib.decompress(bytes(idat))
    stride = w * 4
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        ftype = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos + stride]); pos += stride
        # Undo the per-scanline filter (PNG spec section 9).
        for i in range(stride):
            a = line[i - 4] if i >= 4 else 0
            b = prev[i]
            c = prev[i - 4] if i >= 4 else 0
            x = line[i]
            if ftype == 1:   x += a
            elif ftype == 2: x += b
            elif ftype == 3: x += (a + b) >> 1
            elif ftype == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                x += a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
            line[i] = x & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, out


def alpha_bbox(w, h, px, min_alpha=8):
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        row = y * w * 4
        for x in range(w):
            if px[row + x * 4 + 3] >= min_alpha:
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    return x0, y0, x1, y1


def body_top(w, h, px, bbox, share=0.45):
    """First row where the art is wide — i.e. the pad, not the cable.

    At favicon size the trailing cable is noise; cropping to the pad keeps the
    silhouette readable at 32px.
    """
    x0, y0, x1, y1 = bbox
    span = x1 - x0 + 1
    for y in range(y0, y1 + 1):
        row = y * w * 4
        wide = sum(1 for x in range(x0, x1 + 1) if px[row + x * 4 + 3] >= 8)
        if wide >= span * share:
            return y
    return y0


# ----------------------------------------------------------------- render

def render(src, size, crop, fill=0.78, radius=0):
    """Composite `crop` of the source art onto a tile of `size`."""
    w, h, px = src
    cx0, cy0, cx1, cy1 = crop
    art_w, art_h = cx1 - cx0 + 1, cy1 - cy0 + 1

    target = size * fill
    scale = target / max(art_w, art_h)          # fit, never crop
    draw_w, draw_h = art_w * scale, art_h * scale
    off_x, off_y = (size - draw_w) / 2, (size - draw_h) / 2
    ss = 3                                       # supersampling per axis

    rows = []
    for py in range(size):
        row = bytearray()
        for px_i in range(size):
            r = g = b = a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    fx = px_i + (sx + 0.5) / ss
                    fy = py + (sy + 0.5) / ss
                    # Background gradient, then the art over it.
                    t = fy / size
                    br = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t
                    bg = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t
                    bb = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t
                    ba = 255.0
                    if radius and not inside_rrect(fx, fy, size, radius):
                        ba = 0.0
                    ax = int(cx0 + (fx - off_x) / scale)
                    ay = int(cy0 + (fy - off_y) / scale)
                    if cx0 <= ax <= cx1 and cy0 <= ay <= cy1:
                        i = (ay * w + ax) * 4
                        sa = px[i + 3] / 255
                        if sa:
                            br = px[i] * sa + br * (1 - sa)
                            bg = px[i + 1] * sa + bg * (1 - sa)
                            bb = px[i + 2] * sa + bb * (1 - sa)
                    r += br * (ba / 255); g += bg * (ba / 255); b += bb * (ba / 255); a += ba
            n = ss * ss
            if a > 0:
                cov = a / 255
                row += bytes((round(r / cov), round(g / cov), round(b / cov), round(a / n)))
            else:
                row += b"\x00\x00\x00\x00"
        rows.append(bytes(row))
    return rows


def inside_rrect(x, y, size, r):
    if not (0 <= x <= size and 0 <= y <= size):
        return False
    cx = min(max(x, r), size - r)
    cy = min(max(y, r), size - r)
    if r <= x <= size - r or r <= y <= size - r:
        return True
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)
    return len(png)


def main():
    root = pathlib.Path(__file__).resolve().parent.parent
    src = read_png(root / "joystick.png")
    w, h, px = src
    full = alpha_bbox(w, h, px)
    pad_only = (full[0], body_top(w, h, px, full), full[2], full[3])
    print(f"  art {full}  pad from y={pad_only[1]}")

    targets = [
        # name, size, crop, fill, corner radius
        ("apple-touch-icon.png", 180, full, 0.80, 0),
        ("icon-192.png", 192, full, 0.80, 0),
        ("icon-512.png", 512, full, 0.80, 0),
        # Android may crop a maskable icon to a circle, so inset the art.
        ("icon-maskable-512.png", 512, full, 0.62, 0),
        # The cable is noise at this size; crop to the pad.
        ("favicon-32.png", 32, pad_only, 0.92, 6),
        ("favicon-64.png", 64, pad_only, 0.92, 12),
    ]
    for name, size, crop, fill, radius in targets:
        rows = render(src, size, crop, fill=fill, radius=radius)
        n = write_png(root / name, rows, size)
        print(f"  {name:24} {size}x{size}  {n / 1024:.1f} KB")


if __name__ == "__main__":
    main()
