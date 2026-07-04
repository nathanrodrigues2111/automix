# YouTube playlist/video importer built on the yt_dlp Python API.
# Downloads best-quality h264+m4a MP4s into VIDEOS_DIR and records display
# titles in the track_meta table so renders can show clean overlay titles.
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

import analysis as analysis_mod
import db

ProgressCb = Callable[[str, float, str], None] | None

# Preferred format: highest-quality h264 video + m4a audio so both the browser
# and the ffmpeg pipeline can play the file without transcoding.
FORMAT = (
    "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]"
    "/bv*[height<=1080]+ba/b[height<=1080]/b"
)

# Trailing "[<youtube-id>]" suffix as produced by our outtmpl. Real IDs are 11
# chars of [A-Za-z0-9_-]; be a little lenient but require at least one
# digit/underscore/dash so we don't eat things like "[Monstercat]".
_YT_ID_SUFFIX_RE = re.compile(r"\s*\[(?=[^\]]*[0-9_-])[A-Za-z0-9_-]{8,12}\]\s*$")

# Bracketed/parenthesized chunks whose content matches any of these are junk.
_JUNK_RE = re.compile(
    r"\b("
    r"official|music\s+video|lyric(?:s)?(?:\s+video)?|audio|visuali[sz]er|"
    r"out\s+now|free\s+(?:download|dl)|premiere|hd|4k|uhd|"
    r"monstercat\s+release|ncs\s+release|copyright\s+free|"
    r"(?:extended|radio)(?:\s+(?:edit|mix))?"
    r")\b",
    re.IGNORECASE,
)

# Chunks we always keep even if a junk keyword also matches: featured artists,
# VIPs and remixes (incl. remix-artist parens like "(Skrillex Remix)").
_KEEP_RE = re.compile(
    r"^\s*(?:feat\.?|ft\.?|featuring)\b|\bremix\s*$|^\s*vip\s*$",
    re.IGNORECASE,
)

_BRACKET_RE = re.compile(r"[\(\[]([^\)\]]*)[\)\]]")


def clean_title(raw: str) -> str:
    """Reduce a raw YouTube title to just artist/track info.

    Style target: "MONXX - WORLD OF WONK (FEAT. P MONEY)" — but this function
    does NOT uppercase; the render branding pass does that.
    """
    s = raw.strip()
    # 1. Strip the trailing "[<id>]" suffix from our own outtmpl filenames.
    s = _YT_ID_SUFFIX_RE.sub("", s)
    # 2. Drop trailing "| Label" / "// whatever" segments.
    s = re.sub(r"\s*\|.*$", "", s)
    s = re.sub(r"\s*//.*$", "", s)

    # 3. Remove junk bracketed/parenthesized chunks, keep feat/VIP/remix ones.
    def _bracket_sub(m: re.Match) -> str:
        inner = m.group(1).strip()
        if _KEEP_RE.search(inner):
            return m.group(0)
        if _JUNK_RE.search(inner):
            return " "
        return m.group(0)

    s = _BRACKET_RE.sub(_bracket_sub, s)
    # 4. Collapse whitespace, trim stray dashes at the edges.
    s = re.sub(r"\s+", " ", s).strip()
    s = s.strip(" -–—").strip()
    return s


def _find_existing(dest_dir: Path, video_id: str) -> Path | None:
    """Find an already-downloaded file by its [id] suffix (glob would treat
    the brackets as a character class, so scan manually)."""
    marker = f"[{video_id}]"
    for p in sorted(dest_dir.glob("*.mp4")):
        if marker in p.name:
            return p
    return None


def _flat_entries(url: str, max_tracks: int | None) -> list[dict[str, Any]]:
    """First pass: flat playlist extraction for entry count + titles. A
    single-video URL is returned as a 1-item list."""
    import yt_dlp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
    }
    # A watch URL with an auto-generated radio/mix list (list=RD...) means
    # the user wants THAT video, not YouTube's endless auto-playlist.
    from urllib.parse import parse_qs, urlparse
    q = parse_qs(urlparse(url).query)
    if q.get("v") and (q.get("list", [""])[0]).startswith("RD"):
        opts["noplaylist"] = True
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info is None:
        raise RuntimeError(f"could not extract info for {url}")
    entries = list(info.get("entries") or [info])
    entries = [e for e in entries if e and e.get("id")]
    if max_tracks is not None:
        entries = entries[: max(0, int(max_tracks))]
    if not entries:
        raise RuntimeError("no downloadable entries found")
    return entries


def fetch_cues_from_youtube(video_id: str) -> list[dict]:
    """Pull a set's tracklist straight from YouTube: chapters when present
    (exact timestamps), else timestamped lines parsed from the description."""
    import yt_dlp
    import analysis as analysis_mod

    opts = {"quiet": True, "no_warnings": True, "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(
            f"https://www.youtube.com/watch?v={video_id}", download=False
        )
    chapters = (info or {}).get("chapters") or []
    cues = [
        {"t_s": float(c["start_time"]), "title": str(c.get("title") or "").strip()}
        for c in chapters
        if c.get("start_time") is not None and c.get("title")
    ]
    if cues:
        return cues
    desc = str((info or {}).get("description") or "")
    parsed = analysis_mod.parse_tracklist(desc)
    # Description parsing only counts when it found real timestamps —
    # otherwise every prose line would become a bogus "cue".
    return [c for c in parsed if c.get("t_s") is not None]


def _record_meta(
    path: Path, title: str, source_url: str, video_id: str, artist_hint: str = ""
) -> None:
    fh = analysis_mod.file_hash(path)
    # Prefer the canonical catalog title (Deezer/iTunes lookup) — YouTube
    # titles are often truncated or missing the artist; the uploader/channel
    # name disambiguates title-only queries. Falls back to the cleaned
    # YouTube title when no confident match exists or we're offline.
    resolved = resolve_full_title(title, artist_hint=artist_hint)
    db.put_track_meta(
        fh,
        title=resolved or clean_title(title),
        source_url=source_url,
        video_id=video_id,
    )


def import_playlist(
    url: str,
    dest_dir: Path,
    progress: ProgressCb = None,
    max_tracks: int | None = None,
    video_ids: list[str] | None = None,
    cancel: Callable[[], bool] | None = None,
) -> list[dict]:
    """Download every entry of a playlist (or a single video) into dest_dir.

    `video_ids` restricts the download to a user-chosen subset of playlist
    entries. Returns a list of {"path", "title", "video_id"} for
    downloaded/existing entries. Broken/private entries are skipped and
    counted in the progress messages.
    """
    import yt_dlp

    dest_dir.mkdir(parents=True, exist_ok=True)
    if progress:
        progress("download", 0.5, "Fetching playlist info")
    entries = _flat_entries(url, max_tracks)
    if video_ids:
        wanted = set(video_ids)
        entries = [e for e in entries if str(e.get("id")) in wanted]
        if not entries:
            raise RuntimeError("none of the selected tracks were found in the playlist")
    n = len(entries)

    results: list[dict] = []
    failed = 0
    for i, entry in enumerate(entries):
        if cancel and cancel():
            raise RuntimeError("cancelled")
        video_id = str(entry["id"])
        raw_title = str(entry.get("title") or video_id)
        display = clean_title(raw_title)
        watch_url = entry.get("url") or f"https://www.youtube.com/watch?v={video_id}"

        hint = str(entry.get("uploader") or entry.get("channel") or "")
        existing = _find_existing(dest_dir, video_id)
        if existing is not None:
            _record_meta(existing, raw_title, watch_url, video_id, hint)
            results.append(
                {"path": str(existing), "title": clean_title(raw_title), "video_id": video_id}
            )
            if progress:
                progress(
                    "download",
                    min(99.0, (i + 1) / n * 100.0),
                    f"Already downloaded {i + 1}/{n}: {display}",
                )
            continue

        def _hook(d: dict, _i: int = i, _title: str = display) -> None:
            if cancel and cancel():
                raise RuntimeError("cancelled")
            if progress is None or d.get("status") != "downloading":
                return
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            frac = (d.get("downloaded_bytes") or 0) / total if total else 0.0
            overall = (_i + min(max(frac, 0.0), 1.0)) / n * 100.0
            progress("download", min(99.0, overall), f"Downloading {_i + 1}/{n}: {_title}")

        opts = {
            "format": FORMAT,
            "merge_output_format": "mp4",
            "outtmpl": str(dest_dir / "%(title)s [%(id)s].%(ext)s"),
            "restrictfilenames": False,
            "ignoreerrors": True,
            "noplaylist": False,
            "overwrites": False,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "progress_hooks": [_hook],
        }
        if progress:
            progress(
                "download", min(99.0, i / n * 100.0), f"Downloading {i + 1}/{n}: {display}"
            )
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(watch_url, download=True)
        except Exception:
            info = None
        if info is None:
            failed += 1
            continue

        # Resolve the final merged file path.
        path: Path | None = None
        for rd in info.get("requested_downloads") or []:
            fp = rd.get("filepath")
            if fp and Path(fp).exists():
                path = Path(fp)
                break
        if path is None:
            path = _find_existing(dest_dir, video_id)
        if path is None:
            failed += 1
            continue

        final_title = str(info.get("title") or raw_title)
        _record_meta(path, final_title, watch_url, video_id, hint)
        results.append(
            {"path": str(path), "title": clean_title(final_title), "video_id": video_id}
        )
        if progress:
            msg = f"Downloaded {i + 1}/{n}: {clean_title(final_title)}"
            if failed:
                msg += f" ({failed} skipped)"
            progress("download", min(99.0, (i + 1) / n * 100.0), msg)

    if progress:
        msg = f"Imported {len(results)}/{n} tracks"
        if failed:
            msg += f" ({failed} skipped)"
        progress("download", 99.5, msg)
    return results


# ---------- Canonical title resolution (Deezer / iTunes lookup) ----------

def _norm_for_match(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[\(\)\[\]&,+]", " ", s)
    s = re.sub(r"\b(feat\.?|ft\.?|featuring|the|a|x)\b", " ", s)
    s = re.sub(r"[^a-z0-9\s]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _title_match_score(query: str, candidate: str) -> float:
    """Similarity in [0,1] between a query title and a catalog candidate.
    Combines difflib ratio with token overlap so word order doesn't matter."""
    from difflib import SequenceMatcher

    q, c = _norm_for_match(query), _norm_for_match(candidate)
    if not q or not c:
        return 0.0
    ratio = SequenceMatcher(None, q, c).ratio()
    qt, ct = set(q.split()), set(c.split())
    overlap = len(qt & ct) / max(1, len(qt | ct))
    return 0.5 * ratio + 0.5 * overlap


def _http_json(url: str, timeout: float = 6.0) -> Any:
    import json as _json
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "automix/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return _json.loads(resp.read().decode("utf-8"))


def _search_deezer(query: str) -> list[tuple[str, str]]:
    import urllib.parse

    url = f"https://api.deezer.com/search?q={urllib.parse.quote(query)}&limit=5"
    data = _http_json(url)
    out = []
    for item in (data.get("data") or [])[:5]:
        artist = (item.get("artist") or {}).get("name", "")
        title = item.get("title", "")
        if artist and title:
            out.append((artist, title))
    return out


def _search_itunes(query: str) -> list[tuple[str, str]]:
    import urllib.parse

    url = (
        "https://itunes.apple.com/search?media=music&entity=song&limit=5"
        f"&term={urllib.parse.quote(query)}"
    )
    data = _http_json(url)
    out = []
    for item in (data.get("results") or [])[:5]:
        artist = item.get("artistName", "")
        title = item.get("trackName", "")
        if artist and title:
            out.append((artist, title))
    return out


def _clean_artist_hint(uploader: str) -> str:
    """YouTube channel name -> artist hint ("Martin Garrix - Topic" -> "Martin Garrix")."""
    s = re.sub(r"\s*-\s*topic\s*$", "", uploader or "", flags=re.IGNORECASE)
    s = re.sub(r"vevo\s*$", "", s, flags=re.IGNORECASE)
    return s.strip()


def resolve_full_title(
    raw_title: str, artist_hint: str = "", min_score: float = 0.62
) -> str | None:
    """Look up the canonical "Artist - Title" in Deezer/iTunes.

    `artist_hint` (usually the YouTube uploader/channel) disambiguates
    title-only queries — "Pressure" alone matches many songs, but the hint
    picks the right artist. Returns None when no candidate matches
    confidently, so a bad lookup can never replace a good title with the
    wrong song."""
    query = clean_title(raw_title)
    if not query:
        return None
    hint = _clean_artist_hint(artist_hint)
    # When the title carries no artist ("Song" instead of "Artist - Song"),
    # fold the hint into both the search and the match reference.
    has_artist = " - " in query
    search_q = query if has_artist else f"{hint} {query}".strip()
    match_ref = query if has_artist else (f"{hint} - {query}" if hint else query)

    best: tuple[float, int, str] | None = None
    for engine_rank, search in enumerate((_search_deezer, _search_itunes)):
        try:
            for rank, (artist, title) in enumerate(search(search_q)):
                candidate = f"{artist} - {title}"
                score = _title_match_score(match_ref, candidate)
                if score < min_score:
                    continue
                # Prefer catalog relevance rank over tiny score differences:
                # score buckets of 0.1, then engine order, then result order.
                key = (round(score, 1), -engine_rank, -rank)
                if best is None or key > (best[0], -best[1], -best[2]):
                    best = (round(score, 1), engine_rank * 10 + rank, candidate)
        except Exception:
            continue  # offline / API down -> just use the cleaned title
    return best[2] if best else None
