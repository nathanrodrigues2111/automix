from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable

import numpy as np

BACKEND_DIR = Path(__file__).parent
STEMS_CACHE_DIR = BACKEND_DIR / ".cache" / "stems"
WAV_CACHE_DIR = BACKEND_DIR / ".cache" / "wavs"

ProgressCb = Callable[[str, float, str], None] | None


# Krumhansl-Schmuckler key profiles.
_KS_MAJOR = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
_KS_MINOR = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)
_PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Pitch class (major / minor flag) -> Camelot code
_CAMELOT_MAJOR = {
    "B": "1B", "F#": "2B", "Gb": "2B", "C#": "3B", "Db": "3B",
    "G#": "4B", "Ab": "4B", "D#": "5B", "Eb": "5B", "A#": "6B", "Bb": "6B",
    "F": "7B", "C": "8B", "G": "9B", "D": "10B", "A": "11B", "E": "12B",
}
_CAMELOT_MINOR = {
    "G#": "1A", "Ab": "1A", "D#": "2A", "Eb": "2A", "A#": "3A", "Bb": "3A",
    "F": "4A", "C": "5A", "G": "6A", "D": "7A", "A": "8A", "E": "9A",
    "B": "10A", "F#": "11A", "Gb": "11A", "C#": "12A", "Db": "12A",
}


def file_hash(path: Path) -> str:
    p = path.resolve()
    h = hashlib.sha256()
    h.update(str(p).encode())
    try:
        h.update(str(p.stat().st_size).encode())
    except FileNotFoundError:
        pass
    return h.hexdigest()


def short_id(path: Path) -> str:
    return file_hash(path)[:16]


def _ensure_dirs() -> None:
    STEMS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    WAV_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def extract_wav(video_path: Path, out_wav: Path, sr: int = 44100) -> Path:
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    if out_wav.exists():
        return out_wav
    cmd = [
        "ffmpeg", "-y", "-i", str(video_path),
        "-vn", "-ac", "2", "-ar", str(sr), "-acodec", "pcm_s16le",
        str(out_wav),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return out_wav


def ffprobe_info(video_path: Path) -> dict[str, Any]:
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(video_path),
    ]
    out = subprocess.run(cmd, check=True, capture_output=True).stdout
    return json.loads(out)


def probe_basic(video_path: Path) -> dict[str, Any]:
    info = ffprobe_info(video_path)
    duration = float(info.get("format", {}).get("duration", 0.0))
    size = int(info.get("format", {}).get("size", video_path.stat().st_size))
    vcodec = ""
    acodec = ""
    for s in info.get("streams", []):
        if s.get("codec_type") == "video" and not vcodec:
            vcodec = s.get("codec_name", "")
        elif s.get("codec_type") == "audio" and not acodec:
            acodec = s.get("codec_name", "")
    return {
        "duration_s": duration,
        "size_bytes": size,
        "codec_video": vcodec,
        "codec_audio": acodec,
    }


def measure_lufs(wav_path: Path) -> float:
    """Single-pass loudnorm measurement; returns integrated LUFS."""
    cmd = [
        "ffmpeg", "-i", str(wav_path),
        "-af", "loudnorm=I=-14:LRA=11:TP=-1.5:print_format=json",
        "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    stderr = proc.stderr.decode("utf-8", errors="ignore")
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr)
    if not m:
        return -14.0
    try:
        data = json.loads(m.group(0))
        return float(data.get("input_i", -14.0))
    except Exception:
        return -14.0


def detect_key_camelot(y: np.ndarray, sr: int) -> str:
    import librosa

    if y.ndim > 1:
        y_mono = librosa.to_mono(y)
    else:
        y_mono = y
    chroma = librosa.feature.chroma_cqt(y=y_mono, sr=sr)
    chroma_mean = chroma.mean(axis=1)
    chroma_mean = chroma_mean / (chroma_mean.sum() + 1e-9)

    best_score = -np.inf
    best_label = ("C", "major")
    for shift in range(12):
        for mode_name, profile in (("major", _KS_MAJOR), ("minor", _KS_MINOR)):
            rotated = np.roll(profile, shift)
            rotated_norm = rotated / (rotated.sum() + 1e-9)
            score = float(np.corrcoef(chroma_mean, rotated_norm)[0, 1])
            if score > best_score:
                best_score = score
                best_label = (_PITCH_NAMES[shift], mode_name)
    pitch, mode = best_label
    if mode == "major":
        return _CAMELOT_MAJOR.get(pitch, "8B")
    return _CAMELOT_MINOR.get(pitch, "8A")


def _snap_to_downbeat(t: float, downbeats: list[float]) -> float:
    if not downbeats:
        return t
    return min(downbeats, key=lambda d: abs(d - t))


def find_drops(
    wav_path: Path,
    downbeats: list[float],
    bpm: float,
    max_drops: int = 5,
    min_separation_s: float = 30.0,
) -> list[dict[str, Any]]:
    """Detect EDM drop *moments* — the points where energy jumps from a
    quiet section (buildup/breakdown) into a loud section (the main drop).

    Returns list of {start_s, end_s, score} where start_s = drop_moment − 5s
    (captures the buildup), all snapped to downbeats.
    """
    import librosa
    from scipy.signal import find_peaks

    y, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    duration = len(y) / sr
    if y.size == 0:
        return []

    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    if rms.size == 0:
        return []

    # Drop score = mean energy in the next 2s minus mean energy in the prior
    # 4s. A drop is "quiet then suddenly loud," which spikes this delta. This
    # avoids the previous bug where we found the *middle* of sustained loud
    # sections instead of where the bass kicks in.
    win_after = max(1, int(2.0 * sr / hop))
    win_before = max(1, int(4.0 * sr / hop))
    score = np.zeros_like(rms)
    for i in range(win_before, len(rms) - win_after):
        before = float(np.mean(rms[i - win_before : i]))
        after = float(np.mean(rms[i : i + win_after]))
        score[i] = after - before

    if np.max(score) <= 0:
        return []

    height = float(np.max(score) * 0.45)
    distance = max(1, int(min_separation_s * sr / hop))
    peaks, props = find_peaks(score, height=height, distance=distance)
    if len(peaks) == 0:
        return []

    heights = props["peak_heights"]
    order = np.argsort(-heights)[:max_drops]

    # Per-drop analysis: scan FORWARD from the peak to find the natural drop
    # end (where energy falls back to baseline), and scan BACKWARD to find the
    # natural buildup start (lowest energy in the lookback window). Clamped to
    # sensible ranges so a fluke doesn't produce a 1-second clip or a 60-second
    # one.
    # Tuned against the reference EDMPAPA mix (014oXybzUkc): kicks land every
    # ~19s, buildups run 4-7s, drop bodies sustain 4-9s. Clip = buildup + body.
    min_buildup_s = 2.0
    max_buildup_s = 8.0
    min_drop_len_s = 8.0
    max_drop_len_s = 10.0

    # Smoothed RMS for measuring sustained drop energy (~0.5s window).
    rms_smooth_win = max(1, int(0.5 * sr / hop))
    rms_smooth = np.convolve(rms, np.ones(rms_smooth_win) / rms_smooth_win, mode="same")

    def _scan_drop_end(peak_idx: int) -> float:
        peak_rms = float(rms_smooth[peak_idx])
        threshold = peak_rms * 0.55
        guard_frames = int(2.0 * sr / hop)
        for j in range(peak_idx + guard_frames, len(rms_smooth)):
            if rms_smooth[j] < threshold:
                return float(librosa.frames_to_time(j, sr=sr, hop_length=hop))
        return duration

    def _scan_buildup_start(peak_idx: int) -> float:
        # Look back at most `max_buildup_s` worth of frames; pick the minimum
        # energy point — that's where the buildup energy started rising.
        look_back = int(max_buildup_s * sr / hop)
        start_idx = max(0, peak_idx - look_back)
        if start_idx >= peak_idx:
            return float(librosa.frames_to_time(peak_idx, sr=sr, hop_length=hop))
        segment = rms_smooth[start_idx:peak_idx]
        min_offset = int(np.argmin(segment))
        return float(librosa.frames_to_time(start_idx + min_offset, sr=sr, hop_length=hop))

    bar_s = 4.0 * 60.0 / bpm if bpm > 0 else 1.875
    dbs = sorted(float(d) for d in downbeats) if downbeats else []

    drops: list[dict[str, Any]] = []
    for idx in order:
        peak_idx = int(peaks[idx])
        drop_t = float(librosa.frames_to_time(peak_idx, sr=sr, hop_length=hop))
        if drop_t < 15.0:
            continue

        # PHRASE-QUANTIZED cut: EDM sections are 4/8/16-bar phrases, so the
        # clip must end exactly N bars after the kick on the track's own beat
        # grid — energy thresholds land mid-phrase and feel like the track is
        # cut short or dragging past where the next drop should arrive.
        if dbs:
            kick_i = min(range(len(dbs)), key=lambda i: abs(dbs[i] - drop_t))
            kick_t = dbs[kick_i]
        else:
            kick_i = None
            kick_t = drop_t

        natural_end = _scan_drop_end(peak_idx)
        sustain_s = max(0.0, natural_end - kick_t)
        # 8 bars when the drop's energy actually sustains that long, else 4.
        n_bars = 8 if sustain_s >= 7.0 * bar_s else 4

        if kick_i is not None and len(dbs) > 1:
            # The grid may be spaced at 2 bars (half-tempo beat tracking that
            # was octave-corrected) — convert the bar count to grid steps.
            spacing = float(np.median(np.diff(dbs)))
            steps = max(1, round(n_bars * bar_s / spacing)) if spacing > 0 else n_bars
            if kick_i + steps < len(dbs):
                end = dbs[kick_i + steps]
            else:
                end = min(duration, kick_t + n_bars * bar_s)
        else:
            end = min(duration, kick_t + n_bars * bar_s)

        # A drop body shorter than ~3.5 bars (kick too close to the end of the
        # track) is unusable as a mix clip.
        if end - kick_t < 3.5 * bar_s:
            continue

        buildup_start_t = _scan_buildup_start(peak_idx)
        buildup_s = max(min_buildup_s, min(max_buildup_s, kick_t - buildup_start_t))
        desired_start = max(0.0, kick_t - buildup_s)
        start = _snap_to_downbeat(desired_start, dbs) if dbs else desired_start
        if start >= kick_t:
            start = max(0.0, kick_t - min_buildup_s)

        if end <= kick_t or end <= start:
            continue
        drops.append(
            {
                "start_s": float(start),
                "end_s": float(end),
                "kick_s": float(kick_t),
                "score": float(heights[idx]),
            }
        )

    drops.sort(key=lambda d: d["start_s"])
    return drops


def _run_allin1(wav_path: Path, progress: ProgressCb = None) -> dict[str, Any]:
    """Run allin1.analyze. Returns dict with bpm, beats, downbeats, segments."""
    if progress:
        progress("analysis", 20.0, "Running music structure analysis")
    import allin1  # type: ignore

    result = allin1.analyze(
        paths=[str(wav_path)],
        out_dir=None,
        keep_byproducts=False,
        overwrite=False,
        multiprocess=False,
    )
    r = result[0] if isinstance(result, list) else result
    bpm = float(getattr(r, "bpm", 0.0) or 0.0)
    beats = [float(b) for b in (getattr(r, "beats", None) or [])]
    downbeats = [float(b) for b in (getattr(r, "downbeats", None) or [])]
    segments = []
    for seg in getattr(r, "segments", []) or []:
        segments.append(
            {
                "start": float(getattr(seg, "start", seg.get("start", 0.0) if isinstance(seg, dict) else 0.0)),
                "end": float(getattr(seg, "end", seg.get("end", 0.0) if isinstance(seg, dict) else 0.0)),
                "label": str(getattr(seg, "label", seg.get("label", "") if isinstance(seg, dict) else "")),
            }
        )
    return {"bpm": bpm, "beats": beats, "downbeats": downbeats, "segments": segments}


def _fallback_structure(wav_path: Path) -> dict[str, Any]:
    """librosa-only fallback when allin1 isn't installed/working."""
    import librosa

    y, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])
    # librosa often locks onto half tempo for four-on-the-floor EDM (e.g. 63
    # instead of 126). Real EDM sits ~85-180 BPM; fold octave errors back in.
    while 0 < bpm < 85:
        bpm *= 2
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    beats = [float(b) for b in beat_times]
    downbeats = beats[::4] if beats else []

    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    duration = len(y) / sr
    if onset_env.size:
        smoothed = np.convolve(onset_env, np.ones(64) / 64, mode="same")
        peak_idx = int(np.argmax(smoothed[: int(0.7 * len(smoothed))]))
        drop_t = float(librosa.frames_to_time(peak_idx, sr=sr))
    else:
        drop_t = duration * 0.25
    drop_end = min(drop_t + 32.0, duration)
    segments = [
        {"start": 0.0, "end": drop_t, "label": "intro"},
        {"start": drop_t, "end": drop_end, "label": "chorus"},
        {"start": drop_end, "end": duration, "label": "outro"},
    ]
    return {"bpm": bpm, "beats": beats, "downbeats": downbeats, "segments": segments}


def _run_demucs(wav_path: Path, out_dir: Path, progress: ProgressCb = None) -> dict[str, Path] | None:
    """Run demucs separation. Returns dict of stem name -> wav path, or None on failure."""
    if (out_dir / "drums.wav").exists():
        return {n: out_dir / f"{n}.wav" for n in ("drums", "bass", "vocals", "other")}
    out_dir.mkdir(parents=True, exist_ok=True)
    if progress:
        progress("stems", 50.0, "Separating stems with demucs")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            cmd = [
                "python", "-m", "demucs.separate",
                "-n", "htdemucs",
                "--out", tmp,
                "-d", "cpu",
                str(wav_path),
            ]
            subprocess.run(cmd, check=True, capture_output=True)
            # demucs writes to <tmp>/htdemucs/<track_stem>/{drums,bass,vocals,other}.wav
            tmp_p = Path(tmp)
            found = list(tmp_p.rglob("drums.wav"))
            if not found:
                return None
            src_dir = found[0].parent
            for stem in ("drums", "bass", "vocals", "other"):
                shutil.move(str(src_dir / f"{stem}.wav"), str(out_dir / f"{stem}.wav"))
        return {n: out_dir / f"{n}.wav" for n in ("drums", "bass", "vocals", "other")}
    except Exception:
        return None


def _refine_drop_with_drums(
    drums_wav: Path, coarse_start: float, downbeats: list[float], window: float = 4.0
) -> float:
    import librosa

    y, sr = librosa.load(str(drums_wav), sr=22050, mono=True)
    duration = len(y) / sr
    lo = max(0.0, coarse_start - window)
    hi = min(duration, coarse_start + window)
    s0 = int(lo * sr)
    s1 = int(hi * sr)
    chunk = y[s0:s1]
    if chunk.size < sr // 4:
        return _snap_to_downbeat(coarse_start, downbeats)
    onset_env = librosa.onset.onset_strength(y=chunk, sr=sr)
    if onset_env.size == 0:
        return _snap_to_downbeat(coarse_start, downbeats)
    peak_local = int(np.argmax(onset_env))
    refined = lo + float(librosa.frames_to_time(peak_local, sr=sr))
    return _snap_to_downbeat(refined, downbeats)


def analyze_track(video_path: Path, progress: ProgressCb = None) -> dict[str, Any]:
    """Full pipeline. Returns analysis dict matching schemas.Analysis."""
    _ensure_dirs()
    fh = file_hash(video_path)

    if progress:
        progress("analysis", 5.0, "Extracting audio")
    wav_path = WAV_CACHE_DIR / f"{fh}.wav"
    extract_wav(video_path, wav_path)

    try:
        structure = _run_allin1(wav_path, progress=progress)
    except Exception:
        structure = _fallback_structure(wav_path)

    bpm = structure["bpm"]
    beats = structure["beats"]
    downbeats = structure["downbeats"]
    segments = structure["segments"]

    chorus = next((s for s in segments if s["label"].lower() in ("chorus", "drop")), None)
    if chorus is None and segments:
        chorus = max(segments, key=lambda s: s["end"] - s["start"])
    if chorus is None:
        chorus = {"start": 0.0, "end": 30.0, "label": "chorus"}

    coarse_start = chorus["start"]
    coarse_end = chorus["end"]

    stems_dir = STEMS_CACHE_DIR / fh
    stems = _run_demucs(wav_path, stems_dir, progress=progress)
    if stems and stems["drums"].exists():
        drop_start = _refine_drop_with_drums(stems["drums"], coarse_start, downbeats)
    else:
        drop_start = _snap_to_downbeat(coarse_start, downbeats)
    drop_end = _snap_to_downbeat(coarse_end, downbeats) if downbeats else coarse_end

    if progress:
        progress("analysis", 85.0, "Detecting key")
    import librosa
    y, sr = librosa.load(str(wav_path), sr=22050, mono=True, offset=drop_start, duration=min(30.0, max(5.0, drop_end - drop_start)))
    key_camelot = detect_key_camelot(y, sr) if y.size else "8A"

    if progress:
        progress("analysis", 95.0, "Measuring loudness")
    lufs = measure_lufs(wav_path)

    if progress:
        progress("analysis", 98.0, "Finding drop candidates")
    drops = find_drops(wav_path, downbeats, bpm)

    return {
        "bpm": bpm,
        "key_camelot": key_camelot,
        "lufs": lufs,
        "drop_start_s": float(drop_start),
        "drop_end_s": float(drop_end),
        "beats": beats,
        "downbeats": downbeats,
        "segments": segments,
        "drops": drops,
    }
