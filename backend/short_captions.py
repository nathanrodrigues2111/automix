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

from PIL import Image, ImageDraw, ImageFilter, ImageFont

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

    # Each line gets its OWN box hugging its width; consecutive boxes overlap
    # so they form one connected shape that steps in on shorter lines. To
    # smooth EVERY corner uniformly — the convex outer corners AND the concave
    # fillets where the width steps in — the union of sharp rectangles is built
    # as a mask, then blurred + thresholded (a blur past a 50% cut rounds any
    # corner by ~the blur radius). This is the TikTok/CapCut caption look.
    radius = int(max_fs * 0.42)
    padx = radius + int(max_fs * 0.14)
    pady = int(max_fs * 0.26)
    merge = radius + int(max_fs * 0.16)  # vertical overlap between line boxes
    blur = max(3, int(max_fs * 0.34))
    m = blur * 3  # margin so the rounding never clips at the canvas edge
    cap = (max_width - 2 * m) if max_width else 10 ** 9

    line_boxes = [(min(line_w + 2 * padx, cap), line_h + 2 * pady) for *_, line_w, line_h in prepared]
    inner_w = max(bw for bw, _ in line_boxes)
    tops: list[int] = []
    y = 0
    for _, bh in line_boxes:
        tops.append(y)
        y += bh - merge
    inner_h = tops[-1] + line_boxes[-1][1]
    canvas_w, canvas_h = inner_w + 2 * m, inner_h + 2 * m

    mask = Image.new("L", (canvas_w, canvas_h), 0)
    md = ImageDraw.Draw(mask)
    for (bw, bh), top in zip(line_boxes, tops):
        bx = m + (inner_w - bw) // 2
        md.rectangle([bx, m + top, bx + bw - 1, m + top + bh - 1], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(blur)).point(lambda p: 255 if p >= 128 else 0)

    img = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    img.paste(Image.new("RGBA", (canvas_w, canvas_h), (255, 255, 255, 255)), (0, 0), mask)
    d = ImageDraw.Draw(img)
    for (fs, f, runs, line_w, line_h), top in zip(prepared, tops):
        x = m + (inner_w - line_w) // 2
        ty = m + top + pady
        for kind, val, w, im in runs:
            if kind == "text":
                d.text((x, ty), val, font=f, fill=(0, 0, 0, 255))
            elif im is not None:
                img.alpha_composite(im, (x + int(fs * 0.04), ty + (line_h - im.height) // 2))
            x += w

    out_png.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_png)
    return canvas_w, canvas_h


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
