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


DROPS_VERSION = 5


def find_drops(
    wav_path: Path,
    downbeats: list[float],
    bpm: float,
    max_drops: int = 5,
    min_separation_s: float = 30.0,
) -> list[dict[str, Any]]:
    """Detect EDM drop *moments* — the points where energy jumps from a
    quiet section (buildup/breakdown) into a loud section (the main drop).

    A real drop is where the KICK + SUB-BASS slam in, not merely where the
    track gets louder: loud vocal choruses and shouted/spoken intros spike
    full-band RMS but carry almost no sub energy, which is how the old
    full-band detector kept picking vocal sections. So candidates are scored
    primarily on the low-band (≤150 Hz) energy jump, then each candidate's
    drop body is validated for (a) substantial bass share, (b) bass lift over
    the track's median, and (c) a periodic kick at the track's tempo.

    Returns list of {start_s, end_s, kick_s, score}, snapped to downbeats.
    """
    import librosa
    from scipy.signal import butter, find_peaks, sosfiltfilt

    y, sr = librosa.load(str(wav_path), sr=22050, mono=True)
    duration = len(y) / sr
    if y.size == 0:
        return []

    hop = 512
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    if rms.size == 0:
        return []

    # Low band = kick + sub. Zero-phase filtering keeps frames aligned.
    sos = butter(4, 150.0, btype="lowpass", fs=sr, output="sos")
    y_low = sosfiltfilt(sos, y).astype(np.float32)
    rms_low = librosa.feature.rms(y=y_low, hop_length=hop)[0]
    n = min(len(rms), len(rms_low))
    rms, rms_low = rms[:n], rms_low[:n]

    # Drop score = mean energy in the next 2s minus mean energy in the prior
    # 4s. A drop is "quiet then suddenly loud," which spikes this delta.
    win_after = max(1, int(2.0 * sr / hop))
    win_before = max(1, int(4.0 * sr / hop))

    def _jump(x: np.ndarray) -> np.ndarray:
        cs = np.concatenate([[0.0], np.cumsum(x)])
        s = np.zeros_like(x)
        i = np.arange(win_before, len(x) - win_after)
        if i.size:
            before = (cs[i] - cs[i - win_before]) / win_before
            after = (cs[i + win_after] - cs[i]) / win_after
            s[i] = after - before
        return s

    # Bass jump is the drop signature; the full-band jump only breaks ties.
    score = _jump(rms_low) + 0.35 * _jump(rms)

    if np.max(score) <= 0:
        return []

    # Take a generous candidate pool at a lower threshold — validation below
    # prunes the vocal/intro false positives the old detector let through.
    height = float(np.max(score) * 0.30)
    distance = max(1, int(min_separation_s * sr / hop))
    peaks, props = find_peaks(score, height=height, distance=distance)
    if len(peaks) == 0:
        return []

    heights = props["peak_heights"]
    order = np.argsort(-heights)[: max_drops * 3]

    # Per-drop analysis: scan FORWARD from the peak to find the natural drop
    # end (where energy falls back to baseline), and scan BACKWARD to find the
    # natural buildup start (lowest energy in the lookback window). Clamped to
    # sensible ranges so a fluke doesn't produce a 1-second clip or a 60-second
    # one.
    # Tuned against the reference EDMPAPA mix (014oXybzUkc): kicks land every
    # ~19s, buildups run 4-7s, drop bodies sustain 4-9s. Clip = buildup + body.
    max_buildup_s = 8.0

    # Smoothed RMS for measuring sustained drop energy (~0.5s window).
    rms_smooth_win = max(1, int(0.5 * sr / hop))
    rms_smooth = np.convolve(rms, np.ones(rms_smooth_win) / rms_smooth_win, mode="same")
    rms_low_smooth = np.convolve(
        rms_low, np.ones(rms_smooth_win) / rms_smooth_win, mode="same"
    )

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
        # BASS energy point — the "breath" right before the kick. Full-band
        # RMS is the wrong signal here: vocals/synths keep it flat through
        # the buildup while only the bass dies out, so a full-band argmin
        # lands many seconds too early (e.g. Countdown: 7.8s vs the real
        # breath at 14.1s before a 15.4s kick).
        look_back = int(max_buildup_s * sr / hop)
        start_idx = max(0, peak_idx - look_back)
        if start_idx >= peak_idx:
            return float(librosa.frames_to_time(peak_idx, sr=sr, hop_length=hop))
        segment = rms_low_smooth[start_idx:peak_idx]
        # LAST quiet pocket, not the global argmin: when a track's bass stays
        # low through a long breakdown, the overall minimum sits many seconds
        # before the kick — the breath is the quiet frame CLOSEST to it.
        lo = float(np.min(segment))
        hi = float(np.max(segment))
        thresh = lo + 0.15 * (hi - lo)
        below = np.nonzero(segment <= thresh)[0]
        min_offset = int(below[-1]) if below.size else int(np.argmin(segment))
        return float(librosa.frames_to_time(start_idx + min_offset, sr=sr, hop_length=hop))

    bar_s = 4.0 * 60.0 / bpm if bpm > 0 else 1.875
    dbs = sorted(float(d) for d in downbeats) if downbeats else []

    # --- Drop-body validation ------------------------------------------------
    # Measured over the 4 bars after the kick. A vocal chorus or spoken intro
    # fails these; a four-on-the-floor drop passes easily.
    beat_frames = (60.0 / bpm) * sr / hop if bpm > 0 else 0.0
    med_low = float(np.median(rms_low)) + 1e-9

    def _body_metrics(kick_t: float) -> tuple[float, float, float]:
        """Returns (bass_frac, bass_lift, kick_periodicity) for the drop body."""
        b0 = max(0, int(kick_t * sr / hop))
        b1 = min(len(rms_low), b0 + max(1, int(4.0 * bar_s * sr / hop)))
        seg_low = rms_low[b0:b1]
        seg_full = rms[b0:b1]
        if seg_low.size < 8:
            return 0.0, 0.0, 0.0
        bass_frac = float(np.mean(seg_low)) / (float(np.mean(seg_full)) + 1e-9)
        bass_lift = float(np.mean(seg_low)) / med_low
        # Kick periodicity: the low band's onset envelope autocorrelates at
        # the beat lag when a steady kick is present. Check half/double lags
        # too so an octave error in BPM tracking doesn't fail a real drop.
        periodicity = 0.0
        s0, s1 = b0 * hop, min(len(y_low), b1 * hop)
        onset = librosa.onset.onset_strength(y=y_low[s0:s1], sr=sr, hop_length=hop)
        if beat_frames > 0 and onset.size > 4 * beat_frames:
            onset = onset - float(np.mean(onset))
            ac = np.correlate(onset, onset, mode="full")[onset.size - 1 :]
            if ac[0] > 0:
                acn = ac / ac[0]
                for mult in (1.0, 0.5, 2.0):
                    lag = int(round(beat_frames * mult))
                    if 2 < lag < acn.size - 2:
                        periodicity = max(
                            periodicity, float(np.max(acn[lag - 2 : lag + 3]))
                        )
        return bass_frac, bass_lift, periodicity

    def _refine_kick(t: float) -> float:
        """Snap `t` to the nearest true kick attack (steep low-band rise).
        The downbeat grid (fallback beat tracking) can sit a fraction of a
        beat off the real kicks — mix seams are phrase-cut from kick_s, so
        this phase error is audible as a stumble."""
        # The drop's FIRST kick peak in a window biased forward of the grid
        # estimate; then walk back to the attack. Anchoring on the first body
        # kick (rather than the steepest rise near t) avoids locking onto an
        # offbeat bass hit, which made seams flam by ~half a beat.
        w0 = max(0, int((t - 0.35) * sr / hop))
        w1 = min(len(rms_low), int((t + 0.60) * sr / hop))
        seg = rms_low[w0:w1]
        if seg.size < 6:
            return t
        pk, _ = find_peaks(
            seg,
            prominence=float(np.max(seg)) * 0.2,
            distance=max(1, int(0.22 * sr / hop)),
        )
        if not len(pk):
            return t
        p = int(pk[0])
        a0 = max(0, p - 6)
        d = np.diff(seg[a0 : p + 1])
        off = a0 + (int(np.argmax(d)) if d.size else 0)
        return float(librosa.frames_to_time(w0 + off + 1, sr=sr, hop_length=hop))

    def _snap_end_to_kick_grid(end_t: float) -> float:
        """Cut exactly one kick-period after the clip's last true kick before
        `end_t`. Absolute `kick + n_bars * bar_s` math drifts with any BPM
        estimation error; measuring the local kick grid empirically puts the
        cut precisely where the next kick would land — which is where the
        incoming clip's kick slams in during the mix."""
        # Look back up to 4 bars: a drop whose energy dies early has no kicks
        # right before the quantized end — pull the cut back to the last real
        # kick instead of dragging dead air into the transition.
        w0 = max(0, int((end_t - 4.0 * bar_s) * sr / hop))
        w1 = min(len(rms_low), int(end_t * sr / hop))
        seg = rms_low[w0:w1]
        if seg.size < 8:
            return end_t
        pk, _ = find_peaks(
            seg,
            distance=max(1, int(0.25 * sr / hop)),
            prominence=float(np.max(seg)) * 0.15,
        )
        if len(pk) < 3:
            return end_t
        times = librosa.frames_to_time(w0 + pk, sr=sr, hop_length=hop)
        period = float(np.median(np.diff(times)))
        if not 0.25 <= period <= 1.0:  # not a steady kick pattern
            return end_t
        return float(times[-1]) + period

    drops: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
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
            kick_t = drop_t
        # Phase-correct to the actual kick attack, then cut the end an EXACT
        # number of bars later — quantizing via the (possibly phase-shifted)
        # downbeat grid put clip ends a fraction of a beat off the true kicks,
        # which made mix transitions stumble.
        kick_t = _refine_kick(kick_t)

        natural_end = _scan_drop_end(peak_idx)
        sustain_s = max(0.0, natural_end - kick_t)
        # 8 bars only when the drop's energy actually sustains the full run —
        # otherwise the clip drags dead air into the next transition.
        n_bars = 8 if sustain_s >= 8.0 * bar_s else 4
        end = min(duration, kick_t + n_bars * bar_s)
        end = min(duration, _snap_end_to_kick_grid(end))

        # A drop body shorter than ~3.5 bars (kick too close to the end of the
        # track) is unusable as a mix clip.
        if end - kick_t < 3.5 * bar_s:
            continue

        # Per-track buildup: how far before the kick this track's own bass
        # breath sits — no general fixed offset works across tracks (some
        # have long risers, some drop straight in after one silent beat).
        beat_s = 60.0 / bpm if bpm > 0 else 0.5
        min_buildup = max(0.5, beat_s)
        buildup_start_t = _scan_buildup_start(peak_idx)
        buildup_s = max(min_buildup, min(max_buildup_s, kick_t - buildup_start_t))
        desired_start = max(0.0, kick_t - buildup_s)
        start = _snap_to_downbeat(desired_start, dbs) if dbs else desired_start
        # The downbeat grid can be sparse (half-tempo tracking → one line per
        # 2 bars); if the snap flings the start far from the track's actual
        # breath, trust the energy scan instead.
        if start >= kick_t or start < desired_start - 1.0:
            start = desired_start

        if end <= kick_t or end <= start:
            continue

        bass_frac, bass_lift, periodicity = _body_metrics(kick_t)

        # Measured kick period of the drop body — the global BPM estimate can
        # be ~1% off, which makes beat-matched stretches drift audibly across
        # a transition. Frame-resolution peaks quantize to 23ms (can't resolve
        # 1%), so refine each peak sub-frame (parabolic) and fit the period by
        # least squares across the whole body.
        kick_period = 0.0
        b0 = max(0, int(kick_t * sr / hop))
        b1 = min(len(rms_low), max(b0 + 8, int(end * sr / hop)))
        body = rms_low[b0:b1]
        if body.size > 8:
            bpk, _ = find_peaks(
                body,
                distance=max(1, int(0.25 * sr / hop)),
                prominence=float(np.max(body)) * 0.15,
            )
            if len(bpk) >= 5:
                ts = []
                for pi in bpk:
                    i0 = b0 + int(pi)
                    off = 0.0
                    if 0 < i0 < len(rms_low) - 1:
                        a_, m_, c_ = rms_low[i0 - 1], rms_low[i0], rms_low[i0 + 1]
                        den = a_ - 2 * m_ + c_
                        if abs(den) > 1e-12:
                            off = float(np.clip(0.5 * (a_ - c_) / den, -0.5, 0.5))
                    ts.append((i0 + off) * hop / sr)
                ts = np.asarray(ts)
                med = float(np.median(np.diff(ts)))
                if 0.25 <= med <= 1.0:
                    steps = np.round((ts - ts[0]) / med)
                    A = np.vstack([steps, np.ones_like(steps)]).T
                    slope = float(np.linalg.lstsq(A, ts, rcond=None)[0][0])
                    if 0.25 <= slope <= 1.0:
                        kick_period = slope

        candidate = {
            "start_s": float(start),
            "end_s": float(end),
            "kick_s": float(kick_t),
            "kick_period_s": kick_period or None,
            # Steady-kick bodies outrank equally-loud vocal sections.
            "score": float(heights[idx]) * (1.0 + 0.5 * periodicity),
        }
        # Hard gates: the body must be genuinely bass-driven. bass_frac is the
        # low band's share of full-band energy (drops sit ~0.3-0.6, vocal
        # sections ~0.05-0.15); bass_lift requires more bass than the track's
        # median frame, so quiet talky intros can't sneak through.
        if bass_frac >= 0.18 and bass_lift >= 1.15:
            drops.append(candidate)
        else:
            rejected.append(candidate)

    # Every candidate failing validation usually means an unusual master
    # (e.g. heavily filtered) — better to return the best guess than nothing.
    if not drops and rejected:
        drops = rejected[:1]

    drops.sort(key=lambda d: -d["score"])
    drops = drops[:max_drops]
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
        "drops_version": DROPS_VERSION,
    }
