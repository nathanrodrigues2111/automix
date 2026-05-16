from __future__ import annotations

from typing import Any


def _camelot_parse(c: str) -> tuple[int, str]:
    c = c.strip().upper()
    return int(c[:-1]), c[-1]


def _camelot_neighbors(camelot: str) -> set[str]:
    n, letter = _camelot_parse(camelot)
    other = "B" if letter == "A" else "A"
    plus = ((n - 1 + 1) % 12) + 1
    minus = ((n - 1 - 1) % 12) + 1
    return {f"{n}{letter}", f"{plus}{letter}", f"{minus}{letter}", f"{n}{other}"}


def camelot_distance(a: str, b: str) -> int:
    if a == b:
        return 0
    if b in _camelot_neighbors(a):
        return 1
    na, la = _camelot_parse(a)
    nb, lb = _camelot_parse(b)
    ring = min((na - nb) % 12, (nb - na) % 12)
    letter_pen = 0 if la == lb else 1
    return ring + letter_pen


def order_tracks(tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Greedy Camelot-adjacency ordering with ascending BPM tie-break.

    Each track must have `key_camelot` and `bpm`. Pure function — does not mutate input.
    """
    if not tracks:
        return []
    remaining = list(tracks)
    remaining.sort(key=lambda t: (t.get("bpm", 0.0)))
    ordered = [remaining.pop(0)]
    while remaining:
        last = ordered[-1]
        remaining.sort(
            key=lambda t: (
                camelot_distance(last["key_camelot"], t["key_camelot"]),
                abs(t.get("bpm", 0.0) - last.get("bpm", 0.0)),
                t.get("bpm", 0.0),
            )
        )
        ordered.append(remaining.pop(0))
    return ordered
