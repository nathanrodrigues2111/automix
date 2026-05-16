from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_DIR.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend import analysis as analysis_mod  # noqa: E402
from backend import db as db_mod  # noqa: E402

GOLDEN = Path(__file__).parent / "golden_truth.json"
VIDEOS_DIR = PROJECT_ROOT / "videos"


def _load_truth() -> list[dict]:
    with open(GOLDEN) as f:
        data = json.load(f)
    return data["tracks"]


def _find_video(filename: str) -> Path:
    p = VIDEOS_DIR / filename
    if p.exists():
        return p
    matches = list(VIDEOS_DIR.rglob(filename))
    if not matches:
        pytest.skip(f"video not found: {filename}")
    return matches[0]


@pytest.fixture(scope="module")
def truth() -> list[dict]:
    return _load_truth()


@pytest.mark.parametrize("idx", range(3))
def test_detection_per_track(truth: list[dict], idx: int) -> None:
    if idx >= len(truth):
        pytest.skip("track index out of range")
    t = truth[idx]
    if "error" in t:
        pytest.skip(f"truth row has error: {t['error']}")

    video = _find_video(t["filename"])
    db_mod.init_db()
    fh = analysis_mod.file_hash(video)
    cached = db_mod.get_analysis(fh)
    if cached is None:
        cached = analysis_mod.analyze_track(video)
        db_mod.put_analysis(fh, cached)

    assert abs(cached["bpm"] - t["bpm"]) <= 1.0, f"BPM mismatch: got {cached['bpm']}, want {t['bpm']}"
    assert abs(cached["drop_start_s"] - t["drop_start_s"]) <= 0.5, (
        f"drop_start mismatch: got {cached['drop_start_s']}, want {t['drop_start_s']}"
    )
    assert cached["key_camelot"] == t["key_camelot"], (
        f"key mismatch: got {cached['key_camelot']}, want {t['key_camelot']}"
    )
