#!/usr/bin/env python3
"""Generate Ruby's macOS app icon from the 3D gem art.

Pipeline:
  1. Knock out the white background (corner-seeded flood fill, so interior
     whites — the eyes, the facet highlights — are preserved).
  2. Trim to the gem and scale it to sit on the tile with even padding.
  3. Composite onto a cream "squircle" (rounded-rect) tile — the macOS
     Big Sur+ convention — drawn at 4x and downsampled for clean edges.
  4. Emit an .iconset (16…1024 @1x/@2x) and run iconutil → icon.icns.
     Also writes icon.png (1024) for the dev-mode dock icon.

Usage: python3 scripts/make-icon.py [SOURCE_PNG]
Default source: build/icon-source.png (the 3D gem art, checked into the repo).
"""
import os
import subprocess
import sys
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "..", "build")
SRC = (os.path.expanduser(sys.argv[1]) if len(sys.argv) > 1
       else os.path.join(BUILD, "icon-source.png"))

CREAM = (250, 247, 233, 255)   # --cream #faf7e9
CANVAS = 1024
SS = 4                          # supersample factor for crisp squircle edges
TILE_RATIO = 0.92               # squircle fills 92% of the canvas
CORNER_RATIO = 0.2237           # Apple-ish squircle corner radius / side
GEM_RATIO = 0.66                # gem's longest side / tile side


def knockout_white(img: Image.Image) -> Image.Image:
    """Make the connected white background transparent, corner-seeded."""
    rgb = img.convert("RGB")
    magic = (255, 0, 255)
    w, h = img.width, img.height
    # Seed from the corners AND the edge midpoints, with a generous threshold,
    # so the original's faint shadow/reflection gradient (near-white, but darker
    # than the corners) gets swept too. Interior whites (eyes, facet highlights)
    # are red-bounded and never reached from the edges.
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for seed in seeds:
        ImageDraw.floodfill(rgb, seed, magic, thresh=72)
    out = img.convert("RGBA")
    px_rgb = rgb.load()
    px_out = out.load()
    for y in range(img.height):
        for x in range(img.width):
            if px_rgb[x, y] == magic:
                px_out[x, y] = (0, 0, 0, 0)
    return out


def trim(img: Image.Image) -> Image.Image:
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def squircle(side: int, radius: int, fill) -> Image.Image:
    tile = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)
    d.rounded_rectangle([0, 0, side - 1, side - 1], radius=radius, fill=fill)
    return tile


def build() -> Image.Image:
    gem = trim(knockout_white(Image.open(SRC)))

    big = CANVAS * SS
    tile_side = int(big * TILE_RATIO)
    radius = int(tile_side * CORNER_RATIO)
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    tile = squircle(tile_side, radius, CREAM)
    # Soft contact shadow so the tile reads as a real icon against any dock.
    shadow = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    sh = squircle(tile_side, radius, (60, 40, 20, 70))
    shadow.paste(sh, ((big - tile_side) // 2, (big - tile_side) // 2 + int(big * 0.012)), sh)
    shadow = shadow.filter(ImageFilter.GaussianBlur(big * 0.012))
    canvas = Image.alpha_composite(canvas, shadow)

    tile_layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    tile_layer.paste(tile, ((big - tile_side) // 2, (big - tile_side) // 2), tile)
    canvas = Image.alpha_composite(canvas, tile_layer)

    target = int(tile_side * GEM_RATIO)
    scale = target / max(gem.width, gem.height)
    gem = gem.resize((max(1, int(gem.width * scale)), max(1, int(gem.height * scale))),
                     Image.LANCZOS)
    gx = (big - gem.width) // 2
    gy = (big - gem.height) // 2
    gem_layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    gem_layer.paste(gem, (gx, gy), gem)
    canvas = Image.alpha_composite(canvas, gem_layer)

    return canvas.resize((CANVAS, CANVAS), Image.LANCZOS)


def main() -> None:
    os.makedirs(BUILD, exist_ok=True)
    master = build()
    master.save(os.path.join(BUILD, "icon.png"))

    iconset = os.path.join(BUILD, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    specs = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2),
             (256, 1), (256, 2), (512, 1), (512, 2)]
    for size, scale in specs:
        px = size * scale
        name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
        master.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, name))

    subprocess.run(
        ["iconutil", "-c", "icns", iconset, "-o", os.path.join(BUILD, "icon.icns")],
        check=True,
    )
    print("Wrote build/icon.icns and build/icon.png")


if __name__ == "__main__":
    main()
