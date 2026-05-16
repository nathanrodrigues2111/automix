"""Trigger a proxy render of the user's drops-only mix.

Run via: backend/.venv/bin/python scripts/render_preview.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import analysis  # noqa: E402
import db  # noqa: E402
import render as render_mod  # noqa: E402

VIDEOS = ROOT / "videos"


def find(pattern: str) -> Path:
    matches = sorted(VIDEOS.glob(f"*{pattern}*.mp4"))
    matches = [m for m in matches if not m.name.startswith("automix_")]
    if not matches:
        raise SystemExit(f"no match for {pattern!r}")
    return matches[0]


def resolver(track_id: str) -> Path:
    for f in VIDEOS.glob("*.mp4"):
        if analysis.file_hash(f).startswith(track_id):
            return f
    raise SystemExit(f"track {track_id} not on disk")


low = find("LOW")
crazy = find("Crazy People")
print(f"LOW   → {low.name}")
print(f"CRAZY → {crazy.name}")

low_id = analysis.file_hash(low)[:16]
crazy_id = analysis.file_hash(crazy)[:16]

config = {
    "clips": [
        # User: LOW 0:27 → 0:45 (~18s ≈ 11 bars @ 152 BPM)
        {"track_id": low_id, "start_s": 27.0, "length_bars": 11.0},
        # User: Crazy 2:04 → 2:20 (~16s ≈ 10 bars @ 143.55 BPM)
        {"track_id": crazy_id, "start_s": 124.0, "length_bars": 10.0},
    ],
    "target_bpm": 0.0,
    "crossfade_bars": 2.0,
    "loudness_lufs": -14.0,
    "use_stem_crossfade": True,
    "use_eq_bass_swap": True,
    "snap_to_downbeat": True,
    "hard_cut": False,
    "no_time_stretch": True,  # each clip at its native BPM
    "harmonic_pitch_shift_max_semitones": 0.0,
    "proxy": True,
}


def progress(stage: str, pct: float, msg: str) -> None:
    print(f"  [{stage} {pct:5.1f}%] {msg}", flush=True)


t0 = time.time()
record = render_mod.render_mix(config, resolver, progress)
dt = time.time() - t0
print(f"\nDONE in {dt:.1f}s → {record['output_path']}")
