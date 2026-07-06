"""Download static ffmpeg, ffprobe, and yt-dlp for the current platform into
`bin/` so PyInstaller can bundle them. Run from the repo root in CI:

    python packaging/fetch_tools.py

No third-party deps (stdlib only). If a source URL rots, fix it here.
"""

from __future__ import annotations

import io
import os
import platform
import stat
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "bin"
BIN.mkdir(exist_ok=True)

IS_WIN = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"
IS_LINUX = sys.platform.startswith("linux")
ARM = platform.machine().lower() in ("arm64", "aarch64")


def _get(url: str) -> bytes:
    print(f"  downloading {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "automix-build"})
    with urllib.request.urlopen(req) as r:  # noqa: S310 (trusted release hosts)
        return r.read()


def _write(name: str, data: bytes) -> None:
    dest = BIN / name
    dest.write_bytes(data)
    dest.chmod(dest.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    print(f"  wrote {dest} ({len(data) // 1024} KB)")


def fetch_ytdlp() -> None:
    print("yt-dlp:")
    base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/"
    if IS_WIN:
        _write("yt-dlp.exe", _get(base + "yt-dlp.exe"))
    elif IS_MAC:
        _write("yt-dlp", _get(base + "yt-dlp_macos"))
    else:
        _write("yt-dlp", _get(base + "yt-dlp"))


def fetch_ffmpeg() -> None:
    print("ffmpeg/ffprobe:")
    if IS_LINUX:
        arch = "arm64" if ARM else "amd64"
        raw = _get(f"https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-{arch}-static.tar.xz")
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:xz") as tf:
            for m in tf.getmembers():
                base = os.path.basename(m.name)
                if base in ("ffmpeg", "ffprobe") and m.isfile():
                    _write(base, tf.extractfile(m).read())
    elif IS_WIN:
        raw = _get("https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip")
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            for n in zf.namelist():
                base = os.path.basename(n)
                if base in ("ffmpeg.exe", "ffprobe.exe"):
                    _write(base, zf.read(n))
    elif IS_MAC:
        # evermeet ships notarized static builds. Intel binaries run on Apple
        # Silicon via Rosetta; swap to an arm64 source here if you want native.
        for tool in ("ffmpeg", "ffprobe"):
            raw = _get(f"https://evermeet.cx/ffmpeg/getrelease/{tool}/zip")
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                name = next(n for n in zf.namelist() if os.path.basename(n) == tool)
                _write(tool, zf.read(name))


if __name__ == "__main__":
    fetch_ytdlp()
    fetch_ffmpeg()
    print("\nBundled tools:")
    for f in sorted(BIN.iterdir()):
        print(f"  {f.name}")
