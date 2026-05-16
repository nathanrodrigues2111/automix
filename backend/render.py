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

from . import analysis as analysis_mod
from . import db

BACKEND_DIR = Path(__file__).parent
PROJECT_ROOT = BACKEND_DIR.parent
VIDEOS_DIR = PROJECT_ROOT / "videos"
RENDER_TMP_DIR = BACKEND_DIR / ".cache" / "renders"

ProgressCb = Callable[[str, float, str], None] | None


def _has_rubberband() -> bool:
    return shutil.which("rubberband") is not None


def _bars_to_seconds(bars: float, bpm: float, beats_per_bar: int = 4) -> float:
    if bpm <= 0:
        return 0.0
    return (bars * beats_per_bar) * (60.0 / bpm)


def _trim_video_clip(src: Path, start_s: float, duration_s: float, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-ss", f"{start_s:.3f}", "-i", str(src),
        "-t", f"{duration_s:.3f}",
        "-c:v", "libx264", "-crf", "18", "-preset", "medium",
        "-c:a", "aac", "-b:a", "320k",
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
    """Time-stretch via pyrubberband. ratio = target_duration / source_duration."""
    import soundfile as sf

    if abs(ratio - 1.0) < 0.005 or not _has_rubberband():
        shutil.copy(in_wav, out_wav)
        return
    y, sr = sf.read(str(in_wav), always_2d=True)
    import pyrubberband as pyrb
    # pyrb.time_stretch's "rate" speeds up audio: rate>1 -> shorter.
    # If we want output duration = ratio * input_duration -> rate = 1/ratio.
    rate = 1.0 / ratio
    stretched_channels = [pyrb.time_stretch(y[:, c], sr, rate) for c in range(y.shape[1])]
    minlen = min(len(c) for c in stretched_channels)
    out = np.stack([c[:minlen] for c in stretched_channels], axis=1)
    sf.write(str(out_wav), out, sr)


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
    fade_out = np.cos(fade)[:, None]
    fade_in = np.sin(fade)[:, None]
    tail = a[-n_fade:] * fade_out
    head = b[:n_fade] * fade_in
    mixed = tail + head
    out = np.concatenate([a[:-n_fade], mixed, b[n_fade:]], axis=0)
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


def _concat_videos(parts: list[Path], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        for p in parts:
            f.write(f"file '{p.resolve()}'\n")
        list_path = f.name
    try:
        cmd = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0",
            "-i", list_path,
            "-c:v", "libx264", "-crf", "18", "-preset", "medium",
            "-c:a", "aac", "-b:a", "320k",
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
) -> dict[str, Any]:
    """Main render pipeline.

    track_resolver(track_id) -> absolute path to source MP4.
    Returns {"id", "output_path", "created_at", "config"}.
    """
    clips = config["clips"]
    target_bpm = float(config["target_bpm"])
    crossfade_bars = float(config.get("crossfade_bars", 1.0))
    target_lufs = float(config.get("loudness_lufs", -14.0))
    use_stem_cf = bool(config.get("use_stem_crossfade", True))

    RENDER_TMP_DIR.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="automix_", dir=str(RENDER_TMP_DIR)))

    if progress:
        progress("render", 1.0, "Preparing clips")

    clip_videos: list[Path] = []
    clip_audios: list[Path] = []
    clip_stems: list[dict[str, Path] | None] = []

    n_clips = len(clips)
    for idx, clip in enumerate(clips):
        track_id = clip["track_id"]
        src = track_resolver(track_id)
        cached = db.get_analysis(analysis_mod.file_hash(src))
        if not cached:
            raise RuntimeError(f"track {track_id} not analyzed")
        src_bpm = float(cached["bpm"])
        clip_len_s = _bars_to_seconds(float(clip["length_bars"]), src_bpm)
        ratio = src_bpm / target_bpm if target_bpm > 0 else 1.0  # output duration = input/ratio... actually we want target bpm faster -> shorter
        # If target_bpm > src_bpm, output should be faster -> shorter -> ratio<1
        # output_duration = clip_len_s * (src_bpm / target_bpm)
        out_ratio = src_bpm / target_bpm

        clip_dir = work / f"clip_{idx:02d}"
        clip_dir.mkdir(parents=True, exist_ok=True)

        # Video: trim then time-stretch (setpts to match audio length)
        raw_video = clip_dir / "video_raw.mp4"
        _trim_video_clip(src, float(clip["start_s"]), clip_len_s, raw_video)

        stretched_video = clip_dir / "video.mp4"
        if abs(out_ratio - 1.0) > 0.005:
            cmd = [
                "ffmpeg", "-y", "-i", str(raw_video),
                "-filter:v", f"setpts={out_ratio}*PTS",
                "-an",
                "-c:v", "libx264", "-crf", "18", "-preset", "medium",
                "-pix_fmt", "yuv420p",
                str(stretched_video),
            ]
            subprocess.run(cmd, check=True, capture_output=True)
        else:
            shutil.copy(raw_video, stretched_video)

        # Audio path
        raw_audio = clip_dir / "audio_raw.wav"
        _extract_clip_audio(src, float(clip["start_s"]), clip_len_s, raw_audio)
        stretched_audio = clip_dir / "audio_stretched.wav"
        _time_stretch_wav(raw_audio, stretched_audio, out_ratio)
        normed_audio = clip_dir / "audio.wav"
        _loudnorm_two_pass(stretched_audio, normed_audio, target_lufs)

        # Stems (trim from cached full-track stems and stretch)
        stems = None
        if use_stem_cf:
            fh = analysis_mod.file_hash(src)
            stems_src = analysis_mod.STEMS_CACHE_DIR / fh
            stems = _separate_clip_stems(stems_src, float(clip["start_s"]), clip_len_s, out_ratio, clip_dir / "stems")

        clip_videos.append(stretched_video)
        clip_audios.append(normed_audio)
        clip_stems.append(stems)

        if progress:
            pct = 5.0 + (idx + 1) / max(n_clips, 1) * 60.0
            progress("render", pct, f"Prepared clip {idx + 1}/{n_clips}")

    # Build final audio with crossfades between consecutive clips.
    if progress:
        progress("render", 70.0, "Mixing audio with crossfades")
    crossfade_s = _bars_to_seconds(crossfade_bars, target_bpm)

    current_audio = clip_audios[0]
    for i in range(1, n_clips):
        merged = work / f"merged_{i:02d}.wav"
        a_stems = clip_stems[i - 1]
        b_stems = clip_stems[i]
        if use_stem_cf and a_stems and b_stems:
            # Mix the previous merged with stems mix only at boundary.
            # Practical approach: use simple equal-power crossfade on the
            # full normalized audios; stem-aware shaped fade applied to
            # boundary region only.
            try:
                _stem_aware_crossfade(
                    {k: v for k, v in a_stems.items()},
                    {k: v for k, v in b_stems.items()},
                    crossfade_s,
                    merged,
                )
            except Exception:
                _equal_power_crossfade(current_audio, clip_audios[i], crossfade_s, merged)
        else:
            _equal_power_crossfade(current_audio, clip_audios[i], crossfade_s, merged)
        current_audio = merged

    final_audio = current_audio

    # Build final video by concatenating clip videos.
    if progress:
        progress("render", 85.0, "Concatenating video")
    concat_video = work / "video_concat.mp4"
    if len(clip_videos) == 1:
        shutil.copy(clip_videos[0], concat_video)
    else:
        _concat_videos(clip_videos, concat_video)

    if progress:
        progress("render", 93.0, "Muxing video and audio")
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = VIDEOS_DIR / f"automix_{ts}.mp4"
    VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
    _mux_video_audio(concat_video, final_audio, out_path)

    render_id = uuid.uuid4().hex
    record = db.add_render(render_id, str(out_path.relative_to(PROJECT_ROOT)), config)

    if progress:
        progress("render", 100.0, "Done")

    try:
        shutil.rmtree(work, ignore_errors=True)
    except Exception:
        pass

    return record
