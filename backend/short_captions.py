"""Render Short captions as PNG overlays.

libass can't draw rounded boxes or color emoji, so the vertical Short's
captions (custom title, per-drop track name, end card) are rendered with
Pillow instead: a rounded white box, bold text in the chosen font, and inline
color emoji from Noto Color Emoji. The renderer returns transparent PNGs that
render.py overlays on the video at computed positions and time windows.
"""

from __future__ import annotations

import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Noto Color Emoji ships one 109px bitmap strike; render at that ppem then
# scale down to the caption size.
_NOTO_PPEM = 109

# Rough emoji / pictographic + variation-selector ranges. Good enough to split
# a caption into text vs emoji runs.
_EMOJI = re.compile(
    "([\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "\U00002B00-\U00002BFF\U00002190-\U000021FF\U0000FE00-\U0000FE0F"
    "\U00002000-\U0000206F\U00002300-\U000023FF]+)"
)


def _is_emoji_run(s: str) -> bool:
    return bool(_EMOJI.fullmatch(s))


def _emoji_image(ch: str, size: int, emoji_font: Path) -> Image.Image | None:
    try:
        f = ImageFont.truetype(str(emoji_font), _NOTO_PPEM)
        # Generous margin: some emoji (e.g. 🥰 with side hearts) have ink that
        # extends well beyond the em square; a tight canvas clips them before
        # the bbox crop.
        pad = 70
        side = _NOTO_PPEM + 2 * pad
        tmp = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        ImageDraw.Draw(tmp).text((pad, pad), ch, font=f, embedded_color=True)
        bbox = tmp.getbbox()
        if not bbox:
            return None
        tmp = tmp.crop(bbox)
        scale = size / tmp.height
        return tmp.resize((max(1, round(tmp.width * scale)), size), Image.LANCZOS)
    except Exception:
        return None


def _measure_runs(
    text: str, fs: int, font: "ImageFont.FreeTypeFont", emoji_font: Path | None,
) -> tuple[list[tuple[str, str, int, Image.Image | None]], int]:
    runs: list[tuple[str, str, int, Image.Image | None]] = []
    total = 0
    em_size = int(fs * 1.02)
    for part in _EMOJI.split(text):
        if not part:
            continue
        if _is_emoji_run(part):
            for ch in part:
                if ch in "️︎":
                    continue
                im = _emoji_image(ch, em_size, emoji_font) if emoji_font else None
                if im is None:
                    continue
                w = im.width + int(fs * 0.08)
                runs.append(("emoji", ch, w, im))
                total += w
        else:
            w = int(font.getlength(part))
            runs.append(("text", part, w, None))
            total += w
    return runs, total


def render_block(
    lines: list[tuple[str, int]],
    font_path: Path,
    out_png: Path,
    emoji_font: Path | None = None,
    max_width: int | None = None,
) -> tuple[int, int]:
    """Render a caption BLOCK to a transparent PNG: ONE rounded white box
    wrapping every line, bold black text + inline color emoji, each line
    centered. `lines` is a list of (text, font_size). Returns (width, height)."""
    prepared = []  # (fs, font, runs, line_w, line_h)
    max_fs = 1
    for text, fs in lines:
        text = " ".join(text.split())
        if not text:
            continue
        f = ImageFont.truetype(str(font_path), fs)
        asc, desc = f.getmetrics()
        runs, total = _measure_runs(text, fs, f, emoji_font)
        prepared.append((fs, f, runs, total, asc + desc))
        max_fs = max(max_fs, fs)
    if not prepared:
        prepared = [(48, ImageFont.truetype(str(font_path), 48), [], 0, 48)]

    # Corner radius drives the padding: content must sit clear of the rounded
    # corners or glyphs at the edges (esp. wide emoji) get clipped by the arc.
    radius0 = int(max_fs * 0.42)
    padx = radius0 + int(max_fs * 0.16)  # clears the corner, but hugs tighter
    pady = int(max_fs * 0.3)
    gap = int(max_fs * 0.12)
    content_w = max(w for _, _, _, w, _ in prepared)
    box_w = content_w + 2 * padx
    if max_width:
        box_w = min(box_w, max_width)
    box_h = sum(lh for *_, lh in prepared) + gap * (len(prepared) - 1) + 2 * pady

    img = Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = min(radius0, box_h // 2, box_w // 2)
    d.rounded_rectangle([0, 0, box_w - 1, box_h - 1], radius=radius,
                        fill=(255, 255, 255, 255))

    y = pady
    for fs, f, runs, line_w, line_h in prepared:
        x = (box_w - line_w) // 2
        for kind, val, w, im in runs:
            if kind == "text":
                d.text((x, y), val, font=f, fill=(0, 0, 0, 255))
            elif im is not None:
                img.alpha_composite(im, (x + int(fs * 0.04), y + (line_h - im.height) // 2))
            x += w
        y += line_h + gap

    out_png.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_png)
    return box_w, box_h


def render_caption(
    text: str, font_path: Path, fs: int, out_png: Path,
    emoji_font: Path | None = None, max_width: int | None = None,
) -> tuple[int, int]:
    """Single-line convenience wrapper around render_block."""
    return render_block([(text, fs)], font_path, out_png, emoji_font, max_width)


def fit_font_size(text: str, font_path: Path, max_px: int, base: int = 90,
                  min_fs: int = 44) -> int:
    """Largest font size (<= base) whose rendered width fits max_px."""
    plain = _EMOJI.sub("", text)
    n_emoji = sum(len(m) for m in _EMOJI.findall(text))
    fs = base
    while fs > min_fs:
        f = ImageFont.truetype(str(font_path), fs)
        if int(f.getlength(plain)) + n_emoji * fs <= max_px:
            return fs
        fs -= 4
    return min_fs


def wrap_text(text: str, fs: int, font_path: Path, max_px: int) -> list[str]:
    """Greedy word-wrap so each line fits within max_px (measured with the real
    font). Emoji count as ~one wide character."""
    font = ImageFont.truetype(str(font_path), fs)

    def width(s: str) -> int:
        # Strip emoji for measuring (they're roughly square ~fs wide each).
        plain = _EMOJI.sub("", s)
        n_emoji = sum(len(m) for m in _EMOJI.findall(s))
        return int(font.getlength(plain)) + n_emoji * fs

    words = text.split()
    lines: list[str] = []
    cur = ""
    for word in words:
        trial = (cur + " " + word).strip()
        if cur and width(trial) > max_px:
            lines.append(cur)
            cur = word
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines or [text]
