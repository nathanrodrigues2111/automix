from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from analysis import parse_tracklist  # noqa: E402


# ---------- classic formats (must keep working) ----------


def test_dash_lines() -> None:
    cues = parse_tracklist("0:00 - Intro\n1:37 - Artist - Title")
    assert cues == [
        {"t_s": 0.0, "title": "Intro"},
        {"t_s": 97.0, "title": "Artist - Title"},
    ]


def test_untimestamped_list_is_order_based() -> None:
    cues = parse_tracklist("Artist A - One\nArtist B - Two")
    assert [c["t_s"] for c in cues] == [None, None]
    assert [c["title"] for c in cues] == ["Artist A - One", "Artist B - Two"]


# ---------- raw 1001tracklists page copy ----------

TL1001 = """\
Hardwell & braev Believe Artwork
01
Hardwell & braev - Believe (Intro Edit) REVEALED
47
B-Rather
(151.2k)
Save 118
artwork placeholder
02
05:30
Hardwell & W&W - ID
B-Rather
(151.2k)
35
9
Pre-Save 0
Danzel Put Your Hands Up In The Air (Acappella) Artwork
w/
Danzel - Put Your Hands Up In The Air (Acappella)  SUPERSTAR/DATA REC.
141
B-Rather
(151.2k)
Save 141
Hardwell & Olly James vs. Hardwell vs. Avicii & Ras Flatline vs. Spaceman vs. The Nights (Hardwell Mashup) Artwork
03
08:40
Olly James & Hardwell vs. Hardwell vs. Avicii vs. RAS - Flatline vs. Spaceman vs. The Nights (Hardwell Mashup)  REVEALED/PRMD
75
B-Rather
(151.2k)
3 Are Legend What You Say Artwork
w/
11:40
3 Are Legend ft. Imogen Heap - What You Say  DIM MAK
36
Guest
Pre-Save 79
Hardwell & Maddix AI CARALHO Artwork
19
53:45
Hardwell & Maddix - AI CARALHO REVEALED
11
B-Rather
(151.2k)
Pre-Save 79
Showtek & Justin Prime Cannonball (Hardwell & W&W Remix) Artwork
16
47:20
Showtek & Justin Prime - Cannonball (Hardwell & W&W Remix) 2DUTCH
36
B-Rather
(151.2k)
Hardwell & Sound Rush Iris Artwork
22
1:04:15
Hardwell & Sound Rush - Iris  REVEALED
9
B-Rather
(151.2k)
Pre-Save 71
"""


def test_1001tl_page_copy() -> None:
    cues = parse_tracklist(TL1001)
    got = {c["title"]: c["t_s"] for c in cues}
    assert got == {
        "Hardwell & braev - Believe (Intro Edit)": 0.0,
        "Hardwell & W&W - ID": 330.0,
        "Olly James & Hardwell vs. Hardwell vs. Avicii vs. RAS - "
        "Flatline vs. Spaceman vs. The Nights (Hardwell Mashup)": 520.0,
        "Hardwell & Maddix - AI CARALHO": 3225.0,
        "Showtek & Justin Prime - Cannonball (Hardwell & W&W Remix)": 2840.0,
        "Hardwell & Sound Rush - Iris": 3855.0,
    }
    assert [c["t_s"] for c in cues] == sorted(c["t_s"] for c in cues)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Hardwell & W&W - ID", "Hardwell & W&W - ID"),
        (
            "Hardwell & braev - Believe (Intro Edit) REVEALED",
            "Hardwell & braev - Believe (Intro Edit)",
        ),
        ("Hardwell & MAKJ - Countdown 2026  REVEALED", "Hardwell & MAKJ - Countdown 2026"),
        ("Hardwell & Azteck & Dr Phunk - LOW  REVEALED", "Hardwell & Azteck & Dr Phunk - LOW"),
        ("Hardwell & Maddix - AI CARALHO REVEALED", "Hardwell & Maddix - AI CARALHO"),
        (
            "Icona Pop ft. Charli xcx - I Love It (Acappella) BIG BEAT (ATLANTIC)",
            "Icona Pop ft. Charli xcx - I Love It (Acappella)",
        ),
        (
            "Avicii & Nicky Romero ft. Noonie Bao - I Could Be The One (Acappella) LE7ELS",
            "Avicii & Nicky Romero ft. Noonie Bao - I Could Be The One (Acappella)",
        ),
        (
            "Eminem - Without Me (Hardwell 2023 Bootleg)",
            "Eminem - Without Me (Hardwell 2023 Bootleg)",
        ),
        (
            "Retrika & Alex Mueller - Show Me A Sign [REVEALED]",
            "Retrika & Alex Mueller - Show Me A Sign",
        ),
    ],
)
def test_strip_record_label(raw: str, expected: str) -> None:
    from analysis import _clean_cue_title, _strip_record_label

    assert _strip_record_label(_clean_cue_title(raw)) == expected
