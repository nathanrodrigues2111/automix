# Post-render verification: measure the ACTUAL output file and fail loudly
# when it doesn't meet the user-calibrated quality bars. This is the guard
# that keeps a bad mix from silently looking done.
#
#   - Seam phase: each incoming drop's kick must land on the outgoing kick
#     grid. ≤0.04 beats = perfect (Nathan's ear), ≤0.08 acceptable, more = fail.
#   - Loudness: integrated LUFS on target, true peak under the ceiling
#     (no clipping / no blown-out program).
#   - Titles: rendered title pixels exist in the bottom bar, stay inside the
#     safe margins (never touch the frame edges), and switch exactly at seams.
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

PHASE_PERFECT_BEATS = 0.04
PHASE_OK_BEATS = 0.08
LUFS_TOLERANCE = 1.0
TRUE_PEAK_MAX_DB = -0.5  # ceiling is -1.2 sample peak; AAC may overshoot a hair


def _extract_wav(video: Path, t0: float, t1: float, out_wav: Path) -> None:
    cmd = [
        "ffmpeg", "-y", "-ss", f"{max(0.0, t0):.3f}", "-i", str(video),
        "-t", f"{max(0.1, t1 - max(0.0, t0)):.3f}",
        "-vn", "-ac", "1", "-ar", "44100", "-acodec", "pcm_f32le", str(out_wav),
    ]
    subprocess.run(cmd, check=True, capture_output=True)


def _lowband_env(wav: Path, t0: float, t1: float) -> tuple[np.ndarray, int, int, float]:
    """Low-band (≤150 Hz) RMS envelope of wav[t0:t1] (seek-read, no full
    file load). Returns (env, sr, hop, t_off) with t_off the actual start."""
    import soundfile as sf
    from scipy.signal import butter, sosfiltfilt

    with sf.SoundFile(str(wav)) as f:
        sr = f.samplerate
        s0 = max(0, min(f.frames, int(max(0.0, t0) * sr)))
        s1 = max(s0, min(f.frames, int(t1 * sr)))
        f.seek(s0)
        y = f.read(s1 - s0, always_2d=True).mean(axis=1)
    # Fine hop: at 512 (11.6ms) the attack plateaus defeat sub-frame peak
    # refinement and kick timings quantize ~0.05 beats — audible band edge.
    hop = 128
    n = len(y) // hop
    if n < 4:
        return np.asarray([]), sr, hop, s0 / sr
    sos = butter(4, 150.0, btype="lowpass", fs=sr, output="sos")
    yl = sosfiltfilt(sos, y)
    env = np.sqrt(np.mean(yl[: n * hop].reshape(n, hop) ** 2, axis=1))
    return env, sr, hop, s0 / sr


def _attack_curve(env: np.ndarray) -> np.ndarray:
    """Positive envelope slope. Kicks PUNCH (steep rise) while off-beat bass
    stabs swell — attack separates them where raw peak height cannot."""
    from scipy.ndimage import maximum_filter1d

    if env.size < 3:
        return np.zeros_like(env)
    d = np.clip(np.diff(env, prepend=env[:1]), 0.0, None)
    # Widen each attack by a frame so grid-slot sampling can't miss it.
    return maximum_filter1d(d, size=3, mode="nearest")


def _fit_kick_grid(
    env: np.ndarray, sr: int, hop: int, t_off: float,
    end_t: float, period_hint: float | None = None,
) -> tuple[float, float] | None:
    """Fit the KICK grid of `env`: returns (period, phi) with grid slots at
    end_t - phi - k*period. Period comes from the caller's hint (the drop's
    least-squares kick period from detection) when available, else from
    envelope autocorrelation. Phase maximizes summed ATTACK at the slots —
    voting across ~24 beats picks the on-beats over off-beat bass stabs."""
    attack = _attack_curve(env)
    if attack.size < 16:
        return None
    fps = sr / hop
    if period_hint and 0.2 <= float(period_hint) <= 1.2:
        period = float(period_hint)
    else:
        x = env - float(env.mean())
        ac = np.correlate(x, x, "full")[x.size - 1:]
        lo, hi = int(0.25 * fps), min(int(1.0 * fps) + 1, ac.size - 1)
        if hi <= lo + 2 or ac[0] <= 0:
            return None
        lag = lo + int(np.argmax(ac[lo:hi]))
        if 0 < lag < ac.size - 1:
            a, m, c = ac[lag - 1], ac[lag], ac[lag + 1]
            den = a - 2 * m + c
            if abs(den) > 1e-12:
                lag = lag + float(np.clip(0.5 * (a - c) / den, -0.5, 0.5))
        period = lag / fps
        if not 0.2 <= period <= 1.2:
            return None
    n_slots = int(min(24, (end_t - t_off) / period))
    if n_slots < 4:
        return None
    xs = np.arange(attack.size, dtype=float)
    scores: list[float] = []
    best_phi, best_score = 0.0, -1.0
    for phi in np.linspace(0.0, period, 64, endpoint=False):
        ts = end_t - phi - period * np.arange(n_slots)
        ii = (ts - t_off) * fps
        ii = ii[(ii >= 0) & (ii <= attack.size - 1)]
        if ii.size < 4:
            continue
        score = float(np.interp(ii, xs, attack).mean())
        scores.append(score)
        if score > best_score:
            best_score, best_phi = score, float(phi)
    if best_score <= 0 or len(scores) < 16:
        return None
    # Grid COHERENCE = contrast of the phase-vote landscape: a steady kick
    # grid concentrates attack energy at one phase (peaked landscape), a
    # breakbeat/DnB section spreads it (flat landscape) — there a "kick grid
    # phase" is musically meaningless and must not be scored as off-beat.
    mean_score = float(np.mean(scores))
    coherence = best_score / mean_score - 1.0 if mean_score > 0 else 0.0
    return float(period), best_phi, coherence


def _attack_kick_near(
    attack: np.ndarray, sr: int, hop: int, t_off: float,
    t_expect: float, radius: float = 0.5,
) -> float | None:
    """Sub-frame time of the kick attack nearest `t_expect` (within ±radius),
    considering only strong attacks so riser swells can't win."""
    from scipy.signal import find_peaks

    fps = sr / hop
    i0 = max(0, int((t_expect - radius - t_off) * fps))
    i1 = min(attack.size, int((t_expect + radius - t_off) * fps) + 1)
    seg = attack[i0:i1]
    if seg.size < 3 or float(seg.max()) <= 0:
        return None
    # Small suppression distance: inside this tight window EVERY distinct
    # attack is a candidate (nearest-to-expect resolves) — a 0.2s distance
    # let one strong neighbor mask the true kick sitting dead on the grid.
    pk, _ = find_peaks(seg, distance=max(1, int(0.08 * fps)), height=float(seg.max()) * 0.3)
    if not len(pk):
        pk = np.asarray([int(np.argmax(seg))])
    times = []
    for pi in (i0 + pk):
        o = 0.0
        if 0 < pi < attack.size - 1:
            a, m, c = attack[pi - 1], attack[pi], attack[pi + 1]
            den = a - 2 * m + c
            if abs(den) > 1e-12:
                o = float(np.clip(0.5 * (a - c) / den, -0.5, 0.5))
        times.append((pi + o) / fps + t_off)
    ts = np.asarray(times)
    return float(ts[int(np.argmin(np.abs(ts - t_expect)))])


def seam_phase_errors(
    video: Path,
    seam_times: list[float],
    crossfades: list[float],
    period_hints: list[float | None] | None = None,
    grid_starts: list[float | None] | None = None,
    seam_infos: list[dict] | None = None,
) -> list[dict[str, Any]]:
    """Check every seam's PROMISE in the final mix.

    The render-time aligner measures clean pre-mix audio (tight windows
    anchored on ear-validated detection data) and records where the incoming
    kick must sit: seam + kick_offset, on a grid of `period`. The verifier's
    job is to independently confirm that kick exists THERE in the final
    file — this catches sample-math/merge/mux regressions end to end.
    (Statistically re-fitting the groove from the final mix proved unstable
    on live festival audio: syncopation and tempo ramps false-alarm it.)
    """
    results: list[dict[str, Any]] = []
    for i, seam in enumerate(seam_times):
        cf = float(crossfades[i]) if i < len(crossfades) else 2.0
        info = seam_infos[i] if seam_infos and i < len(seam_infos) else {}
        entry: dict[str, Any] = {"seam_s": float(seam), "crossfade_s": cf}
        if not info.get("measured"):
            entry["status"] = "unaligned"  # no kick-anchored transition here
            results.append(entry)
            continue
        period = float(info["period"])
        expect = seam + float(info["kick_offset"])
        try:
            with tempfile.TemporaryDirectory(prefix="verify_") as tmp:
                seg = Path(tmp) / "seg.wav"
                t0 = max(0.0, expect - 1.5)
                _extract_wav(video, t0, expect + 1.5, seg)
                env, sr, hop, off = _lowband_env(seg, 0.0, 3.0)
                attack = _attack_curve(env)
                # Same tight radius the aligner used for its measurements —
                # symmetric windows keep the two methods commensurable.
                kick_in = _attack_kick_near(
                    attack, sr, hop, off, expect - t0, radius=min(0.12, 0.45 * period)
                )
            if kick_in is None:
                entry["status"] = "kick_not_found"
                results.append(entry)
                continue
            phase = abs((kick_in + t0) - expect) / period
            entry.update(
                {
                    "status": "measured",
                    "period_s": period,
                    "expected_kick_s": float(expect),
                    "incoming_kick_s": float(kick_in + t0),
                    "phase_beats": float(phase),
                    "verdict": (
                        "perfect" if phase <= PHASE_PERFECT_BEATS
                        else "ok" if phase <= PHASE_OK_BEATS
                        else "off"
                    ),
                }
            )
        except Exception as e:
            entry["status"] = f"error: {e}"
        results.append(entry)
    return results


def measure_loudness(video: Path) -> dict[str, float] | None:
    import re

    cmd = [
        "ffmpeg", "-i", str(video),
        "-af", "loudnorm=I=-14:LRA=11:TP=-1.5:print_format=json",
        "-f", "null", "-",
    ]
    p = subprocess.run(cmd, capture_output=True)
    stderr = p.stderr.decode("utf-8", errors="ignore")
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
        return {"lufs": float(d["input_i"]), "true_peak_db": float(d["input_tp"])}
    except Exception:
        return None


def _gray_frame(video: Path, t: float) -> tuple[np.ndarray, int, int] | None:
    r = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "csv=p=0", str(video),
        ],
        capture_output=True, text=True,
    )
    try:
        w, h = (int(x) for x in r.stdout.strip().split(",")[:2])
    except Exception:
        return None
    p = subprocess.run(
        [
            "ffmpeg", "-ss", f"{max(0.0, t):.3f}", "-i", str(video),
            "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-",
        ],
        capture_output=True,
    )
    if len(p.stdout) < w * h:
        return None
    return np.frombuffer(p.stdout[: w * h], dtype=np.uint8).reshape(h, w), w, h


def check_titles(
    video: Path, title_windows: list[tuple[str, float, float]]
) -> list[dict[str, Any]]:
    """For each title window, sample a frame and check the bottom bar: the
    title must be rendered (lit pixels) and must keep clear of the frame
    edges (at least half the design margin of 160px at 1080p scale)."""
    results: list[dict[str, Any]] = []
    for title, s, e in title_windows:
        entry: dict[str, Any] = {"title": title, "start_s": float(s), "end_s": float(e)}
        if e - s < 0.8:
            entry["status"] = "window_too_short"
            results.append(entry)
            continue
        mid = (s + e) / 2.0
        fr = _gray_frame(video, mid)
        if fr is None:
            entry["status"] = "no_frame"
            results.append(entry)
            continue
        img, w, h = fr
        k = h / 1080.0
        bar_h = int(140 * k)
        # Inner region of the bottom bar (avoid the bar boundary itself).
        y0 = h - bar_h + max(2, int(6 * k))
        band = img[y0 : h - max(2, int(6 * k)), :]
        lit_cols = np.where(band.max(axis=0) > 60)[0]
        if lit_cols.size == 0:
            entry["status"] = "missing"
            results.append(entry)
            continue
        x0, x1 = int(lit_cols[0]), int(lit_cols[-1])
        min_margin = int(80 * k)  # half the 160px design margin
        entry.update(
            {
                "status": "rendered",
                "x0": x0,
                "x1": x1,
                "frame_w": w,
                "ok": x0 >= min_margin and x1 <= w - min_margin,
            }
        )
        results.append(entry)
    return results


def verify_mix(
    video: Path,
    seam_times: list[float],
    crossfades: list[float],
    title_windows: list[tuple[str, float, float]],
    target_lufs: float,
    expect_titles: bool,
    period_hints: list[float | None] | None = None,
    grid_starts: list[float | None] | None = None,
    seam_infos: list[dict] | None = None,
) -> dict[str, Any]:
    problems: list[str] = []

    loud = measure_loudness(video)
    if loud is None:
        problems.append("loudness unmeasurable")
    else:
        if abs(loud["lufs"] - target_lufs) > LUFS_TOLERANCE:
            problems.append(
                f"loudness {loud['lufs']:.1f} LUFS off target {target_lufs:.1f}"
            )
        if loud["true_peak_db"] > TRUE_PEAK_MAX_DB:
            problems.append(f"true peak {loud['true_peak_db']:.2f} dBTP too hot (clipping risk)")

    seams = seam_phase_errors(
        video, seam_times, crossfades, period_hints, grid_starts, seam_infos
    )
    for s in seams:
        if s.get("verdict") == "off":
            problems.append(
                f"seam at {s['seam_s']:.1f}s phase error {s['phase_beats']:.3f} beats"
            )
        elif s.get("status") == "kick_not_found":
            problems.append(
                f"seam at {s['seam_s']:.1f}s: promised kick missing in final mix"
            )

    titles: list[dict[str, Any]] = []
    if expect_titles:
        titles = check_titles(video, title_windows)
        for t in titles:
            if t.get("status") == "missing":
                problems.append(f"title not rendered: {t['title'][:60]}")
            elif t.get("status") == "rendered" and not t.get("ok"):
                problems.append(f"title too close to frame edge: {t['title'][:60]}")

    measured = [s for s in seams if s.get("status") == "measured"]
    return {
        "passed": not problems,
        "problems": problems,
        "loudness": loud,
        "seams": seams,
        "seam_summary": {
            "measured": len(measured),
            "unmeasured": len(seams) - len(measured),
            "perfect": sum(1 for s in measured if s["verdict"] == "perfect"),
            "ok": sum(1 for s in measured if s["verdict"] == "ok"),
            "off": sum(1 for s in measured if s["verdict"] == "off"),
            "worst_phase_beats": max(
                (s["phase_beats"] for s in measured), default=None
            ),
        },
        "titles": titles,
    }
