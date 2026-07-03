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


def _record_meta(path: Path, title: str, source_url: str, video_id: str) -> None:
    fh = analysis_mod.file_hash(path)
    db.put_track_meta(
        fh, title=clean_title(title), source_url=source_url, video_id=video_id
    )


def import_playlist(
    url: str,
    dest_dir: Path,
    progress: ProgressCb = None,
    max_tracks: int | None = None,
) -> list[dict]:
    """Download every entry of a playlist (or a single video) into dest_dir.

    Returns a list of {"path", "title", "video_id"} for downloaded/existing
    entries. Broken/private entries are skipped and counted in the progress
    messages.
    """
    import yt_dlp

    dest_dir.mkdir(parents=True, exist_ok=True)
    if progress:
        progress("download", 0.5, "Fetching playlist info")
    entries = _flat_entries(url, max_tracks)
    n = len(entries)

    results: list[dict] = []
    failed = 0
    for i, entry in enumerate(entries):
        video_id = str(entry["id"])
        raw_title = str(entry.get("title") or video_id)
        display = clean_title(raw_title)
        watch_url = entry.get("url") or f"https://www.youtube.com/watch?v={video_id}"

        existing = _find_existing(dest_dir, video_id)
        if existing is not None:
            _record_meta(existing, raw_title, watch_url, video_id)
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
        _record_meta(path, final_title, watch_url, video_id)
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
