# NOTE: This module uses pyrubberband which requires the `rubberband` CLI binary
# to be available on PATH. On Debian/Ubuntu install with:
#   sudo apt-get install rubberband-cli
# If the binary is missing at runtime, time-stretching is skipped and the
# original clip BPM is used (mix will still render but beats may not align).
from __future__ import annotations

import json
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
import youtube as youtube_mod

BACKEND_DIR = Path(__file__).parent
PROJECT_ROOT = BACKEND_DIR.parent
VIDEOS_DIR = PROJECT_ROOT / "videos"
EXPORTS_DIR = VIDEOS_DIR / "exports"
RENDER_TMP_DIR = BACKEND_DIR / ".cache" / "renders"
ASSETS_DIR = PROJECT_ROOT / "assets"
LOGO_PATH = ASSETS_DIR / "edmpapa11.png"
BARS_PATH = ASSETS_DIR / "black-bars.png"
FONT_PATH = ASSETS_DIR / "Bebas-Regular.ttf"

# EDMPAPA branding geometry (1920x1080 canvas).
_BRAND_W = 1920
_BRAND_H = 1080
_BAR_H = 140
_LOGO_H = 84
_TITLE_FONT_SIZE = 56
_LOGO_MARGIN_RIGHT = 48

ProgressCb = Callable[[str, float, str], None] | None


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
    sf.write(str(out_wav), out, sr)


def _x264_encode_args(proxy: bool) -> list[str]:
    """Encoder settings only — for use after a -filter_complex chain or any
    case where the video has already been normalized."""
    if proxy:
        return ["-c:v", "libx264", "-crf", "28", "-preset", "ultrafast"]
    return ["-c:v", "libx264", "-crf", "17", "-preset", "medium"]


def _x264_args(proxy: bool) -> list[str]:
    """Full args: scale to a consistent resolution + encode. Used by trim/concat
    to ensure clips have IDENTICAL dimensions before downstream filters —
    xfade errors out on mismatched inputs, so crop-fill to a fixed canvas
    (plain scale=-2:H keeps the source aspect and widths then differ)."""
    w, h = (1280, 720) if proxy else (_BRAND_W, _BRAND_H)
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"
    return ["-vf", vf, *_x264_encode_args(proxy)]


def _trim_video_clip(src: Path, start_s: float, duration_s: float, out: Path, proxy: bool = False) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    a_bitrate = "192k" if proxy else "320k"
    # Force a constant 30 fps + 44.1 kHz stereo so all clips have IDENTICAL
    # framerate and audio params. Mixed framerates (25 vs 23.976) cause the
    # concat demuxer to emit a video with bad timestamps, doubling duration.
    cmd = [
        "ffmpeg", "-y", "-ss", f"{start_s:.3f}", "-i", str(src),
        "-t", f"{duration_s:.3f}",
        "-r", "30",
        *_x264_args(proxy),
        "-c:a", "aac", "-b:a", a_bitrate, "-ar", "44100", "-ac", "2",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(out),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _extract_clip_audio(src: Path, start_s: float, duration_s: float, out_wav: Path, sr: int = 44100) -> None:
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-ss", f"{start_s:.3f}", "-i", str(src),
        "-t", f"{duration_s:.3f}",
        "-vn", "-ac", "2", "-ar", str(sr), "-acodec", "pcm_s16le",
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
        sf.write(str(out_wav), out, sr)
        return
    # atempo factor is a speed multiplier (>1 = faster/shorter); valid 0.5-100.
    tempo = max(0.5, min(2.0, 1.0 / ratio))
    cmd = [
        "ffmpeg", "-y", "-i", str(in_wav),
        "-af", f"atempo={tempo:.6f}",
        "-ar", "44100", "-ac", "2", str(out_wav),
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
    sf.write(str(out_wav), y, out_sr)


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
        sf.write(str(out_wav), out, sr)
        return
    fade = np.linspace(0, np.pi / 2, n_fade)
    # Asymmetric blend: the outgoing decays fast (steeper-than-equal-power
    # curve, ~ -2.5 dB tilt) while the incoming rises early, so the incoming
    # track's vocal/riser build reads clearly on top of the outgoing tail
    # instead of fighting it.
    fade_out = ((np.cos(fade) ** 1.6) * 0.75)[:, None]
    fade_in = (np.sin(fade) ** 0.85)[:, None]
    tail = a[-n_fade:] * fade_out
    head = b[:n_fade] * fade_in
    mixed = tail + head
    peak = float(np.max(np.abs(mixed))) if mixed.size else 0.0
    if peak > 0.999:
        mixed *= 0.999 / peak
    out = np.concatenate([a[:-n_fade], mixed, b[n_fade:]], axis=0)
    sf.write(str(out_wav), out, sr)


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

    # Drums + vocals + other: equal-power crossfade, with the outgoing tail
    # ~2 dB under the incoming head so the next drop's vocal reads clearly
    # through the transition (subtle emphasis, not a volume jump).
    tail = (a_t_d + a_t_v + a_t_o) * fout * 0.79
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
    peak = float(np.max(np.abs(mixed))) if mixed.size else 0.0
    if peak > 0.999:
        mixed *= 0.999 / peak
    out = np.concatenate([a_full[:-n_fade], mixed, b_full[n_fade:]], axis=0)
    sf.write(str(out_wav), out, sr)


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
    sf.write(str(out_wav), out, sr)


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
    durations: list[float], crossfades_s: list[float]
) -> list[tuple[float, float]]:
    """Per-part [start, end) windows in the FINAL (post-xfade) timeline.

    Uses the same offset math as _xfade_videos: part i starts at
    s_i = s_{i-1} + d_{i-1} - cf_{i-1}; the title switches at each xfade
    END (offset_i + cf_i) — that's exactly where the incoming clip's kick
    slams in, so the new title lands ON the drop. Pure function so it's
    unit-testable.
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
        switches.append(offset + cf)
        cumulative = cumulative + durations[i] - cf
    total = cumulative
    windows: list[tuple[float, float]] = []
    prev = 0.0
    for i in range(len(durations)):
        end = switches[i] if i < len(switches) else total
        windows.append((prev, end))
        prev = end
    return windows


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


def _write_title_ass(title_windows: list[tuple[str, float, float]], out_ass: Path) -> None:
    """Build an ASS subtitle file with one centered title per window, anchored
    in the middle of the bottom letterbox bar. Rendered with the libass `ass`
    filter (this ffmpeg build has no drawtext) using fontsdir=ASSETS_DIR so
    Cubano.ttf needs no system install."""
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
        f"Style: Title,Bebas,{_TITLE_FONT_SIZE},&H00FFFFFF,&H00FFFFFF,"
        "&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for title, start_s, end_s in title_windows:
        if end_s <= start_s:
            continue
        txt = _ass_escape(title.upper())
        lines.append(
            f"Dialogue: 0,{_ass_time(start_s)},{_ass_time(end_s)},Title,,0,0,0,,"
            f"{{\\pos({_BRAND_W // 2},{y_center})}}{txt}"
        )
    out_ass.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _display_title(src: Path) -> str:
    """Overlay title for a source track: track_meta title if imported via
    YouTube, else a cleaned-up filename stem."""
    meta = db.get_track_meta(analysis_mod.file_hash(src))
    if meta and meta.get("title"):
        return meta["title"]
    return youtube_mod.clean_title(src.stem)


def _apply_branding(
    video_in: Path,
    out_path: Path,
    title_windows: list[tuple[str, float, float]],
    proxy: bool,
    brand_start: float = 0.0,
) -> None:
    """EDMPAPA branding pass: crop-fill to 1920x1080, draw black letterbox
    bars OVER the video (top+bottom, 140px), overlay the logo in the top bar
    and render one title per (title, start_s, end_s) window in the bottom bar
    (via a libass subtitle track — this ffmpeg build ships without drawtext)."""
    have_logo = LOGO_PATH.exists()
    have_font = FONT_PATH.exists()
    if not have_logo:
        print(f"[render] branding: logo missing at {LOGO_PATH}, skipping logo")
    if not have_font and title_windows:
        print(f"[render] branding: font missing at {FONT_PATH}, skipping titles")

    filters: list[str] = []
    label = "base"
    # brand_start > 0: during the intro animation the full branding (with
    # the wordmark) is replaced by plain letterbox bars (black-bars.png);
    # the wordmark pops in exactly when the intro ends (first drop's kick).
    en = f":enable='gte(t,{brand_start:.3f})'" if brand_start > 0 else ""
    have_bars = brand_start > 0 and BARS_PATH.exists()
    filters.append(
        f"[0:v]scale={_BRAND_W}:{_BRAND_H}:force_original_aspect_ratio=increase,"
        f"crop={_BRAND_W}:{_BRAND_H},setsar=1,"
        f"drawbox=x=0:y=0:w=iw:h={_BAR_H}:color=black:t=fill,"
        f"drawbox=x=0:y=ih-{_BAR_H}:w=iw:h={_BAR_H}:color=black:t=fill[{label}]"
    )
    if have_bars:
        bars_idx = 2 if have_logo else 1
        filters.append(
            f"[{label}][{bars_idx}:v]overlay=x=0:y=0:"
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
            filters.append(f"[{label}][1:v]overlay=x=0:y=0{en}[branded]")
        else:
            filters.append(f"[1:v]scale=-1:{_LOGO_H}[logo]")
            filters.append(
                f"[{label}][logo]overlay=x=W-w-{_LOGO_MARGIN_RIGHT}:"
                f"y=({_BAR_H}-{_LOGO_H})/2{en}[branded]"
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
            ass_path = Path(tmp) / "titles.ass"
            _write_title_ass(title_windows, ass_path)
            filters.append(
                f"[{label}]ass=filename='{ass_path}':fontsdir='{ASSETS_DIR}'[titled]"
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
            *_x264_encode_args(proxy),
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
        *_x264_encode_args(proxy),
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
    """Append a black + silent outro for YouTube end screens (they occupy
    the last 5-20s of a video, so 20s is the standard reservation). Encodes
    a matching black segment and concat-copies it — no full re-encode."""
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
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-t", f"{outro_s:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "320k", "-ar", "44100", "-ac", "2",
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

    clip_videos: list[Path] = []
    clip_audios: list[Path] = []
    clip_stems: list[dict[str, Path] | None] = []
    clip_ratios: list[float] = []

    def _check_cancel() -> None:
        if cancel and cancel():
            raise RuntimeError("cancelled")

    n_clips = len(clips)
    for idx, clip in enumerate(clips):
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
            first_kick_out = (
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
        clip_ratios.append(out_ratio)

        clip_dir = work / f"clip_{idx:02d}"
        clip_dir.mkdir(parents=True, exist_ok=True)

        # Video: trim then time-stretch via setpts.
        raw_video = clip_dir / "video_raw.mp4"
        _trim_video_clip(src, start_s, clip_len_s, raw_video, proxy=proxy)

        stretched_video = clip_dir / "video.mp4"
        if abs(out_ratio - 1.0) > 0.005:
            cmd = [
                "ffmpeg", "-y", "-i", str(raw_video),
                "-filter:v", f"setpts={out_ratio}*PTS",
                "-an",
                *_x264_args(proxy),
                "-pix_fmt", "yuv420p",
                str(stretched_video),
            ]
            subprocess.run(cmd, check=True, capture_output=True)
        else:
            shutil.copy(raw_video, stretched_video)

        # Audio path: extract → time-stretch → pitch-shift → loudnorm.
        raw_audio = clip_dir / "audio_raw.wav"
        _extract_clip_audio(src, start_s, clip_len_s, raw_audio)
        stretched_audio = clip_dir / "audio_stretched.wav"
        _time_stretch_wav(raw_audio, stretched_audio, out_ratio)
        shifted_audio = clip_dir / "audio_shifted.wav"
        _pitch_shift_wav(stretched_audio, shifted_audio, pitch_shifts[idx])
        normed_audio = clip_dir / "audio.wav"
        if proxy:
            # Single-pass loudnorm for speed.
            cmd = [
                "ffmpeg", "-y", "-i", str(shifted_audio),
                "-af", f"loudnorm=I={target_lufs}:LRA=11:TP=-1.5",
                "-ar", "44100", "-ac", "2", str(normed_audio),
            ]
            subprocess.run(cmd, check=True, capture_output=True)
        else:
            _loudnorm_two_pass(shifted_audio, normed_audio, target_lufs)

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

        clip_videos.append(stretched_video)
        clip_audios.append(normed_audio)
        clip_stems.append(stems)

        if progress:
            pct = 5.0 + (idx + 1) / max(n_clips, 1) * 60.0
            progress("render", pct, f"Prepared clip {idx + 1}/{n_clips}")

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

    def _kick_align_crossfade(a_wav: Path, b_wav: Path, planned_cf: float, kb_expected: float) -> float:
        """Nudge the crossfade length so the incoming clip's first drop kick
        lands exactly on the outgoing audio's measured kick grid. All the
        upstream anchors (BPM estimates, kick refinement, seek/stretch
        rounding) carry small deterministic biases that stack into an audible
        0.1-0.4 beat stumble; measuring both FINAL wavs with the same method
        cancels them out."""
        try:
            import soundfile as sf
            from scipy.signal import butter, sosfiltfilt, find_peaks

            def _env(path: Path, t0: float, t1: float):
                y, esr = sf.read(str(path), always_2d=True)
                y = y.mean(axis=1)
                s0, s1 = int(max(0.0, t0) * esr), min(len(y), int(t1 * esr))
                y = y[s0:s1]
                sos = butter(4, 150.0, btype="lowpass", fs=esr, output="sos")
                yl = sosfiltfilt(sos, y)
                ehop = 512
                n = len(yl) // ehop
                env = np.sqrt(np.mean(yl[: n * ehop].reshape(n, ehop) ** 2, axis=1))
                return env, esr, ehop, max(0.0, t0)

            def _peak_times(env, esr, ehop, off, prom):
                pk, _ = find_peaks(
                    env, distance=max(1, int(0.25 * esr / ehop)), prominence=prom
                )
                out = []
                for pi in pk:
                    i0 = int(pi)
                    o = 0.0
                    if 0 < i0 < len(env) - 1:
                        a_, m_, c_ = env[i0 - 1], env[i0], env[i0 + 1]
                        den = a_ - 2 * m_ + c_
                        if abs(den) > 1e-12:
                            o = float(np.clip(0.5 * (a_ - c_) / den, -0.5, 0.5))
                    out.append((i0 + o) * ehop / esr + off)
                return np.asarray(out)

            info = sf.info(str(a_wav))
            a_len = info.frames / info.samplerate
            # Search up to 14s back: a drop that dies early leaves no kicks
            # right at the end, but its steady grid further back still
            # defines where the next kick belongs.
            env, esr, ehop, off = _env(a_wav, a_len - 14.0, a_len)
            times = _peak_times(env, esr, ehop, off, float(np.max(env)) * 0.15)
            if len(times) < 6:
                return planned_cf
            ivs = np.diff(times)
            period = float(np.median(ivs))
            if not 0.25 <= period <= 1.0:
                return planned_cf
            # Anchor on the last kick that sits ON the steady grid (last kick
            # of a run of near-period intervals) — empirically the most
            # reliable anchor across this library; averaging approaches get
            # dragged by the clip's own lead-in pulses.
            ph = float(times[-1])
            for j in range(len(ivs) - 1, -1, -1):
                if abs(ivs[j] - period) < 0.12 * period:
                    ph = float(times[j + 1])
                    break
            envb, esrb, ehopb, offb = _env(b_wav, kb_expected - 1.0, kb_expected + 1.0)
            tb = _peak_times(envb, esrb, ehopb, offb, float(np.max(envb)) * 0.25)
            if not len(tb):
                return planned_cf
            # Peak NEAREST the expected kick — the lead-in often carries a
            # riser bass pulse a beat early, which must not win.
            kb = float(tb[int(np.argmin(np.abs(tb - kb_expected)))])
            # Alignment is modulo one kick period: choose the outgoing grid
            # point that keeps the crossfade closest to plan. Picking the
            # point nearest the clip end instead led to half-beat-ambiguous
            # choices (and bails) whenever the needed shift was ~0.5 beats.
            k = round((a_len + kb - planned_cf - ph) / period)
            t_next = ph + k * period
            cf = a_len + kb - t_next
            if cf < 0.2:
                print(
                    f"[align] BAIL cf={cf:.3f} planned={planned_cf:.3f} "
                    f"period={period:.3f} kb={kb:.3f} t_next={t_next:.3f} a_len={a_len:.3f}"
                )
                return planned_cf
            print(f"[align] cf {planned_cf:.3f} -> {cf:.3f} (Δ {cf-planned_cf:+.3f}s)")
            return float(cf)
        except Exception:
            return planned_cf

    # IMPORTANT: stem-aware crossfade functions take *full clean clips* on both
    # sides — they can't accept the running merged audio (which is already
    # mixed-down). So we only use them on the FIRST transition (i==1). For
    # subsequent merges (i>=2) we fall back to equal-power against the running
    # current_audio. Before this fix, the stem-aware branches were dropping
    # everything earlier than clip[i-1] from the mix.
    current_audio = clip_audios[0]
    crossfade_durations: list[float] = []
    for i in range(1, n_clips):
        _check_cancel()
        merged = work / f"merged_{i:02d}.wav"
        a_stems = clip_stems[i - 1]
        b_stems = clip_stems[i]
        cf_s = _crossfade_for(clips[i], clip_ratios[i])
        kick = clips[i].get("kick_s")
        start = clips[i].get("start_s")
        if kick is not None and start is not None and float(kick) > float(start):
            kb_expected = (float(kick) - float(start)) * clip_ratios[i]
            cf_s = _kick_align_crossfade(current_audio, clip_audios[i], cf_s, kb_expected)
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
        _xfade_videos(
            clip_videos, crossfade_durations, concat_video,
            proxy=proxy, durations=audio_lens,
        )

    # Gentle tail fade so the mix doesn't stop on a hard cut before the outro.
    outro_s = float(config.get("outro_s", 20.0))
    if outro_s > 0:
        try:
            import soundfile as sf
            y_fin, sr_fin = sf.read(str(final_audio), always_2d=True)
            n_fade = min(len(y_fin), int(1.5 * sr_fin))
            if n_fade > 0:
                curve = np.cos(np.linspace(0, np.pi / 2, n_fade))[:, None]
                y_fin[-n_fade:] = y_fin[-n_fade:] * curve
                sf.write(str(final_audio), y_fin, sr_fin)
        except Exception:
            pass

    _check_cancel()
    if progress:
        progress("render", 93.0, "Muxing")
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = EXPORTS_DIR / f"automix_{ts}.mp4"
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    if brand_overlay:
        muxed = work / "muxed.mp4"
        _mux_video_audio(concat_video, final_audio, muxed)
        if progress:
            progress("render", 96.0, "Applying EDMPAPA branding")
        windows: list[tuple[str, float, float]] = []
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
            spans = compute_title_windows(durations, crossfade_durations)
            if intro_dur > 0 and first_kick_out > 0 and spans:
                # No title under the intro animation — the first title
                # appears when the intro ends (on the first kick).
                s0, e0 = spans[0]
                spans[0] = (min(first_kick_out, max(s0, e0 - 0.1)), e0)
            windows = [(titles[i], s, e) for i, (s, e) in enumerate(spans)]
        _apply_branding(
            muxed, out_path, windows, proxy,
            brand_start=first_kick_out if intro_dur > 0 else 0.0,
        )
    else:
        _mux_video_audio(concat_video, final_audio, out_path)

    if intro_dur > 0 and first_kick_out > 0:
        if progress:
            progress("render", 97.0, "Compositing intro overlay")
        _overlay_intro(out_path, intro_path, first_kick_out, intro_dur, work, proxy)

    if outro_s > 0:
        if progress:
            progress("render", 98.0, "Appending YouTube outro")
        _append_black_outro(out_path, outro_s, work)

    render_id = uuid.uuid4().hex
    record = db.add_render(render_id, str(out_path.relative_to(PROJECT_ROOT)), config)
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

    if progress:
        progress("render", 100.0, "Done")

    try:
        shutil.rmtree(work, ignore_errors=True)
    except Exception:
        pass

    return record
