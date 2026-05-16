"""Run Demucs stem separation on the two source tracks (if not cached),
then trigger a FULL-QUALITY render with EQ bass-swap enabled.

Run via: backend/.venv/bin/python scripts/render_full.py
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import analysis  # noqa: E402
import db  # noqa: E402
import render as render_mod  # noqa: E402

VIDEOS = ROOT / "videos"
VENV_PY = ROOT / "backend" / ".venv" / "bin" / "python"


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


def ensure_stems(wav_path: Path, file_hash: str) -> Path:
    out_dir = analysis.STEMS_CACHE_DIR / file_hash
    if (out_dir / "drums.wav").exists():
        print(f"  [stems cached] {file_hash[:12]}")
        return out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"  [demucs running] {file_hash[:12]} … (~3-5 min on CPU)", flush=True)
    with tempfile.TemporaryDirectory() as tmp:
        # Use venv's python so demucs imports resolve.
        cmd = [
            str(VENV_PY), "-m", "demucs.separate",
            "-n", "htdemucs",
            "--out", tmp,
            "-d", "cpu",
            str(wav_path),
        ]
        t0 = time.time()
        # Stream output so user sees demucs progress.
        proc = subprocess.run(cmd, capture_output=False)
        if proc.returncode != 0:
            raise SystemExit(f"demucs failed for {file_hash[:12]}")
        print(f"  [demucs done] {file_hash[:12]} in {time.time()-t0:.0f}s", flush=True)
        found = list(Path(tmp).rglob("drums.wav"))
        if not found:
            raise SystemExit(f"demucs produced no stems for {file_hash[:12]}")
        src_dir = found[0].parent
        for stem in ("drums", "bass", "vocals", "other"):
            shutil.move(str(src_dir / f"{stem}.wav"), str(out_dir / f"{stem}.wav"))
    return out_dir


low = find("LOW")
crazy = find("Crazy People")
low_fh = analysis.file_hash(low)
crazy_fh = analysis.file_hash(crazy)

print(f"LOW   → {low.name}")
print(f"CRAZY → {crazy.name}")
print()

# Stems
ensure_stems(analysis.WAV_CACHE_DIR / f"{low_fh}.wav", low_fh)
ensure_stems(analysis.WAV_CACHE_DIR / f"{crazy_fh}.wav", crazy_fh)
print()

# Full render
config = {
    "clips": [
        {"track_id": low_fh[:16], "start_s": 27.0, "length_bars": 11.0},
        {"track_id": crazy_fh[:16], "start_s": 124.0, "length_bars": 10.0},
    ],
    "target_bpm": 0.0,
    "crossfade_bars": 1.0,
    "loudness_lufs": -14.0,
    "use_stem_crossfade": True,
    "use_eq_bass_swap": True,
    "snap_to_downbeat": True,
    "hard_cut": False,
    "harmonic_pitch_shift_max_semitones": 2.0,
    "proxy": False,
}


def progress(stage: str, pct: float, msg: str) -> None:
    print(f"  [{stage} {pct:5.1f}%] {msg}", flush=True)


print("=== FULL RENDER (bass-swap enabled) ===")
t0 = time.time()
record = render_mod.render_mix(config, resolver, progress)
print(f"\nDONE in {time.time() - t0:.0f}s → {record['output_path']}")
