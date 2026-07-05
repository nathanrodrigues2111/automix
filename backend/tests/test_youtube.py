from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from render import compute_title_windows  # noqa: E402
from youtube import clean_title  # noqa: E402


# ---------- clean_title ----------

@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Martin Garrix - Animals (Official Video)", "Martin Garrix - Animals"),
        (
            "MONXX - WORLD OF WONK (feat. P Money) [Official Music Video]",
            "MONXX - WORLD OF WONK (feat. P Money)",
        ),
        ("Song [abc123_-XY]", "Song"),
        ("Track | Monstercat Release", "Track"),
    ],
)
def test_clean_title_required_cases(raw: str, expected: str) -> None:
    assert clean_title(raw) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        # Real 11-char YouTube ID suffix from our outtmpl.
        (
            "Martin Garrix & Blinders - Aurora (Official Video) [_NIpfrGXwG8]",
            "Martin Garrix & Blinders - Aurora",
        ),
        # Keep remix-artist parens and VIP; drop junk.
        ("Artist - Tune (Skrillex Remix) [Official Audio]", "Artist - Tune (Skrillex Remix)"),
        ("Artist - Tune (VIP)", "Artist - Tune (VIP)"),
        ("Artist - Tune (Remix)", "Artist - Tune (Remix)"),
        ("Artist - Tune (Extended Mix)", "Artist - Tune"),
        ("Artist - Tune (Radio Edit) (Lyric Video)", "Artist - Tune"),
        ("Artist - Tune (ft. MC) (OUT NOW)", "Artist - Tune (ft. MC)"),
        ("Artist - Tune [NCS Release]", "Artist - Tune"),
        ("Artist - Tune (4K Visualizer)", "Artist - Tune"),
        ("Artist - Tune // Free Download", "Artist - Tune"),
        # Whitespace collapse + stray dash trimming.
        ("  Artist - Tune (Official Video) -  ", "Artist - Tune"),
        # No uppercase transformation here (render does that).
        ("monxx - world of wonk (feat. p money)", "monxx - world of wonk (feat. p money)"),
    ],
)
def test_clean_title_extra_cases(raw: str, expected: str) -> None:
    assert clean_title(raw) == expected


# ---------- compute_title_windows ----------

def test_title_windows_single_clip() -> None:
    assert compute_title_windows([7.0], []) == [(0.0, 7.0)]


def test_title_windows_three_clips() -> None:
    # Same math as the video concat:
    #   part starts: s0=0, s1=10-2=8, s2=8+8-3=13
    #   cumulative: 10 -> 10+8-2=16 -> 16+12-3=25
    #   switches at xfade ENDS (the incoming kick) minus the 45ms lead the
    #   30fps title burn needs so it never lags the hit
    windows = compute_title_windows([10.0, 8.0, 12.0], [2.0, 3.0])
    assert windows == [(0.0, 9.955), (9.955, 15.955), (15.955, 25.0)]


def test_title_windows_follow_measured_kicks() -> None:
    # The seam aligner may slide the actual kick off the nominal seam;
    # kick_offsets shifts each switch to the measured position.
    windows = compute_title_windows(
        [10.0, 8.0, 12.0], [2.0, 3.0], kick_offsets=[0.2, -0.1]
    )
    assert abs(windows[0][1] - (10.0 + 0.2 - 0.045)) < 1e-9
    assert abs(windows[1][1] - (16.0 - 0.1 - 0.045)) < 1e-9


def test_title_windows_clamps_tiny_crossfade() -> None:
    # Crossfades clamp to >= 0.05; the switch keeps the 45ms lead.
    windows = compute_title_windows([10.0, 10.0], [0.0])
    switch = windows[0][1]
    assert abs(switch - (10.0 - 0.045)) < 1e-9
    assert windows[1] == (switch, 19.95)


def test_title_windows_mismatched_lengths_raises() -> None:
    with pytest.raises(ValueError):
        compute_title_windows([10.0, 10.0], [])
