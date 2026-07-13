"""Generate packaging/splash.png — the PyInstaller boot splash.

Run from the repo root:  uv run --with pillow python packaging/make_splash.py
(any Python with Pillow works; fonts and the icon come from the repo)
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "packaging" / "splash.png"

W, H = 640, 380
BG = (9, 14, 24)          # deep navy, matches the app icon
ACCENT = (59, 130, 246)   # the default Blue accent
TITLE = (235, 240, 248)
SUB = (125, 138, 160)

img = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(img)

# Subtle vertical glow behind the icon so the card isn't flat.
glow = Image.new("L", (W, H), 0)
gd = ImageDraw.Draw(glow)
gd.ellipse((W // 2 - 220, 20, W // 2 + 220, 300), fill=26)
glow = glow.resize((W // 4, H // 4)).resize((W, H))  # cheap blur
img.paste(Image.new("RGB", (W, H), (23, 37, 66)), (0, 0), glow)
draw = ImageDraw.Draw(img)

# App icon, centered.
icon = Image.open(ROOT / "frontend" / "public" / "favicon.png").convert("RGBA")
icon = icon.resize((108, 108), Image.LANCZOS)
img.paste(icon, (W // 2 - 54, 64), icon)

# Wordmark + tagline.
bebas = ImageFont.truetype(str(ROOT / "assets" / "fonts" / "BebasNeue-Regular.ttf"), 56)
small = ImageFont.truetype(str(ROOT / "assets" / "fonts" / "BebasNeue-Regular.ttf"), 20)

title = "AUTOMIX"
tw = draw.textlength(title, font=bebas)
draw.text(((W - tw) / 2, 192), title, font=bebas, fill=TITLE)

tag = "EDM DROP-MIX BUILDER"
tw = draw.textlength(tag, font=small)
draw.text(((W - tw) / 2, 262), tag, font=small, fill=SUB)

# Accent underline between wordmark and tagline.
draw.rounded_rectangle((W // 2 - 36, 252, W // 2 + 36, 255), radius=2, fill=ACCENT)

# Bottom hairline; the live status text (pyi_splash) renders just above it.
draw.rectangle((0, H - 2, W, H), fill=(17, 26, 44))

img.save(OUT)
print(f"wrote {OUT} ({W}x{H})")
