#!/usr/bin/env python3
"""Regenerate the launcher icons + the 320x180 Android TV banner from the PWA icon.

Usage (from the repo root):  python3 -I android/tools/make_icons.py
Needs Pillow. Source: web/public/icon-512.png. Output: android/app/src/main/res/.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "web", "public", "icon-512.png")
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
BG = (0x05, 0x07, 0x0A, 255)
FONTS = (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
)

ICON_SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}


def font(size):
    for path in FONTS:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def rounded(icon):
    """icon-512.png has opaque WHITE corners: cut them with a rounded-square mask
    (4x supersampled for a smooth edge) so the icon sits cleanly on a dark bg."""
    w, h = icon.size
    big = Image.new("L", (w * 4, h * 4), 0)
    ImageDraw.Draw(big).rounded_rectangle((16, 16, w * 4 - 17, h * 4 - 17), radius=int(w * 4 * 0.215), fill=255)
    out = icon.copy()
    out.putalpha(big.resize((w, h), Image.LANCZOS))
    return out


def main():
    icon = rounded(Image.open(SRC).convert("RGBA"))

    for density, px in ICON_SIZES.items():
        out = os.path.join(RES, f"mipmap-{density}", "ic_launcher.png")
        icon.resize((px, px), Image.LANCZOS).save(out, optimize=True)

    # Banner: 320x180 at xhdpi (the size Android TV expects), dark bg, icon left, wordmark right.
    w, h = 320, 180
    banner = Image.new("RGBA", (w, h), BG)
    side = 112
    mark = icon.resize((side, side), Image.LANCZOS)
    f = font(30)
    text = "NEOWATCH"
    draw = ImageDraw.Draw(banner)
    tw = draw.textbbox((0, 0), text, font=f)
    text_w, text_h = tw[2] - tw[0], tw[3] - tw[1]
    gap = 12
    total = side + gap + text_w
    x0 = (w - total) // 2
    banner.alpha_composite(mark, (x0, (h - side) // 2))
    draw.text((x0 + side + gap, (h - text_h) // 2 - tw[1]), text, font=f, fill=(0xE6, 0xF7, 0xFA, 255))
    banner.convert("RGB").save(os.path.join(RES, "drawable-xhdpi", "banner.png"), optimize=True)
    print("icons + banner written to", RES)


if __name__ == "__main__":
    sys.exit(main())
