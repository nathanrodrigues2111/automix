# NOTE: This module uses pyrubberband which requires the `rubberband` CLI binary
# to be available on PATH. On Debian/Ubuntu install with:
#   sudo apt-get install rubberband-cli
# If the binary is missing at runtime, time-stretching is skipped and the
# original clip BPM is used (mix will still render but beats may not align).
from __future__ import annotations

import json
import os
import random
import re
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np

import analysis as analysis_mod
import db
import paths
import youtube as youtube_mod

BACKEND_DIR = Path(__file__).parent
PROJECT_ROOT = BACKEND_DIR.parent
VIDEOS_DIR = paths.VIDEOS_DIR
EXPORTS_DIR = VIDEOS_DIR / "exports"
RENDER_TMP_DIR = paths.CACHE_DIR / "renders"
ASSETS_DIR = paths.ASSETS_DIR
LOGO_PATH = ASSETS_DIR / "edmpapa11.png"
BARS_PATH = ASSETS_DIR / "black-bars.png"
FONTS_DIR = ASSETS_DIR / "fonts"
DEFAULT_FONT_ID = "BebasNeue-Regular"

# EDMPAPA branding geometry (1920x1080 canvas).
_BRAND_W = 1920
_BRAND_H = 1080
_BAR_H = 140
_LOGO_H = 84
_TITLE_FONT_SIZE = 56
_LOGO_MARGIN_RIGHT = 48

ProgressCb = Callable[[str, float, str], None] | None


def font_family(path: Path) -> str | None:
    """Family name from the font's name table (what libass matches Style
    Fontname against). None if the file isn't a parseable font."""
    try:
        from fontTools.ttLib import TTFont

        f = TTFont(str(path), lazy=True)
        name = f["name"].getDebugName(1)
        f.close()
        return str(name) if name else path.stem
    except Exception:
        return None


def list_fonts() -> list[dict[str, str]]:
    """Selectable title fonts: every .ttf/.otf in assets/fonts (built-ins
    plus user uploads)."""
    fonts: list[dict[str, str]] = []
    if FONTS_DIR.is_dir():
        for p in sorted(FONTS_DIR.iterdir(), key=lambda q: q.name.lower()):
            if p.suffix.lower() not in (".ttf", ".otf"):
                continue
            fam = font_family(p)
            if fam:
                fonts.append({"id": p.stem, "family": fam, "file": p.name})
    return fonts


def resolve_title_font(font_id: str | None) -> tuple[Path, str] | None:
    """(path, family) for a font id (file stem in assets/fonts). Unknown or
    missing ids fall back to the default font, then to any available one."""
    fonts = {f["id"]: f for f in list_fonts()}
    for fid in (str(font_id or "").strip() or DEFAULT_FONT_ID, DEFAULT_FONT_ID):
        f = fonts.get(fid)
        if f:
            return FONTS_DIR / f["file"], f["family"]
    if fonts:
        f = next(iter(fonts.values()))
        return FONTS_DIR / f["file"], f["family"]
    return None


def _has_rubberband() -> bool:
    return shutil.which("rubberband") is not None


def _bars_to_seconds(bars: float, bpm: float, beats_per_bar: int = 4) -> float:
    if bpm <= 0:
        return 0.0
    return (bars * beats_per_bar) * (60.0 / bpm)


def _snap_to_downbeat(t: float, downbeats: list[float]) -> float:
    if not downbeats:
        return t
    return min(downbeats, key=lambda d: abs(float(d) - t))


def _camelot_semitone_shift(src: str, dst: str) -> int:
    """Smallest semitone shift to take `src` Camelot key to `dst`. Returns int in [-6, 6]."""
    if not src or not dst or len(src) < 2 or len(dst) < 2:
        return 0
    try:
        ns, ms = int(src[:-1]), src[-1].upper()
        nd, md = int(dst[:-1]), dst[-1].upper()
    except ValueError:
        return 0
    # Each Camelot number step = perfect fifth = +7 semitones.
    semi = ((nd - ns) * 7) % 12
    # A (minor) ↔ B (major) of same number = +3 semitones (relative major).
    if ms == "A" and md == "B":
        semi = (semi + 3) % 12
    elif ms == "B" and md == "A":
        semi = (semi - 3) % 12
    if semi > 6:
        semi -= 12
    return semi


def _pitch_shift_wav(in_wav: Path, out_wav: Path, semitones: float) -> None:
    import soundfile as sf

    if abs(semitones) < 0.05 or not _has_rubberband():
        if in_wav != out_wav:
            shutil.copy(in_wav, out_wav)
        return
    y, sr = sf.read(str(in_wav), always_2d=True)
    import pyrubberband as pyrb
    shifted = [pyrb.pitch_shift(y[:, c], sr, semitones) for c in range(y.shape[1])]
    minlen = min(len(c) for c in shifted)
    out = np.stack([c[:minlen] for c in shifted], axis=1)
    sf.write(str(out_wav), out, sr, subtype="FLOAT")


# Output canvas presets (16:9). Proxy renders force 720p regardless.
_RESOLUTIONS: dict[str, tuple[int, int]] = {
    "480p": (854, 480),
    "720p": (1280, 720),
    "1080p": (1920, 1080),
    "1440p": (2560, 1440),
    "2160p": (3840, 2160),
}


def _x264_encode_args(proxy: bool, intermediate: bool = False) -> list[str]:
    """Encoder settings only — for use after a -filter_complex chain or any
    case where the video has already been normalized. `intermediate` picks a
    much faster preset for outputs that get re-encoded again downstream
    (visually transparent at crf 16, big render-time win)."""
    if proxy:
        return ["-c:v", "libx264", "-crf", "28", "-preset", "ultrafast"]
    if intermediate:
        return ["-c:v", "libx264", "-crf", "16", "-preset", "veryfast"]
    return ["-c:v", "libx264", "-crf", "17", "-preset", "medium"]


def _x264_args(
    proxy: bool,
    canvas: tuple[int, int] | None = None,
    intermediate: bool = False,
) -> list[str]:
    """Full args: scale to a consistent resolution + encode. Used by trim/concat
    to ensure clips have IDENTICAL dimensions before downstream filters —
    xfade errors out on mismatched inputs, so crop-fill to a fixed canvas
    (plain scale=-2:H keeps the source aspect and widths then differ)."""
    w, h = (1280, 720) if proxy else (canvas or (_BRAND_W, _BRAND_H))
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"
    return ["-vf", vf, *_x264_encode_args(proxy, intermediate)]


def _trim_video_clip(
    src: Path,
    start_s: float,
    duration_s: float,
    out: Path,
    proxy: bool = False,
    canvas: tuple[int, int] | None = None,
    ratio: float = 1.0,
) -> None:
    """Trim + crop-fill + (optionally) time-stretch a clip's VIDEO in one
    encode. Fusing the setpts stretch here saves a full second encode per
    clip. Audio is handled separately, so none is kept. A constant fps keeps
    all clips IDENTICAL for the concat/xfade stage."""
    out.parent.mkdir(parents=True, exist_ok=True)
    w, h = (1280, 720) if proxy else (canvas or (_BRAND_W, _BRAND_H))
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"
    if abs(ratio - 1.0) > 0.005:
        vf += f",setpts={ratio:.6f}*PTS"
    vf += ",fps=30"
    cmd = [
        "ffmpeg", "-y", "-ss", f"{start_s:.3f}", "-i", str(src),
        "-t", f"{duration_s:.3f}",
        "-vf", vf,
        "-an",
        *_x264_encode_args(proxy, intermediate=True),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _extract_clip_audio(src: Path, start_s: float, duration_s: float, out_wav: Path, sr: int = 44100) -> None:
    # float32 end to end: hot sources decode above full scale, and 16-bit
    # anywhere in the chain hard-clips them before the gain-down.
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-ss", f"{start_s:.3f}", "-i", str(src),
        "-t", f"{duration_s:.3f}",
        "-vn", "-ac", "2", "-ar", str(sr), "-acodec", "pcm_f32le",
        str(out_wav),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _time_stretch_wav(in_wav: Path, out_wav: Path, ratio: float) -> None:
    """Time-stretch. ratio = target_duration / source_duration.

    Prefers rubberband; falls back to ffmpeg's atempo filter, which is
    pitch-preserving and sounds clean for the small beat-matching ratios
    (±8%) this pipeline uses."""
    if abs(ratio - 1.0) < 0.005:
        shutil.copy(in_wav, out_wav)
        return
    if _has_rubberband():
        import soundfile as sf
        y, sr = sf.read(str(in_wav), always_2d=True)
        import pyrubberband as pyrb
        # pyrb.time_stretch's "rate" speeds up audio: rate>1 -> shorter.
        # If we want output duration = ratio * input_duration -> rate = 1/ratio.
        rate = 1.0 / ratio
        stretched_channels = [pyrb.time_stretch(y[:, c], sr, rate) for c in range(y.shape[1])]
        minlen = min(len(c) for c in stretched_channels)
        out = np.stack([c[:minlen] for c in stretched_channels], axis=1)
        sf.write(str(out_wav), out, sr, subtype="FLOAT")
        return
    # atempo factor is a speed multiplier (>1 = faster/shorter); valid 0.5-100.
    tempo = max(0.5, min(2.0, 1.0 / ratio))
    cmd = [
        "ffmpeg", "-y", "-i", str(in_wav),
        "-af", f"atempo={tempo:.6f}",
        "-ar", "44100", "-ac", "2", "-acodec", "pcm_f32le", str(out_wav),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    # atempo's output drifts by ~15-20ms per clip; seams are sample-math, so
    # pin the result to the exact expected length (pad/trim at the tail).
    import soundfile as sf
    src_info = sf.info(str(in_wav))
    expected = int(round(src_info.frames * (44100 / src_info.samplerate) * ratio))
    y, out_sr = sf.read(str(out_wav), always_2d=True)
    if len(y) > expected:
        y = y[:expected]
    elif len(y) < expected:
        y = np.vstack([y, np.zeros((expected - len(y), y.shape[1]), dtype=y.dtype)])
    sf.write(str(out_wav), y, out_sr, subtype="FLOAT")


def _loudnorm_two_pass(in_wav: Path, out_wav: Path, target_lufs: float) -> None:
    """Two-pass ffmpeg loudnorm for accurate target."""
    import re

    # Pass 1: measure
    cmd1 = [
        "ffmpeg", "-i", str(in_wav),
        "-af", f"loudnorm=I={target_lufs}:LRA=11:TP=-1.5:print_format=json",
        "-f", "null", "-",
    ]
    p1 = subprocess.run(cmd1, capture_output=True)
    stderr = p1.stderr.decode("utf-8", errors="ignore")
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr)
    if not m:
        shutil.copy(in_wav, out_wav)
        return
    try:
        data = json.loads(m.group(0))
    except Exception:
        shutil.copy(in_wav, out_wav)
        return
    af = (
        f"loudnorm=I={target_lufs}:LRA=11:TP=-1.5:"
        f"measured_I={data['input_i']}:measured_LRA={data['input_lra']}:"
        f"measured_TP={data['input_tp']}:measured_thresh={data['input_thresh']}:"
        f"offset={data['target_offset']}:linear=true:print_format=summary"
    )
    cmd2 = [
        "ffmpeg", "-y", "-i", str(in_wav), "-af", af,
        "-ar", "44100", "-ac", "2", str(out_wav),
    ]
    subprocess.run(cmd2, check=True, capture_output=True)


def _measure_loudness(path: Path) -> dict[str, float] | None:
    """Integrated LUFS + true peak of an audio file (loudnorm measure pass)."""
    import re

    cmd = [
        "ffmpeg", "-i", str(path),
        "-af", "loudnorm=I=-14:LRA=11:TP=-1.5:print_format=json",
        "-f", "null", "-",
    ]
    p = subprocess.run(cmd, capture_output=True)
    stderr = p.stderr.decode("utf-8", errors="ignore")
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
        i = float(data["input_i"])
        tp = float(data["input_tp"])
    except Exception:
        return None
    if not (np.isfinite(i) and np.isfinite(tp)):
        return None
    return {"i": i, "tp": tp}


def _normalize_linear(in_wav: Path, out_wav: Path, target_lufs: float) -> None:
    """Loudness-normalize with a PURE linear gain. loudnorm's dynamic mode
    (single-pass, or two-pass when the linear gain would violate the TP
    ceiling) pumps and distorts loud EDM program — that's the "blown out"
    sound. A measured constant gain never alters dynamics; output is float32
    WAV so gained peaks keep full headroom (the final-mix limiter is the one
    place peaks get controlled)."""
    m = _measure_loudness(in_wav)
    gain_db = (target_lufs - m["i"]) if m else 0.0
    cmd = [
        "ffmpeg", "-y", "-i", str(in_wav),
        "-af", f"volume={gain_db:.4f}dB",
        "-ar", "44100", "-ac", "2", "-acodec", "pcm_f32le",
        str(out_wav),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _limit_peaks(wav: Path, ceiling_db: float = -1.2) -> None:
    """Length-preserving lookahead peak limiter (numpy, in place). Engages
    only above the ceiling, so normal program passes bit-identical — it's a
    safety net for crossfade overlap sums, not a loudness tool. ffmpeg's
    alimiter is avoided because its lookahead delays the stream a few ms,
    which would break the sample-exact seam math."""
    import soundfile as sf
    from scipy.ndimage import minimum_filter1d, uniform_filter1d

    ceiling = 10.0 ** (ceiling_db / 20.0)
    y, sr = sf.read(str(wav), always_2d=True, dtype="float32")
    mag = np.max(np.abs(y), axis=1)
    peak = float(mag.max()) if mag.size else 0.0
    if peak <= ceiling:
        return
    need = np.minimum(1.0, ceiling / np.maximum(mag, 1e-9))
    # The min-filter window must be WIDER than the smoothing window, or the
    # smoothing averages the dip back up and the transient hard-clips at the
    # np.clip below instead of limiting cleanly. Wide min (~50ms) + short
    # smooth (~6ms ramps) preserves full dip depth at the peak.
    la = max(1, int(0.003 * sr))
    win = max(1, int(0.050 * sr))
    g = minimum_filter1d(need, size=win + 2 * la, mode="nearest")
    g = uniform_filter1d(g, size=2 * la + 1, mode="nearest")
    y *= g[:, None]
    # Smoothing can overshoot the ceiling by a hair right at a peak — the
    # final clip is a guarantee, engaging only within fractions of a dB.
    np.clip(y, -ceiling, ceiling, out=y)
    sf.write(str(wav), y, sr, subtype="FLOAT")


def _equal_power_crossfade(a_wav: Path, b_wav: Path, crossfade_s: float, out_wav: Path) -> None:
    import soundfile as sf

    a, sr = sf.read(str(a_wav), always_2d=True)
    b, sr_b = sf.read(str(b_wav), always_2d=True)
    if sr != sr_b:
        raise RuntimeError("sample rate mismatch in crossfade")
    n_fade = int(crossfade_s * sr)
    n_fade = min(n_fade, len(a), len(b))
    if n_fade <= 0:
        out = np.concatenate([a, b], axis=0)
        sf.write(str(out_wav), out, sr, subtype="FLOAT")
        return
    fade = np.linspace(0, np.pi / 2, n_fade)
    # Asymmetric blend: the outgoing decays fast while the incoming rises
    # early, so the incoming vocal/riser reads clearly. The duck factor
    # RAMPS in with the fade (1.0 -> 0.75) — a constant 0.75 made the
    # outgoing level step down instantly at fade start, which sounds like
    # a click/clip at every transition.
    duck = (1.0 - 0.25 * np.sin(fade))[:, None]
    fade_out = (np.cos(fade) ** 1.6)[:, None] * duck
    fade_in = (np.sin(fade) ** 0.85)[:, None]
    tail = a[-n_fade:] * fade_out
    head = b[:n_fade] * fade_in
    # No peak clamp here: the mix stays float (full headroom) and the final
    # limiter handles the rare overlap sum above the ceiling. Scaling the
    # whole crossfade region down audibly ducked transitions.
    mixed = tail + head
    out = np.concatenate([a[:-n_fade], mixed, b[n_fade:]], axis=0)
    sf.write(str(out_wav), out, sr, subtype="FLOAT")


def _eq_bass_swap_crossfade(
    a_stems: dict[str, Path], b_stems: dict[str, Path], crossfade_s: float, out_wav: Path
) -> None:
    """Outgoing track keeps drums+vocals+other crossfading out; bass HARD-SWAPS at midpoint
    (short ramp to avoid click). Eliminates dual-bassline mud."""
    import soundfile as sf

    def _load(p: Path):
        y, sr = sf.read(str(p), always_2d=True)
        return y, sr

    a_d, sr = _load(a_stems["drums"])
    a_b, _ = _load(a_stems["bass"])
    a_v, _ = _load(a_stems["vocals"])
    a_o, _ = _load(a_stems["other"])
    b_d, _ = _load(b_stems["drums"])
    b_b, _ = _load(b_stems["bass"])
    b_v, _ = _load(b_stems["vocals"])
    b_o, _ = _load(b_stems["other"])

    a_full = a_d + a_b + a_v + a_o
    b_full = b_d + b_b + b_v + b_o
    n_fade = int(crossfade_s * sr)
    n_fade = min(n_fade, len(a_full), len(b_full))
    if n_fade <= 0:
        sf.write(str(out_wav), np.concatenate([a_full, b_full], axis=0), sr)
        return

    half = n_fade // 2
    ramp = min(half // 2, int(sr * 0.05))  # 50 ms or 1/4 of half, whichever smaller

    a_t_d, a_t_b, a_t_v, a_t_o = a_d[-n_fade:], a_b[-n_fade:], a_v[-n_fade:], a_o[-n_fade:]
    b_h_d, b_h_b, b_h_v, b_h_o = b_d[:n_fade], b_b[:n_fade], b_v[:n_fade], b_o[:n_fade]

    x = np.linspace(0, np.pi / 2, n_fade)
    fout = np.cos(x)[:, None]
    fin = np.sin(x)[:, None]

    # Drums + vocals + other: equal-power crossfade with a RAMPED duck on
    # the outgoing tail (a constant factor steps the level at fade start).
    duck = (1.0 - 0.21 * np.sin(x))[:, None]
    tail = (a_t_d + a_t_v + a_t_o) * fout * duck
    head = (b_h_d + b_h_o) * fin + b_h_v * fin * 1.12

    # Bass: a-bass full until midpoint, b-bass full after — short ramp at the swap point.
    n_ch = a_t_b.shape[1]
    bass = np.zeros((n_fade, n_ch))
    if ramp > 0 and half - ramp > 0 and half + ramp <= n_fade:
        bass[: half - ramp] = a_t_b[: half - ramp]
        rx = np.linspace(0, np.pi / 2, ramp)
        bass[half - ramp : half] = a_t_b[half - ramp : half] * np.cos(rx)[:, None]
        bass[half : half + ramp] = b_h_b[half : half + ramp] * np.sin(rx)[:, None]
        bass[half + ramp :] = b_h_b[half + ramp :]
    else:
        bass[:half] = a_t_b[:half]
        bass[half:] = b_h_b[half:]

    mixed = tail + head + bass
    out = np.concatenate([a_full[:-n_fade], mixed, b_full[n_fade:]], axis=0)
    sf.write(str(out_wav), out, sr, subtype="FLOAT")


def _stem_aware_crossfade(
    a_stems: dict[str, Path], b_stems: dict[str, Path], crossfade_s: float, out_wav: Path
) -> None:
    """Fade drums+bass over first half, vocals+other over second half."""
    import soundfile as sf

    def _load(p: Path):
        y, sr = sf.read(str(p), always_2d=True)
        return y, sr

    a_d, sr = _load(a_stems["drums"])
    a_b, _ = _load(a_stems["bass"])
    a_v, _ = _load(a_stems["vocals"])
    a_o, _ = _load(a_stems["other"])
    b_d, _ = _load(b_stems["drums"])
    b_b, _ = _load(b_stems["bass"])
    b_v, _ = _load(b_stems["vocals"])
    b_o, _ = _load(b_stems["other"])

    a_full = a_d + a_b + a_v + a_o
    b_full = b_d + b_b + b_v + b_o
    n_fade = int(crossfade_s * sr)
    n_fade = min(n_fade, len(a_full), len(b_full))
    if n_fade <= 0:
        sf.write(str(out_wav), np.concatenate([a_full, b_full], axis=0), sr)
        return
    half = n_fade // 2

    def _build_tail(stems_drums, stems_bass, stems_vocals, stems_other):
        tail = np.zeros((n_fade, stems_drums.shape[1]))
        # rhythm out over first half
        x = np.linspace(0, np.pi / 2, max(half, 1))
        fade_out_rhythm = np.cos(x)[:, None]
        tail[:half] += stems_drums[-n_fade:-n_fade + half] * fade_out_rhythm
        tail[:half] += stems_bass[-n_fade:-n_fade + half] * fade_out_rhythm
        # vox/other out over full crossfade
        x_full = np.linspace(0, np.pi / 2, n_fade)
        fade_out_vox = np.cos(x_full)[:, None]
        tail += stems_vocals[-n_fade:] * fade_out_vox
        tail += stems_other[-n_fade:] * fade_out_vox
        return tail

    def _build_head(stems_drums, stems_bass, stems_vocals, stems_other):
        head = np.zeros((n_fade, stems_drums.shape[1]))
        x = np.linspace(0, np.pi / 2, max(half, 1))
        fade_in_rhythm = np.sin(x)[:, None]
        head[half:half + half] += stems_drums[half:half + half] * fade_in_rhythm if half > 0 else 0
        head[half:half + half] += stems_bass[half:half + half] * fade_in_rhythm if half > 0 else 0
        x_full = np.linspace(0, np.pi / 2, n_fade)
        fade_in_vox = np.sin(x_full)[:, None]
        head += stems_vocals[:n_fade] * fade_in_vox
        head += stems_other[:n_fade] * fade_in_vox
        return head

    tail = _build_tail(a_d, a_b, a_v, a_o)
    head = _build_head(b_d, b_b, b_v, b_o)
    mixed = tail + head
    out = np.concatenate([a_full[:-n_fade], mixed, b_full[n_fade:]], axis=0)
    sf.write(str(out_wav), out, sr, subtype="FLOAT")


def _separate_clip_stems(src_stems_dir: Path, start_s: float, duration_s: float, ratio: float, out_dir: Path) -> dict[str, Path] | None:
    """Trim cached full-track stems to this clip and time-stretch."""
    if not src_stems_dir.exists():
        return None
    out_dir.mkdir(parents=True, exist_ok=True)
    out_stems: dict[str, Path] = {}
    for name in ("drums", "bass", "vocals", "other"):
        src = src_stems_dir / f"{name}.wav"
        if not src.exists():
            return None
        trimmed = out_dir / f"{name}_trim.wav"
        stretched = out_dir / f"{name}.wav"
        _extract_clip_audio(src, start_s, duration_s, trimmed)
        _time_stretch_wav(trimmed, stretched, ratio)
        trimmed.unlink(missing_ok=True)
        out_stems[name] = stretched
    return out_stems


def _mux_video_audio(video_path: Path, audio_wav: Path, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-i", str(video_path), "-i", str(audio_wav),
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "320k",
        "-shortest",
        "-movflags", "+faststart",
        str(out_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _probe_dims(path: Path) -> tuple[int, int]:
    r = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=p=0",
            str(path),
        ],
        capture_output=True, text=True, check=True,
    )
    w, h = r.stdout.strip().split(",")[:2]
    return int(w), int(h)


def _probe_duration(path: Path) -> float:
    r = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True, text=True, check=True,
    )
    return float(r.stdout.strip())


def compute_title_windows(
    durations: list[float],
    crossfades_s: list[float],
    switch_at: str = "end",
    kick_offsets: list[float] | None = None,
) -> list[tuple[float, float]]:
    """Per-part [start, end) windows in the FINAL (post-xfade) timeline.

    Uses the same offset math as the video concat: part i starts at
    s_i = s_{i-1} + d_{i-1} - cf_{i-1}. switch_at="end": the title switches
    at each xfade END (where the incoming kick slams — matches faded video).
    switch_at="start": switches at the xfade START — matches hard-cut video,
    where the incoming track's picture appears when its build enters.
    Pure function so it's unit-testable.
    """
    if not durations:
        return []
    if len(crossfades_s) != len(durations) - 1:
        raise ValueError("crossfades count must be len(durations) - 1")
    switches: list[float] = []
    cumulative = durations[0]
    for i in range(1, len(durations)):
        cf = max(0.05, crossfades_s[i - 1])
        offset = max(0.0, cumulative - cf)
        # "end" switches land ON the incoming kick. The seam aligner may
        # slide the actual kick up to half a beat off the nominal seam
        # (kick_offsets, from its measurements) — follow it, and lead by
        # ~1.5 video frames so the burned title (quantized to the 30fps
        # grid) can never appear AFTER the hit.
        ko = float(kick_offsets[i - 1]) if kick_offsets and i - 1 < len(kick_offsets) else 0.0
        switches.append(
            offset if switch_at == "start" else max(offset, offset + cf + ko - 0.045)
        )
        cumulative = cumulative + durations[i] - cf
    total = cumulative
    windows: list[tuple[float, float]] = []
    prev = 0.0
    for i in range(len(durations)):
        end = switches[i] if i < len(switches) else total
        windows.append((prev, end))
        prev = end
    return windows


# ---------- Title fitting ----------
# Titles must sit comfortably inside the bottom bar: never touch the frame
# edges, and keep generous breathing room so even a full-width title doesn't
# look cramped.
_TITLE_MARGIN_X = 160          # px of clear space each side at 1080p
_TITLE_MAX_W = _BRAND_W - 2 * _TITLE_MARGIN_X
_TITLE_MIN_FONT = 40           # below this a single line becomes unreadable
_TITLE_TWO_LINE_FONT = 44      # cap when wrapping to two lines
_TITLE_TWO_LINE_MIN = 34

_font_metrics_cache: dict[str, dict[str, Any] | None] = {}


def _font_metrics(font_path: Path) -> dict[str, Any] | None:
    """Advance widths of a title font, for exact text measurement."""
    key = str(font_path)
    if key in _font_metrics_cache:
        return _font_metrics_cache[key]
    try:
        from fontTools.ttLib import TTFont

        f = TTFont(str(font_path), lazy=True)
        upem = float(f["head"].unitsPerEm)
        hmtx = f["hmtx"]
        cmap = f.getBestCmap()
        widths = {cp: float(hmtx[g][0]) for cp, g in cmap.items()}
        os2 = f["OS/2"]
        # libass (like VSFilter/GDI) maps ASS Fontsize to the font's cell
        # height (usWinAscent + usWinDescent), not to unitsPerEm.
        cell = float(os2.usWinAscent + os2.usWinDescent) or upem
        _font_metrics_cache[key] = {
            "upem": upem,
            "widths": widths,
            "default": widths.get(ord("H"), upem * 0.5),
            "scale": upem / cell,
        }
    except Exception:
        _font_metrics_cache[key] = None
    return _font_metrics_cache[key]


def _text_width_px(text: str, font_size: float, font_path: Path) -> float:
    """Rendered pixel width of `text` at ASS Fontsize `font_size` (PlayRes
    pixels). Falls back to a Bebas-ish heuristic if fontTools is missing."""
    m = _font_metrics(font_path)
    if not m:
        return len(text) * font_size * 0.48
    units = sum(m["widths"].get(ord(ch), m["default"]) for ch in text)
    return units / m["upem"] * font_size * m["scale"]


_TITLE_KEEP_PAREN_RE = re.compile(
    r"\b(remix|edit|mix|mashup|vip|bootleg|rework|version|cover|flip)\b",
    re.IGNORECASE,
)
_TITLE_FEAT_RE = re.compile(
    r"\s+(?:feat\.?|ft\.?|featuring)\s+[^-()\[\]]+?(?=\s+-\s|\s+x\s|\s*[(\[]|$)",
    re.IGNORECASE,
)


def _shorten_title_steps(title: str) -> list[str]:
    """Progressively shorter versions of a title, mildest reduction first.
    Every step keeps the actual artist/track identity — only decorations
    (junk parentheticals, feat credits, overlong mashup chains) are dropped."""
    steps: list[str] = []

    def _push(s: str) -> None:
        s = re.sub(r"\s+", " ", s).strip(" -–—x").strip()
        if s and s not in steps:
            steps.append(s)

    cur = title
    # 1. Drop parentheticals that don't identify the version ("(Official
    #    Sunburn Goa 2015 Anthem)", "(Gladiator OST)", "(Free Fire ... Song)").
    def _paren_sub(m: re.Match) -> str:
        return m.group(0) if _TITLE_KEEP_PAREN_RE.search(m.group(1)) else " "

    cur2 = re.sub(r"[\(\[]([^\)\]]*)[\)\]]", _paren_sub, cur)
    _push(cur2)
    cur = cur2 if cur2.strip() else cur
    # 2. Drop feat credits ("KSHMR ft. Jake Reese - ..." -> "KSHMR - ...").
    cur2 = _TITLE_FEAT_RE.sub("", cur)
    _push(cur2)
    cur = cur2 if cur2.strip() else cur
    # 3. Mashup chains: keep the first two components (+ the mashup credit).
    parts = re.split(r"\s+x\s+", cur, flags=re.IGNORECASE)
    if len(parts) > 2:
        credit = ""
        m = re.search(r"([\(\[][^\)\]]*mashup[^\)\]]*[\)\]])\s*$", cur, re.IGNORECASE)
        if m:
            credit = " " + m.group(1)
            parts = [re.sub(re.escape(m.group(1)), "", p).strip() for p in parts]
        _push(" x ".join(parts[:2]) + credit)
    return steps


def fit_title(
    title: str,
    font_path: Path,
    max_w: int = _TITLE_MAX_W,
    base_size: int = _TITLE_FONT_SIZE,
) -> tuple[list[str], int]:
    """Fit a title inside `max_w`: full text at the base size when possible,
    then progressively shortened (identity-preserving), then scaled down,
    then wrapped to two lines. Returns (lines, font_size); measurement is on
    the uppercased text exactly as the caps-only style renders it."""

    def _w(s: str, size: float) -> float:
        return _text_width_px(s.upper(), size, font_path)

    if _w(title, base_size) <= max_w:
        return [title], base_size

    candidates = [title] + _shorten_title_steps(title)
    # Any shortened variant that fits at full size wins.
    for c in candidates[1:]:
        if _w(c, base_size) <= max_w:
            return [c], base_size

    # Scale the shortest variant down (not below the readability floor).
    shortest = min(candidates, key=lambda s: _w(s, base_size))
    for size in range(base_size - 2, _TITLE_MIN_FONT - 1, -2):
        if _w(shortest, size) <= max_w:
            return [shortest], size

    # Two lines: split at the best boundary (" x " for mashups, else the
    # word nearest the middle), sized so both lines fit.
    parts = re.split(r"\s+x\s+", shortest, flags=re.IGNORECASE)
    words = shortest.split()
    if len(parts) >= 2:
        cut = len(parts) // 2
        lines = [" x ".join(parts[:cut]), " x ".join(parts[cut:])]
    elif len(words) >= 2:
        best_i, best_d = 1, float("inf")
        for i in range(1, len(words)):
            d = abs(_w(" ".join(words[:i]), 10) - _w(" ".join(words[i:]), 10))
            if d < best_d:
                best_i, best_d = i, d
        lines = [" ".join(words[:best_i]), " ".join(words[best_i:])]
    else:
        lines = [shortest]  # one unsplittable word: trim it below
    for size in range(_TITLE_TWO_LINE_FONT, _TITLE_TWO_LINE_MIN - 1, -2):
        if all(_w(ln, size) <= max_w for ln in lines):
            return lines, size

    # Last resort (should never trigger): hard-trim the longer line.
    size = _TITLE_TWO_LINE_MIN
    out = []
    for ln in lines:
        while ln and _w(ln + "…", size) > max_w:
            ln = ln[:-1].rstrip()
        out.append(ln + ("…" if ln != lines[len(out)] else ""))
    return out, size


def _ass_escape(text: str) -> str:
    """Sanitize text for an ASS Dialogue line: backslashes start control codes
    and braces open override blocks, so neutralize them; newlines collapse."""
    return (
        text.replace("\\", "/")
        .replace("{", "(")
        .replace("}", ")")
        .replace("\n", " ")
        .replace("\r", " ")
    )


def _ass_time(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _write_title_ass(
    title_windows: list[tuple[str, float, float]],
    out_ass: Path,
    font_path: Path,
    font_fam: str,
) -> None:
    """Build an ASS subtitle file with one centered title per window, anchored
    in the middle of the bottom letterbox bar. Rendered with the libass `ass`
    filter (this ffmpeg build has no drawtext) using fontsdir=assets/fonts so
    no font needs a system install."""
    y_center = _BRAND_H - _BAR_H // 2  # vertical center of the bottom bar
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {_BRAND_W}",
        f"PlayResY: {_BRAND_H}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Title,{font_fam},{_TITLE_FONT_SIZE},&H00FFFFFF,&H00FFFFFF,"
        "&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    import unicodedata

    def _ascii_fold(s: str) -> str:
        """Tiësto -> Tiesto, Ángela -> Angela: the title font is ASCII-only
        and libass glyph fallback renders accents in a mismatched font."""
        folded = unicodedata.normalize("NFKD", s)
        folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
        folded = folded.encode("ascii", "ignore").decode("ascii")
        return folded if folded.strip() else s

    for title, start_s, end_s in title_windows:
        if end_s <= start_s:
            continue
        title = _ascii_fold(title)
        # Fit inside the safe width: shorten (identity-preserving), scale,
        # or wrap to two lines — a raw long title would run off-frame.
        fit_lines, font_size = fit_title(title, font_path)
        txt = "\\N".join(_ass_escape(ln.upper()) for ln in fit_lines)
        size_tag = f"\\fs{font_size}" if font_size != _TITLE_FONT_SIZE else ""
        lines.append(
            f"Dialogue: 0,{_ass_time(start_s)},{_ass_time(end_s)},Title,,0,0,0,,"
            f"{{\\pos({_BRAND_W // 2},{y_center}){size_tag}}}{txt}"
        )
    out_ass.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _display_title(src: Path) -> str:
    """Overlay title for a source track: track_meta title if imported via
    YouTube, else a cleaned-up filename stem."""
    meta = db.get_track_meta(analysis_mod.file_hash(src))
    if meta and meta.get("title"):
        return meta["title"]
    return youtube_mod.clean_title(src.stem)


def _export_path(clips: list[dict], srcs: list[Path], config: dict) -> Path:
    """Final export path. Each render gets its own folder under exports/,
    named after the export title, holding the full mix, its Short, and the
    verification report together instead of loose files. Default style names
    the folder after the first source video plus the local date and time so
    repeated renders never overlap (exports/<Video_Name>_20260705_1731/
    automix_<Video_Name>_20260705_1731.mp4); the "timestamp" style uses the
    UTC timestamp. The automix_ file prefix is REQUIRED — main.py tells
    exports from imports by it.
    """
    style = str(config.get("filename_style", "file"))
    if style != "timestamp" and srcs:
        stem = re.sub(r"\s*\[[A-Za-z0-9_-]{8,12}\]\s*$", "", srcs[0].stem)
        slug = re.sub(r"[^A-Za-z0-9]+", "_", stem).strip("_")[:48]
        if slug:
            local_ts = datetime.now().strftime("%Y%m%d_%H%M")
            folder = EXPORTS_DIR / f"{slug}_{local_ts}"
            while folder.exists():
                folder = EXPORTS_DIR / f"{slug}_{local_ts}_{random.randint(10, 99)}"
            return folder / f"automix_{slug}_{local_ts}.mp4"
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return EXPORTS_DIR / f"automix_{ts}" / f"automix_{ts}.mp4"


# ---------- YouTube Shorts (vertical 1080x1920 with the edmpapa template) ----

SHORT_TEMPLATE = ASSETS_DIR / "edmpapa.mp4"
# The template's lightning bars leave a full-width black window between
# these rows (measured from the asset). The center block (text bars +
# video) is inset from the frame edges; the template is screen-blended on
# top so its black passes through.
_SHORT_W, _SHORT_H = 1080, 1920
_SHORT_WIN_TOP, _SHORT_WIN_BOT = 445, 1475
# The video runs edge to edge at the mix's full 16:9 aspect (NO crop, NO
# inset — show as much of the main video as possible); the black text bars
# above/below absorb the rest of the template window height.
_SHORT_INSET_X = 0
_SHORT_VID_W = _SHORT_W  # 1080, edge to edge
_SHORT_VID_H = 608  # 1080 x 9/16 — the whole mix frame, uncropped
_SHORT_BAR_H = (_SHORT_WIN_BOT - _SHORT_WIN_TOP - _SHORT_VID_H) // 2  # 211
_SHORT_VID_Y = _SHORT_WIN_TOP + _SHORT_BAR_H  # 656


_SHORT_END_CARD_S = 3.0
_SHORT_END_CARD_TEXT = "WATCH THE FULL VIDEO LINKED BELOW"


def _short_titles_ass(
    windows: list[tuple[str, float, float]],
    dur: float,
    card_start: float,
    out_ass: Path,
    font_fam: str,
) -> None:
    """Per-drop centered lines: artist in the top bar, track name in the
    bottom bar, switching with the mix's title windows; then the end-card
    line centered on black. Titles render caps-only; long lines scale down
    to stay inside the bar width."""
    max_w = _SHORT_VID_W - 60

    def _fs(text: str, base: int = 104) -> int:
        if not text:
            return base
        return max(48, min(base, int(max_w / (0.5 * len(text)))))

    def _ts(t: float) -> str:
        t = max(0.0, t)
        return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"

    def _esc(text: str) -> str:
        return text.strip().upper().replace("\\", "").replace("{", "(").replace("}", ")")

    top_y = _SHORT_WIN_TOP + _SHORT_BAR_H // 2
    bot_y = _SHORT_WIN_BOT - _SHORT_BAR_H // 2
    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {_SHORT_W}",
        f"PlayResY: {_SHORT_H}",
        "WrapStyle: 2",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, "
        "Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        f"Style: Short,{font_fam},88,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,"
        "100,100,1,0,1,0,0,5,10,10,10,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for title, s, e in windows:
        if s >= card_start:
            continue
        e = min(e, card_start)
        if " - " in title:
            artist, track = title.split(" - ", 1)
        else:
            artist, track = "", title
        for text, y in ((artist, top_y), (track, bot_y)):
            txt = _esc(text)
            if not txt:
                continue
            lines.append(
                f"Dialogue: 0,{_ts(s)},{_ts(e)},Short,,0,0,0,,"
                f"{{\\pos({_SHORT_W // 2},{y})\\fs{_fs(txt)}}}{txt}"
            )
    # End card: centered call-to-action on black (the template's wordmark
    # and subscribe button stay blended over it).
    # Two centered lines so the text can stay big; alignment 5 centers the
    # whole block on the frame middle.
    words = _esc(_SHORT_END_CARD_TEXT).split()
    half = (len(words) + 1) // 2
    card_lines = [" ".join(words[:half]), " ".join(words[half:])]
    longest = max(len(ln) for ln in card_lines if ln) if any(card_lines) else 1
    card_fs = max(56, min(92, int((_SHORT_W - 120) / (0.5 * longest))))
    card = "\\N".join(ln for ln in card_lines if ln)
    lines.append(
        f"Dialogue: 0,{_ts(card_start)},{_ts(dur)},Short,,0,0,0,,"
        f"{{\\pos({_SHORT_W // 2},{_SHORT_H // 2})\\fs{card_fs}}}{card}"
    )
    out_ass.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _render_short(
    mix_video: Path,
    mix_audio_wav: Path,
    windows: list[tuple[str, float, float]],
    mix_len: float,
    main_out: Path,
    work: Path,
    progress: ProgressCb = None,
    title_font: tuple[Path, str] | None = None,
) -> Path | None:
    """Vertical Short reframing the rendered mix itself: the first minute of
    the beat-matched mix (as many drops as fit), blurred + darkened behind a
    centered inset video, artist/track bars switching per drop, and the
    edmpapa template (wordmark + lightning + subscribe) screen-blended over
    everything. Returns the output path, or None (a failed Short never
    kills the mix)."""
    if not SHORT_TEMPLATE.exists():
        print(f"[short] template missing: {SHORT_TEMPLATE}")
        return None
    if mix_len < 5.0:
        return None
    # Mix content + end card together stay under the 1-minute Shorts cap.
    card_start = min(mix_len, 59.5 - _SHORT_END_CARD_S)
    dur = card_start + _SHORT_END_CARD_S

    if progress:
        progress("render", 98.0, "Rendering Short")

    font = title_font or resolve_title_font(None)
    fonts_dir = font[0].parent if font else FONTS_DIR
    ass_path = work / "short_titles.ass"
    _short_titles_ass(windows, dur, card_start, ass_path, font[1] if font else "Bebas Neue")

    bar_bot_y = _SHORT_VID_Y + _SHORT_VID_H
    out_path = main_out.with_name(main_out.stem + "_short.mp4")
    filt = (
        # Plain black canvas; the centered drop video is the only picture.
        f"color=black:s={_SHORT_W}x{_SHORT_H}:r=30[bg];"
        f"[0:v]fps=30,scale={_SHORT_VID_W}:{_SHORT_VID_H}:force_original_aspect_ratio=increase,"
        f"crop={_SHORT_VID_W}:{_SHORT_VID_H}[fg];"
        f"[bg][fg]overlay={_SHORT_INSET_X}:{_SHORT_VID_Y}:shortest=1[comp];"
        # Fade the whole picture to black for the end card (fade holds
        # black), pad with black in case the mix is shorter than the card.
        f"[comp]fade=t=out:st={max(0.0, card_start - 0.35):.3f}:d=0.35,"
        f"tpad=stop=-1:stop_mode=add:color=black,"
        f"drawbox=x={_SHORT_INSET_X}:y={_SHORT_WIN_TOP}:w={_SHORT_VID_W}:h={_SHORT_BAR_H}:color=black:t=fill,"
        f"drawbox=x={_SHORT_INSET_X}:y={bar_bot_y}:w={_SHORT_VID_W}:h={_SHORT_BAR_H}:color=black:t=fill,"
        f"ass=filename='{ass_path}':fontsdir='{fonts_dir}',setsar=1,format=gbrp[base];"
        f"[1:v]fps=30,scale={_SHORT_W}:{_SHORT_H},setsar=1,format=gbrp[tpl];"
        f"[base][tpl]blend=all_mode=screen,format=yuv420p[v];"
        # Audio fades out into the card and pads silent underneath it.
        f"[2:a]afade=t=out:st={max(0.0, card_start - 1.0):.3f}:d=1.0,apad[a]"
    )
    cmd = [
        "ffmpeg", "-y",
        "-t", f"{dur:.3f}", "-i", str(mix_video),
        "-stream_loop", "-1", "-i", str(SHORT_TEMPLATE),
        "-i", str(mix_audio_wav),
        "-filter_complex", filt,
        "-map", "[v]", "-map", "[a]",
        "-t", f"{dur:.3f}",
        # veryfast: Shorts get recompressed hard by YouTube anyway, and this
        # keeps the companion render a small fraction of the mix's time.
        "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        str(out_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    print(f"[short] wrote {out_path.name} ({card_start:.1f}s of the mix + end card)")
    return out_path


def _apply_branding(
    video_in: Path,
    out_path: Path,
    title_windows: list[tuple[str, float, float]],
    proxy: bool,
    brand_start: float = 0.0,
    canvas: tuple[int, int] | None = None,
    intermediate: bool = False,
    title_font: tuple[Path, str] | None = None,
) -> None:
    """EDMPAPA branding pass: crop-fill to 1920x1080, draw black letterbox
    bars OVER the video (top+bottom, 140px), overlay the logo in the top bar
    and render one title per (title, start_s, end_s) window in the bottom bar
    (via a libass subtitle track — this ffmpeg build ships without drawtext)."""
    have_logo = LOGO_PATH.exists()
    font = title_font or resolve_title_font(None)
    have_font = font is not None and font[0].exists()
    if not have_logo:
        print(f"[render] branding: logo missing at {LOGO_PATH}, skipping logo")
    if not have_font and title_windows:
        print(f"[render] branding: no title font in {FONTS_DIR}, skipping titles")

    bw, bh = canvas or (_BRAND_W, _BRAND_H)
    k = bh / float(_BRAND_H)
    bar_h = max(2, int(round(_BAR_H * k)))
    logo_h = max(2, int(round(_LOGO_H * k)))
    logo_margin = max(2, int(round(_LOGO_MARGIN_RIGHT * k)))

    filters: list[str] = []
    label = "base"
    # brand_start > 0: during the intro animation the full branding (with
    # the wordmark) is replaced by plain letterbox bars (black-bars.png);
    # the wordmark pops in exactly when the intro ends (first drop's kick).
    en = f":enable='gte(t,{brand_start:.3f})'" if brand_start > 0 else ""
    have_bars = brand_start > 0 and BARS_PATH.exists()
    filters.append(
        f"[0:v]scale={bw}:{bh}:force_original_aspect_ratio=increase,"
        f"crop={bw}:{bh},setsar=1,"
        f"drawbox=x=0:y=0:w=iw:h={bar_h}:color=black:t=fill,"
        f"drawbox=x=0:y=ih-{bar_h}:w=iw:h={bar_h}:color=black:t=fill[{label}]"
    )
    if have_bars:
        bars_idx = 2 if have_logo else 1
        filters.append(
            f"[{bars_idx}:v]scale={bw}:{bh}[barsimg];"
            f"[{label}][barsimg]overlay=x=0:y=0:"
            f"enable='lt(t,{brand_start:.3f})'[barsed]"
        )
        label = "barsed"
    if have_logo:
        try:
            lw, lh = _probe_dims(LOGO_PATH)
        except Exception:
            lw, lh = 0, 0
        if (lw, lh) == (_BRAND_W, _BRAND_H):
            # edmpapa11.png is a ready-made full-frame overlay (opaque bars
            # top/bottom with the wordmark baked in, transparent middle) —
            # composite it 1:1 instead of shrinking the whole frame to 84px.
            filters.append(
                f"[1:v]scale={bw}:{bh}[brandimg];"
                f"[{label}][brandimg]overlay=x=0:y=0{en}[branded]"
            )
        else:
            filters.append(f"[1:v]scale=-1:{logo_h}[logo]")
            filters.append(
                f"[{label}][logo]overlay=x=W-w-{logo_margin}:"
                f"y=({bar_h}-{logo_h})/2{en}[branded]"
            )
        label = "branded"
    try:
        acodec = analysis_mod.probe_basic(video_in).get("codec_audio", "")
    except Exception:
        acodec = ""
    audio_args = ["-c:a", "copy"] if acodec == "aac" else ["-c:a", "aac", "-b:a", "320k"]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="brand_") as tmp:
        if have_font and title_windows:
            assert font is not None
            ass_path = Path(tmp) / "titles.ass"
            _write_title_ass(title_windows, ass_path, font[0], font[1])
            filters.append(
                f"[{label}]ass=filename='{ass_path}':fontsdir='{font[0].parent}'[titled]"
            )
            label = "titled"

        cmd = ["ffmpeg", "-y", "-i", str(video_in)]
        if have_logo:
            cmd += ["-i", str(LOGO_PATH)]
        if have_bars:
            cmd += ["-i", str(BARS_PATH)]
        cmd += [
            "-filter_complex", ";".join(filters),
            "-map", f"[{label}]", "-map", "0:a?",
            *_x264_encode_args(proxy, intermediate),
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            *audio_args,
            str(out_path),
        ]
        subprocess.run(cmd, check=True, capture_output=True)


def _xfade_videos(
    parts: list[Path],
    crossfades_s: list[float],
    out_path: Path,
    proxy: bool = False,
    durations: list[float] | None = None,
    intermediate: bool = False,
) -> None:
    """Concat parts with per-boundary video crossfades. crossfades_s has one
    fewer element than parts (one per transition).

    `durations` overrides the probed video durations for the offset math —
    pass the AUDIO clip lengths so the video fades land exactly on the audio
    seams. Video re-encodes quantize to frames (±33ms/clip) and that drift
    accumulates across the mix if the video is its own timing authority.
    Each input is tail-padded (frozen last frame) so an audio-derived offset
    slightly past a video's end never underruns."""
    if not parts:
        raise ValueError("no parts")
    if len(parts) == 1:
        shutil.copy(parts[0], out_path)
        return
    if len(crossfades_s) != len(parts) - 1:
        raise ValueError("crossfades count must be len(parts) - 1")

    if durations is None:
        durations = [_probe_duration(p) for p in parts]

    inputs: list[str] = []
    for p in parts:
        inputs.extend(["-i", str(p)])

    filter_parts: list[str] = []
    # Freeze-frame pad every input so xfade offsets computed from the audio
    # timeline always have video to fade with.
    pad_labels: list[str] = []
    for i in range(len(parts)):
        lbl = f"p{i}"
        filter_parts.append(
            f"[{i}:v]tpad=stop_mode=clone:stop_duration=1.0[{lbl}]"
        )
        pad_labels.append(lbl)

    cumulative = durations[0]
    prev_label = pad_labels[0]
    for i in range(1, len(parts)):
        cf = max(0.05, crossfades_s[i - 1])
        offset = max(0.0, cumulative - cf)
        next_label = f"v{i}"
        filter_parts.append(
            f"[{prev_label}][{pad_labels[i]}]xfade=transition=fade:duration={cf:.3f}:offset={offset:.3f}[{next_label}]"
        )
        cumulative = cumulative + durations[i] - cf
        prev_label = next_label

    # Drop the last input's freeze-frame pad from the final cut.
    filter_parts.append(f"[{prev_label}]trim=duration={cumulative:.3f}[vout]")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", ";".join(filter_parts),
        "-map", "[vout]",
        "-an",
        *_x264_encode_args(proxy, intermediate),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(out_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _cut_concat_videos(
    parts: list[Path],
    crossfades_s: list[float],
    out_path: Path,
    durations: list[float],
    proxy: bool = False,
    intermediate: bool = False,
    fps: float = 30.0,
    fade: float = 0.25,
    transitions: list[str] | None = None,
) -> None:
    """HARD-CUT video timeline (the audio still crossfades underneath).

    Each cut lands at the crossfade START: the moment the incoming track's
    build becomes audible you're already WATCHING the incoming track, and
    its kick then slams on screen. (Cutting at the fade end — after the
    whole transition — felt jarring; cutting when the transition begins is
    how a human edits it.)

    Segment math: clip i's video starts at the mix position where its audio
    enters (fade start = seam - cf), playing from its own beginning, until
    the next fade start. Segment lengths are frame-quantized with ERROR
    DIFFUSION so late cuts can't drift off the audio timeline (47 clips ×
    ±half frame adds up)."""
    if not parts:
        raise ValueError("no parts")
    if len(parts) == 1:
        shutil.copy(parts[0], out_path)
        return
    if len(crossfades_s) != len(parts) - 1:
        raise ValueError("crossfades count must be len(parts) - 1")

    # Absolute cut times on the audio timeline (fade STARTs).
    cuts: list[float] = []
    cum = durations[0]
    for i in range(1, len(parts)):
        cf = max(0.05, crossfades_s[i - 1])
        cuts.append(cum - cf)
        cum = cum + durations[i] - cf
    total = cum

    inputs: list[str] = []
    for p in parts:
        inputs.extend(["-i", str(p)])

    filter_parts: list[str] = []
    labels: list[str] = []
    seg_lens: list[float] = []
    v_cursor = 0.0  # frame-quantized running video time
    # A LITTLE transition at each cut (a bone-dry cut strobes) — the cut
    # position is unchanged; the incoming picture takes over across `fade`
    # seconds starting exactly at the cut. `transitions` cycles per cut
    # (EDM variety); fade<=0 falls back to pure hard cuts.
    hard = fade <= 0.01
    styles = transitions or ["fade"]
    for i in range(len(parts)):
        target_end = cuts[i] if i < len(cuts) else total
        want_len = target_end - v_cursor
        seg_len = round(want_len * fps) / fps if i < len(cuts) else want_len
        seg_len = max(2.0 / fps, seg_len)
        v_cursor += seg_len
        seg_lens.append(seg_len)
        lbl = f"c{i}"
        # Segments before a cut carry `fade` extra tail for the blend;
        # freeze-frame pad so audio-derived lengths can never underrun.
        # fps + settb: xfade requires CFR inputs on one timebase.
        ext = seg_len + (0.0 if hard or i >= len(cuts) else fade)
        filter_parts.append(
            f"[{i}:v]tpad=stop_mode=clone:stop_duration=3.0,"
            f"trim=start=0:end={ext:.4f},"
            f"setpts=PTS-STARTPTS,fps={fps:g},settb=AVTB[{lbl}]"
        )
        labels.append(lbl)
    if hard:
        filter_parts.append(
            "".join(f"[{l}]" for l in labels) + f"concat=n={len(labels)}:v=1:a=0[vout]"
        )
    else:
        prev = labels[0]
        cum = seg_lens[0]
        for i in range(1, len(labels)):
            nxt = f"x{i}"
            style = styles[(i - 1) % len(styles)]
            filter_parts.append(
                f"[{prev}][{labels[i]}]xfade=transition={style}:duration={fade:.3f}:offset={cum:.4f}[{nxt}]"
            )
            cum += seg_lens[i]
            prev = nxt
        filter_parts.append(f"[{prev}]trim=duration={total:.4f}[vout]")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", ";".join(filter_parts),
        "-map", "[vout]",
        "-an",
        *_x264_encode_args(proxy, intermediate),
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(out_path),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _overlay_intro(
    video: Path,
    intro: Path,
    end_t: float,
    intro_dur: float,
    work: Path,
    proxy: bool,
) -> None:
    """Screen-blend the intro animation over the mix so it ENDS exactly on
    the first drop's kick (`end_t`). Screen blend keeps black invisible, so
    the intro is padded with black on both sides and blended full-length —
    no enable-window edge cases. Failure never kills the render."""
    try:
        info = ffprobe_streams(video)
        w = int(info.get("width") or 1920)
        h = int(info.get("height") or 1080)
        fps = info.get("fps") or "30"
        start = max(0.0, end_t - intro_dur)
        out = work / "with_intro.mp4"
        filt = (
            f"[1:v]scale={w}:{h},setsar=1,fps={fps},format=gbrp,"
            f"tpad=start_duration={start:.3f}:start_mode=add:color=black:"
            f"stop=-1:stop_mode=add:color=black[ov];"
            f"[0:v]format=gbrp[base];"
            f"[base][ov]blend=all_mode=screen:shortest=1,format=yuv420p[v]"
        )
        cmd = [
            "ffmpeg", "-y", "-i", str(video), "-i", str(intro),
            "-filter_complex", filt,
            "-map", "[v]", "-map", "0:a?",
            *_x264_encode_args(proxy),
            "-pix_fmt", "yuv420p",
            "-c:a", "copy",
            "-movflags", "+faststart",
            str(out),
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        shutil.move(str(out), str(video))
    except Exception as e:
        print(f"[intro] overlay failed, keeping mix without intro: {e}")


def _append_black_outro(video: Path, outro_s: float, work: Path) -> None:
    """Append a black VIDEO-ONLY outro segment for YouTube end screens (they
    occupy the last 5-20s of a video). Runs BEFORE the audio mux; the
    matching silence is appended to the final WAV instead — concat-copying
    AAC streams dropped the encoder-delay edit list and shifted the whole
    mix audio one AAC frame (~23ms) late against the video and every seam."""
    try:
        info = ffprobe_streams(video)
    except Exception:
        info = {}
    w = int(info.get("width") or 1920)
    h = int(info.get("height") or 1080)
    fps = info.get("fps") or "30"
    black = work / "outro_black.mp4"
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=black:s={w}x{h}:r={fps}",
        "-t", f"{outro_s:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-an",
        str(black),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    joined = work / "with_outro.mp4"
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write(f"file '{video.resolve()}'\nfile '{black.resolve()}'\n")
        list_path = f.name
    try:
        cmd = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path,
            "-c", "copy", "-movflags", "+faststart", str(joined),
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        shutil.move(str(joined), str(video))
    except Exception:
        # Concat-copy can fail on parameter-set mismatches — the mix is
        # still complete without the outro, so never fail the render on it.
        print("[outro] concat failed, keeping mix without outro")
    finally:
        Path(list_path).unlink(missing_ok=True)


def ffprobe_streams(path: Path) -> dict:
    """Width/height/fps of the first video stream."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate",
            "-of", "json", str(path),
        ],
        check=True, capture_output=True,
    ).stdout
    s = (json.loads(out).get("streams") or [{}])[0]
    fps = s.get("r_frame_rate", "30/1")
    try:
        num, den = fps.split("/")
        fps_val = float(num) / float(den)
        fps = str(int(fps_val)) if abs(fps_val - round(fps_val)) < 1e-6 else f"{fps_val:.3f}"
    except Exception:
        fps = "30"
    return {"width": s.get("width"), "height": s.get("height"), "fps": fps}


def _concat_videos(parts: list[Path], out_path: Path, proxy: bool = False) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        for p in parts:
            f.write(f"file '{p.resolve()}'\n")
        list_path = f.name
    try:
        a_bitrate = "192k" if proxy else "320k"
        cmd = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", list_path,
            *_x264_args(proxy),
            "-c:a", "aac", "-b:a", a_bitrate,
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            str(out_path),
        ]
        subprocess.run(cmd, check=True, capture_output=True)
    finally:
        Path(list_path).unlink(missing_ok=True)


def render_mix(
    config: dict[str, Any],
    track_resolver: Callable[[str], Path],
    progress: ProgressCb = None,
    cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Main render pipeline.

    track_resolver(track_id) -> absolute path to source MP4.
    Returns {"id", "output_path", "created_at", "config"}.
    """
    clips = config["clips"]
    crossfade_bars = float(config.get("crossfade_bars", 1.0))
    target_lufs = float(config.get("loudness_lufs", -14.0))
    use_stem_cf = bool(config.get("use_stem_crossfade", True))
    use_eq_swap = bool(config.get("use_eq_bass_swap", True))
    snap = bool(config.get("snap_to_downbeat", True))
    hard_cut = bool(config.get("hard_cut", False))
    proxy = bool(config.get("proxy", False))
    no_stretch = bool(config.get("no_time_stretch", False))
    max_pitch_st = float(config.get("harmonic_pitch_shift_max_semitones", 2.0))
    brand_overlay = bool(config.get("brand_overlay", True))
    show_titles = bool(config.get("show_titles", True))
    title_font = resolve_title_font(config.get("title_font"))

    # When no_time_stretch is on, force the per-clip stretch ratio to 1.0.
    # Each clip plays at its native BPM (no setpts on video, no rubberband on
    # audio) — eliminates the "video slowed down" + A/V drift problems.
    # Crossfades and stem-swap still happen between clips.

    # Proxy mode forces stems off (Demucs is slow; preview should be fast).
    if proxy:
        use_stem_cf = False
        use_eq_swap = False
    if hard_cut:
        crossfade_bars = 0.0

    # Pre-load analyses for all clips so we can compute target_bpm and pitch shifts.
    analyses: list[dict[str, Any]] = []
    srcs: list[Path] = []
    for clip in clips:
        src = track_resolver(clip["track_id"])
        cached = db.get_analysis(analysis_mod.file_hash(src))
        if not cached:
            raise RuntimeError(f"track {clip['track_id']} not analyzed")
        analyses.append(cached)
        srcs.append(src)

    target_bpm = float(config.get("target_bpm") or 0.0)
    if target_bpm <= 0:
        target_bpm = sum(float(a["bpm"]) for a in analyses) / len(analyses)

    # Compute per-clip pitch shifts toward the first clip's key, capped to max_pitch_st.
    ref_key = analyses[0].get("key_camelot", "") or ""
    pitch_shifts: list[float] = []
    for a in analyses:
        k = a.get("key_camelot", "") or ""
        ideal = _camelot_semitone_shift(k, ref_key)
        clamped = max(-max_pitch_st, min(max_pitch_st, float(ideal)))
        pitch_shifts.append(clamped)

    RENDER_TMP_DIR.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="automix_", dir=str(RENDER_TMP_DIR)))

    # Intro overlay (screen-blended over the first clip's buildup, timed to
    # end exactly on the first drop's kick). Default: assets/into.avi.
    canvas = _RESOLUTIONS.get(str(config.get("resolution", "1080p")), (_BRAND_W, _BRAND_H))

    intro_cfg = config.get("intro_path")
    intro_path = Path(intro_cfg) if intro_cfg else (ASSETS_DIR / "into.avi")
    intro_dur = 0.0
    if config.get("intro_overlay", True) and intro_path.exists():
        try:
            intro_dur = _probe_duration(intro_path)
        except Exception:
            intro_dur = 0.0
    first_kick_out = 0.0

    if progress:
        progress("render", 1.0, f"Preparing clips (target {target_bpm:.1f} BPM)")

    n_clips = len(clips)
    clip_videos: list[Path | None] = [None] * n_clips
    clip_audios: list[Path | None] = [None] * n_clips
    clip_stems: list[dict[str, Path] | None] = [None] * n_clips
    clip_ratios: list[float] = [1.0] * n_clips
    _fk = {"out": 0.0}

    def _check_cancel() -> None:
        if cancel and cancel():
            raise RuntimeError("cancelled")

    def _prepare_clip(idx: int) -> None:
        clip = clips[idx]
        _check_cancel()
        src = srcs[idx]
        cached = analyses[idx]
        src_bpm = float(cached["bpm"])
        downbeats = [float(d) for d in cached.get("downbeats", [])]

        # Prefer the drop's MEASURED kick period over the global BPM estimate
        # (which can be ~1% off — enough to audibly drift across a blend).
        clip_kick = clip.get("kick_s")
        if clip_kick is not None:
            for d in cached.get("drops") or []:
                if (
                    d.get("kick_period_s")
                    and d.get("kick_s") is not None
                    and abs(float(d["kick_s"]) - float(clip_kick)) < 0.6
                ):
                    bpm_k = 60.0 / float(d["kick_period_s"])
                    # reconcile octave with the global estimate
                    while src_bpm > 0 and bpm_k < src_bpm / 1.5:
                        bpm_k *= 2.0
                    while src_bpm > 0 and bpm_k > src_bpm * 1.5:
                        bpm_k /= 2.0
                    if src_bpm <= 0 or abs(bpm_k - src_bpm) / src_bpm < 0.1:
                        src_bpm = bpm_k
                    break

        # Stretch ratio (needed below for lead-in math in OUTPUT time).
        # no_stretch: each clip plays at its source BPM (target ignored).
        pre_ratio = 1.0 if no_stretch else (src_bpm / target_bpm)
        if abs(pre_ratio - 1.0) > 0.08:
            pre_ratio = 1.0

        raw_start = float(clip["start_s"])
        # Transition lead-in: normalize every kick-anchored clip to start
        # exactly 2 bars before its kick. That lead-in carries the incoming
        # track's vocal/riser build (a tighter start chops it off — audibly
        # missing in transitions), and because the crossfade spans the same
        # 2 bars, the incoming kick still lands exactly on the outgoing
        # clip's final downbeat.
        kick = clip.get("kick_s")
        if kick is not None and src_bpm > 0:
            breath = 8.0 * 60.0 / src_bpm
            if idx == 0 and intro_dur > 0:
                # The intro overlay must fit inside the first clip's buildup
                # (it ends exactly on the first kick).
                breath = max(breath, (intro_dur + 0.25) / pre_ratio)
            raw_start = max(0.0, float(kick) - breath)
            clip["start_s"] = raw_start  # _crossfade_for reads this
        if idx == 0:
            _fk["out"] = (
                (float(kick) - raw_start) * pre_ratio if kick is not None else 0.0
            )
        explicit_end = clip.get("end_s")
        # If the caller supplied an explicit end_s (e.g. from a detected drop),
        # honour it exactly: no start-snap, no end-snap, no length math.
        if explicit_end is not None and float(explicit_end) > raw_start:
            start_s = raw_start
            clip_len_s = float(explicit_end) - raw_start
        else:
            start_s = _snap_to_downbeat(raw_start, downbeats) if snap else raw_start
            length_bars = float(clip["length_bars"])
            clip_len_s = _bars_to_seconds(length_bars, src_bpm)
            # If snapping shifted the start, also snap the implied end so we land on a bar.
            if snap and downbeats:
                implied_end = start_s + clip_len_s
                snapped_end = _snap_to_downbeat(implied_end, downbeats)
                if snapped_end > start_s:
                    clip_len_s = snapped_end - start_s
        out_ratio = pre_ratio
        clip_ratios[idx] = out_ratio

        clip_dir = work / f"clip_{idx:02d}"
        clip_dir.mkdir(parents=True, exist_ok=True)

        # Video: trim + crop + stretch in ONE encode.
        stretched_video = clip_dir / "video.mp4"
        _trim_video_clip(
            src, start_s, clip_len_s, stretched_video,
            proxy=proxy, canvas=canvas, ratio=out_ratio,
        )

        # Audio path: extract → time-stretch → pitch-shift → loudnorm.
        raw_audio = clip_dir / "audio_raw.wav"
        _extract_clip_audio(src, start_s, clip_len_s, raw_audio)
        stretched_audio = clip_dir / "audio_stretched.wav"
        _time_stretch_wav(raw_audio, stretched_audio, out_ratio)
        shifted_audio = clip_dir / "audio_shifted.wav"
        _pitch_shift_wav(stretched_audio, shifted_audio, pitch_shifts[idx])
        normed_audio = clip_dir / "audio.wav"
        # Linear gain only (proxy and full alike): loudnorm's dynamic mode
        # pumped/distorted loud EDM program ("blown out"). Float output keeps
        # headroom; the final-mix limiter owns peak control.
        _normalize_linear(shifted_audio, normed_audio, target_lufs)

        # Stems: trim cached full-track stems, stretch, pitch-shift.
        stems = None
        if use_stem_cf:
            fh = analysis_mod.file_hash(src)
            stems_src = analysis_mod.STEMS_CACHE_DIR / fh
            stems = _separate_clip_stems(stems_src, start_s, clip_len_s, out_ratio, clip_dir / "stems")
            if stems and abs(pitch_shifts[idx]) >= 0.05:
                for name, p in list(stems.items()):
                    shifted = p.with_name(f"{name}_shift.wav")
                    _pitch_shift_wav(p, shifted, pitch_shifts[idx])
                    stems[name] = shifted

        clip_videos[idx] = stretched_video
        clip_audios[idx] = normed_audio
        clip_stems[idx] = stems

    # Clips are independent — prepare them in parallel. ffmpeg already
    # multithreads its encodes, so a handful of workers saturates the CPU
    # without oversubscribing it.
    from concurrent.futures import ThreadPoolExecutor, as_completed
    workers = max(1, min(4, (os.cpu_count() or 4) // 2, n_clips))
    done_n = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(_prepare_clip, i) for i in range(n_clips)]
        for fut in as_completed(futs):
            fut.result()  # propagate errors/cancellation
            done_n += 1
            if progress:
                pct = 5.0 + done_n / max(n_clips, 1) * 60.0
                progress("render", pct, f"Prepared clip {done_n}/{n_clips}")

    first_kick_out = _fk["out"]

    # Build final audio with crossfades between consecutive clips.
    if progress:
        progress("render", 70.0, "Mixing audio with crossfades")
    default_crossfade_s = _bars_to_seconds(crossfade_bars, target_bpm)

    def _crossfade_for(b_clip: dict, b_ratio: float = 1.0) -> float:
        # Overlap only the START of the incoming clip's buildup with the
        # outgoing drop's tail. Overlapping the whole buildup (old behavior)
        # buried the riser under the previous drop and produced a flat wall of
        # sound — the mix never breathed. Capping the overlap lets most of the
        # buildup play clean, restoring the tension-release rhythm of the
        # reference EDMPAPA mixes (audible energy dip, then the kick).
        kick = b_clip.get("kick_s")
        start = b_clip.get("start_s")
        if kick is not None and start is not None and float(kick) > float(start):
            buildup = (float(kick) - float(start)) * b_ratio
            return min(buildup, default_crossfade_s)
        return default_crossfade_s

    def _kick_align_crossfade(
        a_wav: Path,
        b_wav: Path,
        planned_cf: float,
        kb_expected: float,
        period_hint: float | None = None,
        grid_t0: float | None = None,
        seam_info: dict | None = None,
    ) -> float:
        """Nudge the crossfade length so the incoming clip's first drop kick
        lands exactly on the outgoing audio's KICK grid.

        Kick-aware version: this material (festival sets) carries heavy
        off-beat sub-bass stabs, and raw low-band peak trains lock onto them
        half a beat off the groove. So (a) the grid period comes from the
        outgoing drop's least-squares kick_period_s when available, and (b)
        the grid PHASE is fitted by maximizing envelope ATTACK (positive
        slope) at grid positions — kicks punch, bass stabs swell, so attack
        votes across ~24 beats pick the on-beats reliably."""
        try:
            import soundfile as sf

            from verify import _attack_curve, _attack_kick_near, _fit_kick_grid, _lowband_env

            info = sf.info(str(a_wav))
            a_len = info.frames / info.samplerate

            # Outgoing grid slot at the clip end. ANALYTIC PRIOR: the drop
            # end was cut exactly one kick period after its last kick, so a
            # grid slot sits AT a_len — we only measure the last kick in a
            # TIGHT ±0.12s window to cancel extraction/stretch bias (the
            # window is too small to grab an off-beat bass stab, which sits
            # ~half a period away and defeated the old statistical fit).
            phi = None
            period = float(period_hint) if period_hint and 0.2 <= period_hint <= 1.2 else None
            if period is not None:
                w0 = a_len - 8.0 * period
                if grid_t0 is not None:
                    w0 = max(w0, grid_t0)
                env, esr, ehop, off = _lowband_env(a_wav, w0, a_len)
                attack = _attack_curve(env)
                for k in range(1, 5):  # a drop that dies early: walk back
                    pred = a_len - k * period
                    t_meas = _attack_kick_near(attack, esr, ehop, off, pred, radius=0.12)
                    if t_meas is not None:
                        phi = (a_len - t_meas) % period  # slot offset at a_len
                        if phi > period / 2:
                            phi -= period
                        break
            if phi is None:
                # No hint / no measurable kick: statistical fallback.
                w0 = a_len - 13.0
                if grid_t0 is not None:
                    w0 = max(w0, grid_t0)
                env, esr, ehop, off = _lowband_env(a_wav, w0, a_len)
                grid = _fit_kick_grid(env, esr, ehop, off, end_t=a_len, period_hint=period_hint)
                if grid is None:
                    print("[align] BAIL no outgoing grid")
                    return planned_cf
                period, phi = grid[0], grid[1]

            # Incoming kick: detection's kick_s is sub-frame accurate, so a
            # tight window again — only extraction bias needs cancelling.
            envb, esrb, ehopb, offb = _lowband_env(b_wav, kb_expected - 0.8, kb_expected + 0.8)
            attack_b = _attack_curve(envb)
            kb = _attack_kick_near(attack_b, esrb, ehopb, offb, kb_expected, radius=0.12)
            if kb is None:
                kb = kb_expected  # trust detection; bias ≤ ~25ms uncancelled
            # Grid slots: a_len - phi + m*period. Pick the slot keeping the
            # crossfade closest to plan (alignment is modulo one period).
            target = a_len + kb - planned_cf
            m = round((target - (a_len - phi)) / period)
            t_next = (a_len - phi) + m * period
            cf = a_len + kb - t_next
            if cf < 0.2:
                print(
                    f"[align] BAIL cf={cf:.3f} planned={planned_cf:.3f} "
                    f"period={period:.3f} kb={kb:.3f} t_next={t_next:.3f} a_len={a_len:.3f}"
                )
                return planned_cf
            if seam_info is not None:
                # The aligner's executable promise, for the verify guard:
                # the incoming kick will sit at (seam + kick_offset) in the
                # final mix, on a grid of `period`.
                seam_info.update(
                    {"kick_offset": float(kb - cf), "period": float(period), "measured": True}
                )
            print(
                f"[align] cf {planned_cf:.3f} -> {cf:.3f} (Δ {cf-planned_cf:+.3f}s, "
                f"period={period:.4f}, phi={phi:+.3f})"
            )
            return float(cf)
        except Exception as e:
            print(f"[align] BAIL error: {e}")
            return planned_cf

    # IMPORTANT: stem-aware crossfade functions take *full clean clips* on both
    # sides — they can't accept the running merged audio (which is already
    # mixed-down). So we only use them on the FIRST transition (i==1). For
    # subsequent merges (i>=2) we fall back to equal-power against the running
    # current_audio. Before this fix, the stem-aware branches were dropping
    # everything earlier than clip[i-1] from the mix.
    def _clip_kick_period(idx: int) -> float | None:
        """Outgoing clip's least-squares kick period (output time): the most
        reliable grid period for seam alignment on syncopated material."""
        ck = clips[idx].get("kick_s")
        if ck is None:
            return None
        for d in analyses[idx].get("drops") or []:
            if (
                d.get("kick_period_s")
                and d.get("kick_s") is not None
                and abs(float(d["kick_s"]) - float(ck)) < 0.6
            ):
                return float(d["kick_period_s"]) * clip_ratios[idx]
        return None

    current_audio = clip_audios[0]
    crossfade_durations: list[float] = []
    seam_period_hints: list[float | None] = []
    seam_infos: list[dict] = []
    for i in range(1, n_clips):
        _check_cancel()
        merged = work / f"merged_{i:02d}.wav"
        a_stems = clip_stems[i - 1]
        b_stems = clip_stems[i]
        cf_s = _crossfade_for(clips[i], clip_ratios[i])
        period_hint = _clip_kick_period(i - 1)
        seam_period_hints.append(period_hint)
        kick = clips[i].get("kick_s")
        start = clips[i].get("start_s")
        if kick is not None and start is not None and float(kick) > float(start):
            kb_expected = (float(kick) - float(start)) * clip_ratios[i]
            # Outgoing drop body start in merged time: the clip occupies the
            # merged tail, its kick sits kb_out after its own start.
            import soundfile as _sf
            info_a = _sf.info(str(current_audio))
            info_out = _sf.info(str(clip_audios[i - 1]))
            a_len_cur = info_a.frames / info_a.samplerate
            out_len = info_out.frames / info_out.samplerate
            ko = clips[i - 1].get("kick_s")
            so = clips[i - 1].get("start_s")
            kb_out = (
                (float(ko) - float(so)) * clip_ratios[i - 1]
                if ko is not None and so is not None and float(ko) > float(so)
                else 0.0
            )
            grid_t0 = a_len_cur - out_len + kb_out + 0.1
            info: dict = {}
            cf_s = _kick_align_crossfade(
                current_audio, clip_audios[i], cf_s, kb_expected, period_hint, grid_t0,
                seam_info=info,
            )
            seam_infos.append(info)
        else:
            seam_infos.append({})
        crossfade_durations.append(cf_s)
        can_use_stems = i == 1 and a_stems and b_stems
        if can_use_stems and use_eq_swap:
            try:
                _eq_bass_swap_crossfade(a_stems, b_stems, cf_s, merged)
            except Exception:
                _equal_power_crossfade(current_audio, clip_audios[i], cf_s, merged)
        elif can_use_stems and use_stem_cf:
            try:
                _stem_aware_crossfade(a_stems, b_stems, cf_s, merged)
            except Exception:
                _equal_power_crossfade(current_audio, clip_audios[i], cf_s, merged)
        else:
            _equal_power_crossfade(current_audio, clip_audios[i], cf_s, merged)
        current_audio = merged

    final_audio = current_audio

    # Build final video — crossfade between clips so video duration matches
    # the audio mix (the audio side overlaps by `crossfade_durations[i]` per
    # transition; the video must do the same or `-shortest` mux will cut off
    # the last clip).
    _check_cancel()
    if progress:
        progress("render", 85.0, "Crossfading video")
    concat_video = work / "video_concat.mp4"
    if len(clip_videos) == 1:
        shutil.copy(clip_videos[0], concat_video)
    else:
        # The AUDIO timeline is the truth: video re-encodes quantize to
        # frames, so audio clip lengths drive the fade offsets.
        import soundfile as sf
        audio_lens = [
            sf.info(str(p)).frames / sf.info(str(p)).samplerate
            for p in clip_audios
        ]
        if bool(config.get("video_cut", True)):
            # Cut ON each incoming build (user preference), optionally
            # softened by a quick transition. "variety" cycles EDM-edit
            # styles: blend, white flash, blur punch, blackout, glitch.
            style = str(config.get("video_transition") or "fade")
            styles = (
                ["fade", "fadewhite", "hblur", "fadeblack", "pixelize"]
                if style == "variety"
                else [style]
            )
            _cut_concat_videos(
                clip_videos, crossfade_durations, concat_video,
                durations=audio_lens, proxy=proxy,
                intermediate=bool(brand_overlay),
                fade=0.25 if bool(config.get("video_cut_fade", True)) else 0.0,
                transitions=styles,
            )
        else:
            _xfade_videos(
                clip_videos, crossfade_durations, concat_video,
                proxy=proxy, durations=audio_lens,
                intermediate=bool(brand_overlay),
            )

    # Normalize the WHOLE mix once at the end: linear gain to the target,
    # then one true-peak safety limiter. This is the ONLY place peaks are
    # controlled — everything upstream stays float with full headroom, and
    # no dynamic loudness processing ever touches the program (loudnorm's
    # dynamic mode was the "blown out" sound).
    if progress:
        progress("render", 82.0, "Normalizing final mix")
    final_normed = work / "final_normed.wav"
    _normalize_linear(final_audio, final_normed, target_lufs)
    _limit_peaks(final_normed, ceiling_db=-1.2)
    final_audio = final_normed

    # Gentle tail fade + the outro's silence appended IN THE WAV (the black
    # outro video is concatenated pre-mux; never concat AAC streams).
    outro_s = float(config.get("outro_s", 20.0))
    if outro_s > 0:
        try:
            import soundfile as sf
            y_fin, sr_fin = sf.read(str(final_audio), always_2d=True, dtype="float32")
            n_fade = min(len(y_fin), int(1.5 * sr_fin))
            if n_fade > 0:
                curve = np.cos(np.linspace(0, np.pi / 2, n_fade))[:, None]
                y_fin[-n_fade:] = y_fin[-n_fade:] * curve
            y_fin = np.vstack(
                [y_fin, np.zeros((int(outro_s * sr_fin), y_fin.shape[1]), dtype=y_fin.dtype)]
            )
            sf.write(str(final_audio), y_fin, sr_fin, subtype="FLOAT")
        except Exception:
            pass

    _check_cancel()
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = _export_path(clips, srcs, config)
    windows: list[tuple[str, float, float]] = []
    # VIDEO-ONLY passes first (branding, intro overlay); the audio joins in
    # exactly ONE mux at the end. Every extra "-c:a copy" hop through an mp4
    # risked dropping the AAC edit list — that shifted the whole track one
    # AAC frame (~23ms) late and pushed every seam out of the perfect band.
    video_final = concat_video
    if brand_overlay:
        if progress:
            progress("render", 95.0, "Applying EDMPAPA branding")
        if show_titles:
            import soundfile as sf
            titles = [
                (clips[i].get("title") or _display_title(srcs[i]))
                for i in range(len(srcs))
            ]
            # Audio lengths, not video probes: the title switch must land
            # exactly on each incoming drop's kick in the mixed audio.
            durations = [
                sf.info(str(p)).frames / sf.info(str(p)).samplerate
                for p in clip_audios
            ]
            # Title always switches at the fade END — the incoming kick.
            # The VIDEO cuts early (at the build), but the new song's name
            # appears exactly when its drop hits (user-confirmed feel),
            # following the aligner's MEASURED kick position per seam.
            spans = compute_title_windows(
                durations, crossfade_durations, switch_at="end",
                kick_offsets=[float(si.get("kick_offset") or 0.0) for si in seam_infos],
            )
            if intro_dur > 0 and first_kick_out > 0 and spans:
                # No title under the intro animation — the first title
                # appears when the intro ends (on the first kick).
                s0, e0 = spans[0]
                spans[0] = (min(first_kick_out, max(s0, e0 - 0.1)), e0)
            windows = [(titles[i], s, e) for i, (s, e) in enumerate(spans)]
        branded = work / "branded.mp4"
        _apply_branding(
            concat_video, branded, windows, proxy,
            brand_start=first_kick_out if intro_dur > 0 else 0.0,
            canvas=canvas,
            intermediate=intro_dur > 0 and first_kick_out > 0,
            title_font=title_font,
        )
        video_final = branded

    if intro_dur > 0 and first_kick_out > 0:
        if progress:
            progress("render", 97.0, "Compositing intro overlay")
        _overlay_intro(video_final, intro_path, first_kick_out, intro_dur, work, proxy)

    if outro_s > 0:
        if progress:
            progress("render", 97.5, "Appending YouTube outro")
        _append_black_outro(video_final, outro_s, work)

    _check_cancel()
    if progress:
        progress("render", 98.0, "Muxing")
    _mux_video_audio(video_final, final_audio, out_path)

    # Verify guard: measure the ACTUAL output (seam phase, loudness, true
    # peak, rendered titles) so a bad mix can never silently look done.
    verification: dict[str, Any] | None = None
    if bool(config.get("verify", True)):
        if progress:
            progress("render", 99.0, "Verifying mix (seams, loudness, titles)")
        try:
            import soundfile as sf

            import verify as verify_mod

            lens_v = [
                sf.info(str(p)).frames / sf.info(str(p)).samplerate
                for p in clip_audios
            ]
            seams_v: list[float] = []
            cursor_v = lens_v[0]
            for i in range(1, len(lens_v)):
                seams_v.append(cursor_v)
                cursor_v = cursor_v + lens_v[i] - crossfade_durations[i - 1]
            # Outgoing drop-body start per seam (final timeline), so the
            # verifier fits its grid on the same clean span as the aligner.
            grid_starts_v: list[float | None] = []
            for j, seam_t in enumerate(seams_v):
                ko = clips[j].get("kick_s")
                so = clips[j].get("start_s")
                kb_j = (
                    (float(ko) - float(so)) * clip_ratios[j]
                    if ko is not None and so is not None and float(ko) > float(so)
                    else 0.0
                )
                grid_starts_v.append(seam_t - lens_v[j] + kb_j + 0.1)
            verification = verify_mod.verify_mix(
                out_path,
                seams_v,
                [float(c) for c in crossfade_durations],
                windows,
                target_lufs,
                expect_titles=bool(brand_overlay and show_titles and windows),
                period_hints=seam_period_hints,
                grid_starts=grid_starts_v,
                seam_infos=seam_infos,
            )
            ss = verification["seam_summary"]
            loud = verification.get("loudness") or {}
            print(
                f"[verify] passed={verification['passed']} "
                f"seams perfect/ok/off={ss['perfect']}/{ss['ok']}/{ss['off']} "
                f"worst={ss['worst_phase_beats']} "
                f"lufs={loud.get('lufs')} tp={loud.get('true_peak_db')}"
            )
            for prob in verification["problems"]:
                print(f"[verify] PROBLEM: {prob}")
            try:
                out_path.with_suffix(".verify.json").write_text(
                    json.dumps(verification, indent=2), encoding="utf-8"
                )
            except Exception:
                pass
        except Exception as e:
            print(f"[verify] verification crashed: {e}")
            verification = {"passed": False, "problems": [f"verifier crashed: {e}"]}

    render_id = uuid.uuid4().hex
    record = db.add_render(render_id, "videos/" + out_path.relative_to(VIDEOS_DIR).as_posix(), config)
    # Seam moments (each incoming drop's kick) on the final timeline — the
    # fade END of each transition. Useful for verification and UI markers.
    try:
        import soundfile as sf
        lens = [sf.info(str(p)).frames / sf.info(str(p)).samplerate for p in clip_audios]
        seams = []
        cursor = lens[0]
        for i in range(1, len(lens)):
            seams.append(cursor)
            cursor = cursor + lens[i] - crossfade_durations[i - 1]
        record["seam_times"] = seams
        record["crossfades"] = [float(c) for c in crossfade_durations]
    except Exception:
        record["seam_times"] = []
    if verification is not None:
        record["verification"] = verification

    # Companion vertical Short reframing the mix itself (option: make_short).
    if bool(config.get("make_short", True)) and not proxy:
        try:
            import soundfile as sf
            lens = [
                sf.info(str(p)).frames / sf.info(str(p)).samplerate
                for p in clip_audios
            ]
            mix_len = sum(lens) - sum(crossfade_durations)
            titles = [
                (clips[i].get("title") or _display_title(srcs[i]))
                for i in range(len(srcs))
            ]
            spans = compute_title_windows(
                lens, crossfade_durations, switch_at="end",
                kick_offsets=[float(si.get("kick_offset") or 0.0) for si in seam_infos],
            )
            short_windows = [(titles[i], s, e) for i, (s, e) in enumerate(spans)]
            short_path = _render_short(
                concat_video, final_audio, short_windows, mix_len,
                out_path, work, progress, title_font=title_font,
            )
            if short_path is not None:
                record["short_path"] = "videos/" + short_path.relative_to(VIDEOS_DIR).as_posix()
        except Exception as e:
            print(f"[short] failed, keeping the main mix: {e}")

    if progress:
        progress("render", 100.0, "Done")

    try:
        shutil.rmtree(work, ignore_errors=True)
    except Exception:
        pass

    return record
