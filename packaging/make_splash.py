"""Generate packaging/splash.png — the PyInstaller boot splash (art only).

Background:
  * If assets/splash-screen-bg.mp4 exists, a frame from it is used as the
    background (local machines only — the video is gitignored and never present
    in public CI builds, which therefore fall back to the gradient below).
  * Otherwise a clean navy gradient.

The AUTOMIX wordmark + accent underline are drawn on top. The creator name +
version are NOT drawn here — app.py renders them as live splash text at runtime
(bottom-left, alongside the boot status), so they stay dynamic.

Run from the repo root:  uv run --with pillow python packaging/make_splash.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "packaging" / "splash.png"
VIDEO = ROOT / "assets" / "splash-screen-bg.mp4"

W, H = 640, 380
TOP = (15, 22, 38)         # deep navy, matches the app icon
BOT = (8, 12, 22)          # near-black
ACCENT = (59, 130, 246)    # the default Blue accent
TITLE = (236, 241, 249)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _ffmpeg() -> str | None:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    for cand in (ROOT / "bin" / "ffmpeg.exe", ROOT / "bin" / "ffmpeg",
                 Path.home() / ".local" / "bin" / "ffmpeg"):
        if cand.is_file():
            return str(cand)
    return None


def _cover(im: Image.Image, w: int, h: int) -> Image.Image:
    """Scale to fully cover w x h, then center-crop."""
    scale = max(w / im.width, h / im.height)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))),
                   Image.LANCZOS)
    x = (im.width - w) // 2
    y = (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def _video_background() -> Image.Image | None:
    """Extract a frame from the splash video and dress it for legibility."""
    ff = _ffmpeg()
    if not VIDEO.is_file() or not ff:
        return None
    t = os.environ.get("AUTOMIX_SPLASH_T", "8")
    try:
        with tempfile.TemporaryDirectory() as td:
            frame = Path(td) / "frame.png"
            subprocess.run(
                [ff, "-y", "-ss", str(t), "-i", str(VIDEO), "-frames:v", "1",
                 str(frame)],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            bg = Image.open(frame).convert("RGB")
    except Exception:
        return None

    bg = _cover(bg, W, H)
    # Global darken so the wordmark/text read over the artwork.
    scrim = Image.new("RGBA", (W, H), (5, 8, 16, 120))
    bg = Image.alpha_composite(bg.convert("RGBA"), scrim)
    # Stronger gradient at the bottom for the runtime credit/status text.
    grad = Image.new("L", (1, H), 0)
    gp = grad.load()
    for y in range(H):
        t2 = max(0.0, (y - H * 0.55) / (H * 0.45))
        gp[0, y] = int(180 * (t2 ** 1.4))
    grad = grad.resize((W, H))
    bg = Image.alpha_composite(
        bg, Image.merge("RGBA", (
            Image.new("L", (W, H), 5), Image.new("L", (W, H), 8),
            Image.new("L", (W, H), 16), grad))
    )
    return bg.convert("RGB")


def _gradient_background() -> Image.Image:
    img = Image.new("RGB", (W, H), TOP)
    px = img.load()
    for y in range(H):
        c = lerp(TOP, BOT, y / (H - 1))
        for x in range(W):
            px[x, y] = c
    glow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(glow).ellipse((W // 2 - 150, 30, W // 2 + 150, 270), fill=60)
    glow = glow.filter(ImageFilter.GaussianBlur(60))
    img.paste(Image.new("RGB", (W, H), (26, 46, 84)), (0, 0), glow)
    return img


video_bg = _video_background()
img = video_bg if video_bg is not None else _gradient_background()
draw = ImageDraw.Draw(img)

# --- App icon (logo), centered, with a soft glow so it reads on any bg ------
icon = Image.open(ROOT / "frontend" / "public" / "favicon.png").convert("RGBA")
icon = icon.resize((116, 116), Image.LANCZOS)
halo = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(halo).ellipse((W // 2 - 74, 44, W // 2 + 74, 192),
                             fill=(0, 0, 0, 150 if video_bg is not None else 120))
halo = halo.filter(ImageFilter.GaussianBlur(22))
img.paste(halo, (0, 0), halo)
img.paste(icon, (W // 2 - 58, 60), icon)
draw = ImageDraw.Draw(img)

# --- Wordmark + accent underline (with a shadow so it reads on any bg) -------
bebas = ImageFont.truetype(str(ROOT / "assets" / "fonts" / "BebasNeue-Regular.ttf"), 76)
title = "AUTOMIX"
tw = draw.textlength(title, font=bebas)
tx, ty = (W - tw) / 2, 202
if video_bg is not None:
    glowt = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glowt).text((tx, ty), title, font=bebas, fill=(0, 0, 0, 220))
    glowt = glowt.filter(ImageFilter.GaussianBlur(8))
    img.paste(glowt, (0, 0), glowt)
    draw = ImageDraw.Draw(img)
draw.text((tx, ty), title, font=bebas, fill=TITLE)
draw.rounded_rectangle((W // 2 - 56, 288, W // 2 + 56, 292), radius=2, fill=ACCENT)

img.save(OUT)
kind = "video frame" if video_bg is not None else "gradient"
print(f"wrote {OUT} ({W}x{H}) — background: {kind}")
