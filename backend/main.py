from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from fastapi import (
    FastAPI,
    File,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import analysis as analysis_mod
import db
import models_setup
import paths
import render as render_mod
import schemas
import youtube as youtube_mod

app = FastAPI(title="Automix Backend")

app.add_middleware(
    CORSMiddleware,
    # The UI may be served from GitHub Pages / Cloudflare Pages while this
    # backend runs on the user's machine. No cookies are used, so a broad
    # origin allowance is safe for a localhost-bound service.
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_origin_regex=r"https://.*\.(github\.io|pages\.dev)",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

BACKEND_DIR = Path(__file__).parent
PROJECT_ROOT = BACKEND_DIR.parent
VIDEOS_DIR = paths.VIDEOS_DIR
IMPORTS_DIR = VIDEOS_DIR / "imports"  # downloaded source tracks
EXPORTS_DIR = VIDEOS_DIR / "exports"  # rendered automix outputs
WAVEFORM_CACHE_DIR = paths.CACHE_DIR / "waveforms"

IMPORTS_DIR.mkdir(parents=True, exist_ok=True)
EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
# One-time migration: files that used to live flat in videos/.
for _p in VIDEOS_DIR.glob("*.mp4"):
    _dest = (EXPORTS_DIR if _p.name.startswith("automix_") else IMPORTS_DIR) / _p.name
    if not _dest.exists():
        _p.rename(_dest)


# ---------- Projects (per-project import/export folders) ----------
#
# A "project" is a workspace: its own imports/<slug>/ folder of downloaded
# tracks and exports/<slug>/ folder of rendered mixes, so switching projects
# fully isolates one set of videos from another. IMPORTS_DIR / EXPORTS_DIR above
# are the ROOTS; the active project's subfolders are resolved per request.


def _slugify(name: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", name).strip("-").lower()[:48]
    return s or "project"


def _unique_slug(base: str) -> str:
    existing = {p.get("slug") for p in db.list_projects()}
    slug, i = base, 2
    while slug in existing:
        slug, i = f"{base}-{i}", i + 1
    return slug


def _create_project(name: str, config: dict | None = None) -> dict:
    pid = uuid.uuid4().hex
    slug = _unique_slug(_slugify(name))
    proj = db.add_project(pid, name.strip() or "Untitled", slug, config or {})
    (IMPORTS_DIR / slug).mkdir(parents=True, exist_ok=True)
    (EXPORTS_DIR / slug).mkdir(parents=True, exist_ok=True)
    return proj


def _active_project() -> dict:
    """The currently open project. Falls back to the most recent one, creating
    a 'Default' only if none exist yet (first run)."""
    pid = db.get_active_project_id()
    proj = db.get_project(pid) if pid else None
    if proj is None:
        projs = db.list_projects()
        proj = projs[0] if projs else _create_project("Default")
        db.set_active_project_id(proj["id"])
    return proj


def active_imports_dir() -> Path:
    d = IMPORTS_DIR / _active_project()["slug"]
    d.mkdir(parents=True, exist_ok=True)
    return d


def active_exports_dir() -> Path:
    d = EXPORTS_DIR / _active_project()["slug"]
    d.mkdir(parents=True, exist_ok=True)
    return d


def _rekey_moved_files() -> None:
    """The file hash is path-based, so files that migrated from videos/ into
    imports/ got new hashes — re-point their DB rows (analysis, titles) and
    rename cached artifacts so nothing has to be re-analyzed. Idempotent."""
    import hashlib

    previews_dir = paths.CACHE_DIR / "previews"
    for p in IMPORTS_DIR.glob("*.mp4"):
        try:
            size = p.stat().st_size
        except FileNotFoundError:
            continue
        h = hashlib.sha256()
        h.update(str((VIDEOS_DIR / p.name).resolve()).encode())
        h.update(str(size).encode())
        old = h.hexdigest()
        new = analysis_mod.file_hash(p)
        if old == new:
            continue
        if db.get_analysis(old) is None and db.get_track_meta(old) is None:
            continue
        db.rekey_file_hash(old, new)
        renames = [
            (analysis_mod.WAV_CACHE_DIR / f"{old}.wav", analysis_mod.WAV_CACHE_DIR / f"{new}.wav"),
            (analysis_mod.STEMS_CACHE_DIR / old, analysis_mod.STEMS_CACHE_DIR / new),
            (WAVEFORM_CACHE_DIR / f"{old}.json", WAVEFORM_CACHE_DIR / f"{new}.json"),
        ]
        for src, dst in renames:
            if src.exists() and not dst.exists():
                src.rename(dst)
        if previews_dir.exists():
            for f in previews_dir.glob(f"{old}_*.wav"):
                target = previews_dir / f.name.replace(old, new, 1)
                if not target.exists():
                    f.rename(target)


db.init_db()
_rekey_moved_files()
app.mount("/videos", StaticFiles(directory=str(VIDEOS_DIR)), name="videos")


# ---------- Pub/sub for WebSocket progress ----------

class ProgressHub:
    def __init__(self) -> None:
        self._subs: dict[WebSocket, str | None] = {}
        self._lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    async def register(self, ws: WebSocket, job_id: str | None = None) -> None:
        async with self._lock:
            self._subs[ws] = job_id

    async def unregister(self, ws: WebSocket) -> None:
        async with self._lock:
            self._subs.pop(ws, None)

    async def update_subscription(self, ws: WebSocket, job_id: str | None) -> None:
        async with self._lock:
            if ws in self._subs:
                self._subs[ws] = job_id

    async def publish(self, payload: dict) -> None:
        async with self._lock:
            targets = list(self._subs.items())
        jid = payload.get("job_id")
        for ws, sub in targets:
            if sub is None or sub == jid:
                try:
                    await ws.send_json(payload)
                except Exception:
                    pass

    def publish_sync(self, payload: dict) -> None:
        if self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(self.publish(payload), self._loop)


hub = ProgressHub()


def make_progress(job_id: str):
    def cb(stage: str, percent: float, message: str = "") -> None:
        hub.publish_sync(
            {
                "job_id": job_id,
                "stage": stage,
                "percent": float(percent),
                "message": message,
                "done": bool(percent >= 100.0),
            }
        )

    return cb


# ---------- Job cancellation ----------

import threading

_JOB_CANCEL: dict[str, threading.Event] = {}


def _register_cancel(job_id: str):
    ev = threading.Event()
    _JOB_CANCEL[job_id] = ev
    return ev


def _is_cancelled_error(e: Exception) -> bool:
    return "cancelled" in str(e).lower()


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> dict:
    ev = _JOB_CANCEL.get(job_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="job not found or already finished")
    ev.set()
    return {"cancelled": job_id}


@app.on_event("startup")
async def on_startup() -> None:
    db.init_db()
    hub.set_loop(asyncio.get_running_loop())
    IMPORTS_DIR.mkdir(parents=True, exist_ok=True)
    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    WAVEFORM_CACHE_DIR.mkdir(parents=True, exist_ok=True)


# ---------- Track scanning ----------

# track_id -> source path. Refreshed on every _scan_tracks; _resolve_track_path
# falls back to an rglob scan on miss (imported playlists add files at runtime).
_TRACK_PATH_CACHE: dict[str, Path] = {}


def _scan_tracks() -> list[dict]:
    imports_dir = active_imports_dir()
    if not imports_dir.exists():
        return []
    tracks: list[dict] = []
    for path in sorted(imports_dir.rglob("*.mp4")):
        # Render outputs live in exports/, but skip strays defensively.
        if path.name.startswith("automix_"):
            continue
        try:
            basic = analysis_mod.probe_basic(path)
        except Exception:
            continue
        fh = analysis_mod.file_hash(path)
        tid = fh[:16]
        _TRACK_PATH_CACHE[tid] = path
        meta = db.get_track_meta(fh)
        title = meta["title"] if meta and meta.get("title") else youtube_mod.clean_title(path.stem)
        cached = db.get_analysis(fh)
        # Backfill: older analyses miss `drops` or carry drops from an older
        # detector version. Recompute lazily from the cached WAV (fast —
        # ~1-2s per track on first scan) and persist.
        if cached is not None and (
            not cached.get("drops")
            or cached.get("drops_version") != analysis_mod.DROPS_VERSION
        ):
            wav = analysis_mod.WAV_CACHE_DIR / f"{fh}.wav"
            if wav.exists():
                try:
                    drops = analysis_mod.find_drops(
                        wav,
                        [float(d) for d in cached.get("downbeats", [])],
                        float(cached.get("bpm", 0.0)),
                    )
                    cached["drops"] = drops
                    cached["drops_version"] = analysis_mod.DROPS_VERSION
                    if cached.get("cues"):
                        drops = analysis_mod.apply_cues(
                            drops, cached["cues"], wav_path=wav,
                            bpm=float(cached.get("bpm", 0.0)),
                            downbeats=[float(x) for x in (cached.get("downbeats") or [])],
                        )
                        cached["drops"] = drops
                    db.put_analysis(fh, cached)
                except Exception:
                    cached["drops"] = []
        rel = "videos/" + path.relative_to(VIDEOS_DIR).as_posix()
        tracks.append(
            {
                "id": tid,
                "filename": path.name,
                "title": title,
                "path": rel,
                "duration_s": basic["duration_s"],
                "size_bytes": basic["size_bytes"],
                "codec_video": basic["codec_video"],
                "codec_audio": basic["codec_audio"],
                "analyzed": cached is not None,
                "analysis": cached,
            }
        )
    return tracks


def _resolve_track_path(track_id: str) -> Path:
    cached = _TRACK_PATH_CACHE.get(track_id)
    if cached is not None and cached.exists():
        return cached
    for path in active_imports_dir().rglob("*.mp4"):
        tid = analysis_mod.file_hash(path)[:16]
        _TRACK_PATH_CACHE[tid] = path
        if tid == track_id:
            return path
    raise HTTPException(status_code=404, detail=f"track {track_id} not found")


# ---------- HTTP endpoints ----------

@app.get("/api/tracks")
async def get_tracks() -> list[dict]:
    return await asyncio.to_thread(_scan_tracks)


@app.post("/api/analyze")
async def post_analyze(req: schemas.AnalyzeRequest) -> dict:
    track_path = _resolve_track_path(req.track_id)
    job_id = uuid.uuid4().hex
    progress = make_progress(job_id)

    async def _run():
        try:
            progress("analysis", 1.0, "Starting analysis")
            result = await asyncio.to_thread(analysis_mod.analyze_track, track_path, progress)
            fh = analysis_mod.file_hash(track_path)
            prior = db.get_analysis(fh)
            if prior and prior.get("cues"):
                result["cues"] = prior["cues"]
                wav2 = analysis_mod.WAV_CACHE_DIR / f"{fh}.wav"
                result["drops"] = analysis_mod.apply_cues(
                    result.get("drops") or [], prior["cues"],
                    wav_path=wav2 if wav2.exists() else None,
                    bpm=float(result.get("bpm", 0.0)),
                    downbeats=[float(x) for x in (result.get("downbeats") or [])],
                )
            db.put_analysis(fh, result)
            progress("analysis", 100.0, "Analysis complete")
        except Exception as e:
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "analysis",
                    "percent": 100.0,
                    "message": f"error: {e}",
                    "done": True,
                }
            )

    asyncio.create_task(_run())
    return {"job_id": job_id}


def _compute_waveform(track_path: Path) -> dict:
    import librosa
    import numpy as np

    cache_path = WAVEFORM_CACHE_DIR / f"{analysis_mod.file_hash(track_path)}.json"
    if cache_path.exists():
        return json.loads(cache_path.read_text())
    wav = analysis_mod.WAV_CACHE_DIR / f"{analysis_mod.file_hash(track_path)}.wav"
    analysis_mod.WAV_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if not wav.exists():
        analysis_mod.extract_wav(track_path, wav, sr=8000)
    y, sr = librosa.load(str(wav), sr=8000, mono=False)
    if y.ndim == 1:
        y = np.stack([y, y])
    samples_per_pixel = 256
    n = y.shape[1] // samples_per_pixel
    channels = []
    for c in range(y.shape[0]):
        peaks = []
        for i in range(n):
            chunk = y[c, i * samples_per_pixel : (i + 1) * samples_per_pixel]
            peaks.append(float(np.max(np.abs(chunk))))
        channels.append(peaks)
    data = {
        "version": 2,
        "channels": channels,
        "sample_rate": sr,
        "samples_per_pixel": samples_per_pixel,
        "bits": 16,
        "length": n,
    }
    cache_path.write_text(json.dumps(data))
    return data


@app.get("/api/tracks/{track_id}/waveform")
async def get_waveform(track_id: str) -> dict:
    path = _resolve_track_path(track_id)
    return await asyncio.to_thread(_compute_waveform, path)


@app.get("/api/tracks/{track_id}/video")
async def get_video(track_id: str, request: Request):
    path = _resolve_track_path(track_id)
    file_size = path.stat().st_size
    range_header = request.headers.get("range") or request.headers.get("Range")
    if range_header is None:
        return FileResponse(str(path), media_type="video/mp4")

    m = re.match(r"bytes=(\d+)-(\d*)", range_header)
    if not m:
        return FileResponse(str(path), media_type="video/mp4")
    start = int(m.group(1))
    end = int(m.group(2)) if m.group(2) else file_size - 1
    end = min(end, file_size - 1)
    length = end - start + 1

    def iter_file():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            chunk_size = 1024 * 1024
            while remaining > 0:
                data = f.read(min(chunk_size, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
    }
    return StreamingResponse(
        iter_file(), status_code=206, media_type="video/mp4", headers=headers
    )


class RevealRequest(schemas.BaseModel):
    path: str = ""  # repo-relative file path; empty = the exports folder


@app.post("/api/reveal")
async def post_reveal(req: RevealRequest) -> dict:
    """Open the containing folder in the system file manager (local tool).
    Tries FileManager1 ShowItems (selects the file), falls back to xdg-open
    on the directory."""
    target = (VIDEOS_DIR.parent / req.path.lstrip("/")).resolve() if req.path else active_exports_dir()
    if not str(target).startswith(str(VIDEOS_DIR.resolve())):
        raise HTTPException(status_code=400, detail="path outside the videos library")
    if not target.exists():
        raise HTTPException(status_code=404, detail="file not found")

    def _run() -> str:
        if target.is_file():
            try:
                subprocess.run(
                    [
                        "gdbus", "call", "--session",
                        "--dest", "org.freedesktop.FileManager1",
                        "--object-path", "/org/freedesktop/FileManager1",
                        "--method", "org.freedesktop.FileManager1.ShowItems",
                        f"['file://{target}']", "",
                    ],
                    check=True, capture_output=True, timeout=10,
                )
                return "selected"
            except Exception:
                pass
        folder = target if target.is_dir() else target.parent
        subprocess.Popen(["xdg-open", str(folder)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "opened"

    return {"result": await asyncio.to_thread(_run)}


@app.post("/api/analyze-all")
async def post_analyze_all() -> dict:
    """Analyze every track that has no cached analysis, sequentially in one
    job (parallel analyses would fight over CPU)."""
    job_id = uuid.uuid4().hex
    progress = make_progress(job_id)
    cancel_ev = _register_cancel(job_id)

    def _run_all() -> int:
        paths = [
            p for p in sorted(IMPORTS_DIR.rglob("*.mp4"))
            if not p.name.startswith("automix_")
            and db.get_analysis(analysis_mod.file_hash(p)) is None
        ]
        n = len(paths)
        if n == 0:
            return 0
        for i, path in enumerate(paths):
            if cancel_ev.is_set():
                raise RuntimeError("cancelled")
            title = _track_title(path)
            base = i / n * 100.0
            span = 100.0 / n
            progress("analysis", min(99.0, base), f"Analyzing {i + 1}/{n}: {title}")

            def sub(stage: str, pct: float, m: str = "", _b=base, _s=span, _t=title, _i=i) -> None:
                progress(
                    "analysis",
                    min(99.0, _b + pct / 100.0 * _s),
                    f"Analyzing {_i + 1}/{n}: {_t} — {m}" if m else f"Analyzing {_i + 1}/{n}: {_t}",
                )

            result = analysis_mod.analyze_track(path, sub)
            db.put_analysis(analysis_mod.file_hash(path), result)
        return n

    async def _run():
        try:
            count = await asyncio.to_thread(_run_all)
            progress(
                "analysis",
                100.0,
                f"Analyzed {count} track{'s' if count != 1 else ''}"
                if count
                else "All tracks already analyzed",
            )
        except Exception as e:
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "analysis",
                    "percent": 100.0,
                    "message": "Cancelled" if _is_cancelled_error(e) else f"error: {e}",
                    "done": True,
                }
            )
        finally:
            _JOB_CANCEL.pop(job_id, None)

    asyncio.create_task(_run())
    return {"job_id": job_id}


@app.post("/api/youtube/entries")
async def post_youtube_entries(req: schemas.YouTubeEntriesRequest) -> list[dict]:
    """Flat playlist listing so the user can pick which tracks to import."""

    def _run() -> list[dict]:
        entries = youtube_mod._flat_entries(req.url, req.max_tracks)
        out = []
        for e in entries:
            out.append(
                {
                    "id": str(e.get("id")),
                    "title": youtube_mod.clean_title(str(e.get("title") or e.get("id"))),
                    "uploader": str(e.get("uploader") or e.get("channel") or ""),
                    "duration_s": float(e["duration"]) if e.get("duration") else None,
                }
            )
        return out

    try:
        return await asyncio.to_thread(_run)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/render")
async def post_render(req: schemas.RenderRequest) -> dict:
    job_id = uuid.uuid4().hex
    progress = make_progress(job_id)
    cancel_ev = _register_cancel(job_id)
    config = req.model_dump()
    # Render into the active project's export folder (exports/<slug>/).
    config["exports_dir"] = str(active_exports_dir())

    async def _run():
        try:
            progress("render", 1.0, "Starting render")
            record = await asyncio.to_thread(
                render_mod.render_mix,
                config,
                _resolve_track_path,
                progress,
                cancel_ev.is_set,
            )
            # Final message with the real output path so the UI can play/download it.
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "render",
                    "percent": 100.0,
                    "message": _done_message(record),
                    "done": True,
                    "output_path": record["output_path"],
                    "short_path": record.get("short_path"),
                    "render_id": record["id"],
                }
            )
        except Exception as e:
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "render",
                    "percent": 100.0,
                    "message": "Cancelled" if _is_cancelled_error(e) else f"error: {e}",
                    "done": True,
                }
            )
        finally:
            _JOB_CANCEL.pop(job_id, None)

    asyncio.create_task(_run())
    # output_path is unknown until render finishes; UI must read it from the
    # final WS progress message (which carries `output_path`).
    return {"job_id": job_id, "output_path": None}


# ---------- Title fonts ----------


@app.get("/api/fonts")
def get_fonts() -> dict:
    """Selectable title fonts (assets/fonts: built-ins + uploads)."""
    return {"fonts": render_mod.list_fonts(), "default": render_mod.DEFAULT_FONT_ID}


@app.post("/api/fonts")
async def upload_font(file: UploadFile = File(...)) -> dict:
    """Add a custom title font. Re-uploading the same file name replaces it."""
    name = Path(file.filename or "").name
    ext = Path(name).suffix.lower()
    if ext not in (".ttf", ".otf"):
        raise HTTPException(status_code=400, detail="Only .ttf and .otf fonts are supported")
    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Font file is too large (20 MB max)")
    stem = re.sub(r"[^A-Za-z0-9._ -]+", "_", Path(name).stem).strip(" ._") or "font"
    render_mod.FONTS_DIR.mkdir(parents=True, exist_ok=True)
    dest = render_mod.FONTS_DIR / f"{stem}{ext}"
    dest.write_bytes(data)
    family = render_mod.font_family(dest)
    if not family:
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Not a readable font file")
    return {"id": dest.stem, "family": family, "file": dest.name}


@app.get("/api/fonts/{font_id}/file")
def get_font_file(font_id: str) -> FileResponse:
    """Raw font file, for the in-browser preview to match the render."""
    for f in render_mod.list_fonts():
        if f["id"] == font_id:
            path = render_mod.FONTS_DIR / f["file"]
            media = "font/otf" if path.suffix.lower() == ".otf" else "font/ttf"
            return FileResponse(str(path), media_type=media)
    raise HTTPException(status_code=404, detail="font not found")


@app.post("/api/short-preview")
async def short_preview(req: dict) -> Response:
    """Render a Short caption preview frame with the SAME code the renderer
    uses (rounded per-line boxes, chosen font, color Noto emoji) so the UI
    preview matches the output exactly. Returns a small PNG."""

    def _run() -> bytes:
        import io
        import tempfile

        from PIL import Image

        import short_captions as sc

        W, H = 1080, 1920
        title = str(req.get("short_title") or "").strip()
        show_artist = bool(req.get("short_show_artist"))
        font = render_mod.resolve_title_font(req.get("short_font") or req.get("title_font"))
        font_path = font[0] if font else (render_mod.FONTS_DIR / "Cubano.ttf")
        emoji: Path | None = render_mod.ASSETS_DIR / "NotoColorEmoji.ttf"
        if not emoji.exists():
            emoji = None

        frame = Image.new("RGBA", (W, H), (20, 18, 26, 255))
        tmp = Path(tempfile.mkdtemp(prefix="shortpv_"))
        try:
            def place(lines: list[tuple[str, int]], cy: int) -> None:
                lines = [(t, fs) for t, fs in lines if t.strip()]
                if not lines:
                    return
                p = tmp / "c.png"
                w, h = sc.render_block(lines, font_path, p, emoji_font=emoji, max_width=W - 40)
                im = Image.open(p).convert("RGBA")
                frame.alpha_composite(im, ((W - w) // 2, int(cy - h / 2)))

            if title:
                n = len(title)
                h_fs = 96 if n <= 20 else 84 if n <= 36 else 70 if n <= 60 else 60
                place([(ln, h_fs) for ln in sc.wrap_text(title, h_fs, font_path, 840)], 360)
            else:
                place([("Your Short title", 76)], 360)

            t_fs = sc.fit_font_size("TRACK NAME", font_path, 840, base=90)
            block: list[tuple[str, int]] = []
            if show_artist:
                block.append(("ARTIST NAME", min(t_fs, 74)))
            block.append(("TRACK NAME", t_fs))
            place(block, 1360)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

        out = frame.convert("RGB").resize((432, 768), Image.LANCZOS)
        buf = io.BytesIO()
        out.save(buf, "PNG")
        return buf.getvalue()

    png = await asyncio.to_thread(_run)
    return Response(content=png, media_type="image/png")


def _maybe_fetch_youtube_cues(
    fh: str,
    cached: dict,
    path: Path,
    progress: "ProgressCb" = None,
    pct: float = 0.0,
    title: str = "",
) -> None:
    """For DJ sets, pull the tracklist (YouTube chapters, else timestamped
    description) ONCE and label the detected drops with the song titles.

    Attempted a single time per track: once the fetch call completes we set
    `cues_tried` so we never re-hit YouTube on every automix. A network error
    leaves the flag unset so an offline import auto-retries later; the manual
    "Fetch from YouTube" button ignores the flag and always re-fetches."""
    if cached.get("cues") or cached.get("cues_tried"):
        return
    meta = db.get_track_meta(fh) or {}
    vid = meta.get("video_id")
    if not vid:
        return
    try:
        dur_s = float(analysis_mod.probe_basic(path).get("duration_s") or 0.0)
    except Exception:
        dur_s = 0.0
    if dur_s < 480.0:  # short single, not a set — no tracklist to pull
        return
    try:
        cues = youtube_mod.fetch_cues_from_youtube(str(vid))
    except Exception:
        return  # offline / transient — leave unmarked so automix retries
    cached["cues_tried"] = True  # completed an attempt; don't re-hit YouTube
    if cues:
        wav = analysis_mod.WAV_CACHE_DIR / f"{fh}.wav"
        cached["drops"] = analysis_mod.apply_cues(
            cached.get("drops") or [], cues,
            wav_path=wav if wav.exists() else None,
            bpm=float(cached.get("bpm", 0.0)),
            downbeats=[float(x) for x in (cached.get("downbeats") or [])],
        )
        cached["cues"] = cues
        if progress and title:
            progress(
                "analysis", pct,
                f"Labeled {sum(1 for d in cached['drops'] if d.get('title'))} drops from tracklist: {title}",
            )
    db.put_analysis(fh, cached)


def _analyze_imported(
    results: list[dict],
    progress: "ProgressCb",
    is_cancelled: Callable[[], bool],
) -> int:
    """Analyze freshly imported tracks so they are ready to mix straight away.
    Skips tracks that already carry an analysis; one failure never aborts the
    batch. Progress is reported across the 50-100% band (download owns 0-50).
    Returns the count now analyzed."""
    n = max(len(results), 1)
    analyzed = 0
    for i, r in enumerate(results):
        if is_cancelled():
            break
        path = Path(r["path"])
        if not path.exists():
            continue
        fh = analysis_mod.file_hash(path)
        title = r.get("title") or path.stem
        base = 50.0 + i / n * 50.0
        span = 50.0 / n

        cached = db.get_analysis(fh)
        if cached is not None:
            analyzed += 1
        else:
            def sub(stage: str, pct: float, m: str = "", _b=base, _s=span, _t=title) -> None:
                progress("analysis", min(99.0, _b + pct / 100.0 * _s), f"Analyzing {_t}")

            try:
                cached = analysis_mod.analyze_track(path, sub)
                db.put_analysis(fh, cached)
                analyzed += 1
            except Exception:
                # A bad track must not abort analysis of the rest.
                continue
        # Pull the YouTube tracklist once for DJ sets so drops are labeled
        # automatically — no manual "Fetch from YouTube" press needed.
        try:
            _maybe_fetch_youtube_cues(
                fh, cached, path, progress, min(99.0, base + span), title
            )
        except Exception:
            pass
    return analyzed


@app.post("/api/youtube/import")
async def post_youtube_import(req: schemas.YouTubeImportRequest) -> dict:
    job_id = uuid.uuid4().hex
    progress = make_progress(job_id)
    cancel_ev = _register_cancel(job_id)

    async def _run():
        try:
            # Download owns the first half of the progress bar; the new
            # auto-analysis pass owns the second half.
            def dl_progress(stage: str, pct: float, msg: str = "") -> None:
                progress(stage, pct * 0.5, msg)

            results = await asyncio.to_thread(
                youtube_mod.import_playlist,
                req.url,
                active_imports_dir(),
                dl_progress,
                req.max_tracks,
                req.video_ids,
                cancel_ev.is_set,
                req.max_height,
            )
            # Auto-analyze so imported tracks are immediately mixable.
            progress("analysis", 50.0, f"Analyzing {len(results)} imported tracks")
            analyzed = await asyncio.to_thread(
                _analyze_imported, results, progress, cancel_ev.is_set
            )
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "analysis",
                    "percent": 100.0,
                    "message": f"Imported and analyzed {analyzed}/{len(results)} tracks",
                    "done": True,
                }
            )
        except Exception as e:
            if _is_cancelled_error(e):
                hub.publish_sync(
                    {
                        "job_id": job_id,
                        "stage": "download",
                        "percent": 100.0,
                        "message": "Cancelled",
                        "done": True,
                    }
                )
                return
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "download",
                    "percent": 100.0,
                    "message": f"error: {e}",
                    "done": True,
                }
            )
        finally:
            _JOB_CANCEL.pop(job_id, None)

    asyncio.create_task(_run())
    return {"job_id": job_id}


# ---------- Automix: import → analyze → pick drops → render ----------

AUTOMIX_DEFAULT_CONFIG: dict[str, Any] = {
    # Beat-match: stretch clips (ffmpeg atempo, pitch-preserving) to a common
    # BPM so the whole mix rides one steady grid — the reference EDMPAPA mixes
    # hold ~129 BPM throughout. Clips >8% off stay native (render.py clamps).
    "no_time_stretch": False,
    "snap_to_downbeat": True,
    # 2-bar blend matching the clips' 2-bar pre-kick lead-in: the incoming
    # track's vocal/riser build plays over the outgoing tail (which decays
    # fast), and the kick lands exactly on the outgoing's final downbeat.
    "crossfade_bars": 2.0,
    "loudness_lufs": -14,
    "use_stem_crossfade": False,
    "use_eq_bass_swap": False,
    "harmonic_pitch_shift_max_semitones": 0,
    "brand_overlay": True,
    "show_titles": True,
    # Full-video title font (Bebas Neue by default; the Short uses short_font).
    "title_font": "BebasNeue-Regular",
    # Companion vertical Short of the first drop, rendered next to the mix.
    "make_short": True,
    # EDMPAPA template overlay on the Short (False = clean full-width Short).
    "short_overlay": False,
    # Custom Short caption and teaser length (0 = full, up to the 1-min cap).
    "short_title": "",
    "short_max_s": 0.0,
    # Short text font (default Cubano; the full video uses Bebas Neue).
    "short_font": "Cubano",
    # Render only the vertical Short (skip the full video) when True.
    "short_only": False,
    # "Watch the full video" end card on the Short (off by default).
    "short_end_card": False,
    # Show the artist name above the track on the Short (off = track only).
    "short_show_artist": False,
    # Drop length: full mix 8 bars, Short 4 bars (punchier). When they match,
    # the Short reuses the full mix (one render); differing = a second, shorter
    # Short-specific mix is rendered. 0 = auto.
    "drop_bars": 8.0,
    "short_drop_bars": 4.0,
    # Video encoder: auto uses a working GPU encoder when present, else CPU.
    "hw_accel": "auto",
    # Black + silence after the mix ends, for YouTube end screens (which
    # occupy the last 5-20s of a video).
    "outro_s": 10.0,
}


def _done_message(record: dict) -> str:
    """Completion message carrying the verify guard's verdict."""
    v = record.get("verification")
    if not v:
        return "Done"
    if v.get("passed"):
        return "Done, verified: seams, loudness and titles all pass"
    probs = v.get("problems") or []
    head = probs[0] if probs else "unknown problem"
    more = f" (+{len(probs) - 1} more)" if len(probs) > 1 else ""
    return f"Done, but verification found problems: {head}{more}"


def _track_title(path: Path) -> str:
    meta = db.get_track_meta(analysis_mod.file_hash(path))
    if meta and meta.get("title"):
        return meta["title"]
    return youtube_mod.clean_title(path.stem)


def _automix_pipeline(req: schemas.AutomixRequest, progress, cancel=None) -> dict:
    def _check_cancel() -> None:
        if cancel and cancel():
            raise RuntimeError("cancelled")

    """Sync pipeline run in a worker thread. Returns the render record."""
    # 1. Optional playlist import, mapped to 0-30%.
    if req.url:
        def dl_progress(stage: str, pct: float, msg: str = "") -> None:
            progress("download", min(30.0, pct * 0.30), msg)

        youtube_mod.import_playlist(
            req.url, active_imports_dir(), dl_progress, req.max_tracks, req.video_ids, cancel,
            req.max_height,
        )

    # 2. Determine source tracks.
    if req.track_ids:
        paths = [_resolve_track_path(tid) for tid in req.track_ids]
    else:
        paths = [
            p for p in sorted(active_imports_dir().rglob("*.mp4"))
            if not p.name.startswith("automix_")
        ]
    if not paths:
        raise RuntimeError("no tracks found to mix")

    # 3. Analyze tracks missing cached analysis, mapped to 30-70%.
    n = len(paths)
    entries: list[tuple[str, dict]] = []
    for i, path in enumerate(paths):
        _check_cancel()
        fh = analysis_mod.file_hash(path)
        title = _track_title(path)
        cached = db.get_analysis(fh)
        # Drops from an older detector version may point at vocal sections —
        # recompute them before building clips.
        if cached is not None and cached.get("drops_version") != analysis_mod.DROPS_VERSION:
            wav = analysis_mod.WAV_CACHE_DIR / f"{fh}.wav"
            if wav.exists():
                try:
                    cached["drops"] = analysis_mod.find_drops(
                        wav,
                        [float(d) for d in cached.get("downbeats", [])],
                        float(cached.get("bpm", 0.0)),
                    )
                    # Fresh detection wiped the cue labels — re-apply them,
                    # or the set-clip builder below would take every raw
                    # drop untitled instead of one-best-per-cue.
                    if cached.get("cues"):
                        cached["drops"] = analysis_mod.apply_cues(
                            cached["drops"], cached["cues"],
                            wav_path=wav,
                            bpm=float(cached.get("bpm", 0.0)),
                            downbeats=[float(x) for x in (cached.get("downbeats") or [])],
                        )
                    cached["drops_version"] = analysis_mod.DROPS_VERSION
                    db.put_analysis(fh, cached)
                except Exception:
                    pass
        if cached is None:
            base = 30.0 + i / n * 40.0
            span = 40.0 / n
            msg = f"Analyzing {i + 1}/{n}: {title}"
            progress("analysis", base, msg)

            def sub(stage: str, pct: float, m: str = "", _b=base, _s=span, _msg=msg) -> None:
                progress("analysis", min(70.0, _b + pct / 100.0 * _s), _msg)

            try:
                cached = analysis_mod.analyze_track(path, sub)
                db.put_analysis(fh, cached)
            except Exception:
                # One bad track must not kill the whole automix.
                continue
        # DJ sets: pull the tracklist (YouTube chapters) automatically so
        # every drop carries the right song title. Normally already fetched at
        # import; this covers tracks imported before that and offline retries.
        if cached is not None:
            try:
                _maybe_fetch_youtube_cues(
                    fh, cached, path, progress, 30.0 + (i + 1) / n * 40.0, title
                )
            except Exception:
                pass  # offline / no chapters — titles fall back to track title
        entries.append((fh, cached))
    progress("analysis", 70.0, f"Analysis ready for {len(entries)}/{n} tracks")

    # 4. Build clips: best-scoring drop per track, ordered by BPM ascending.
    # A track WITH cues is a full DJ set: use every cue-labeled drop (one per
    # song, in set order), each clip titled by its cue.
    clips: list[dict] = []
    # Transition style measured from the reference EDMPAPA mixes: each track
    # plays at full energy until just before the NEXT kick, then a short
    # "breath" (riser tail), then the drop slams in. The breath is exactly
    # 2 beats at the clip's own BPM: after time-stretching to the target BPM
    # it equals the 0.5-bar crossfade, so the incoming kick lands precisely on
    # the downbeat where the outgoing clip ends — beat-matched transitions.
    # The first clip keeps its full detected buildup as the mix intro.

    # Optional user selection: {track_id: [kick_s, ...]} — only these drops
    # are used for that track (UI lets the user pick among multiple drops).
    selected_kicks: dict[str, list[float]] = {
        str(k): [float(x) for x in v]
        for k, v in ((req.config or {}).get("selected_kicks") or {}).items()
    }

    for fh, a in entries:
        drops = a.get("drops") or []
        sel = selected_kicks.get(fh[:16])
        if sel and drops:
            drops = [
                d for d in drops
                if d.get("kick_s") is not None
                and any(abs(float(d["kick_s"]) - s) < 0.75 for s in sel)
            ]
            chosen = sorted(drops, key=lambda d: float(d.get("start_s", 0.0)))
        elif drops and a.get("cues"):
            # Full DJ set: one clip per song (the primary drop), in set
            # order. Non-primary alternates stay in the library list for
            # manual swapping but don't auto-enter the mix.
            chosen = sorted(
                (d for d in drops if d.get("primary", True) and d.get("title")),
                key=lambda d: float(d.get("start_s", 0.0)),
            )
        elif drops:
            chosen = [
                max(
                    drops,
                    key=lambda d: (
                        float(d.get("confidence") or 0.0),
                        float(d.get("score", 0.0)),
                    ),
                )
            ]
        else:
            chosen = []
            start, end = a.get("drop_start_s"), a.get("drop_end_s")
            if start is not None and end is not None and float(end) > float(start):
                chosen = [{"start_s": start, "end_s": end, "kick_s": None}]
        # DJ-set drops: give every drop a FULL 8-bar body. Detection cuts a
        # 4-bar body when energy dips early, but with a 2-bar crossfade that
        # leaves only ~2 bars of clean drop ("some drops are 2-3 seconds").
        # The set is continuous audio, so extending is always safe up to the
        # next song's chapter boundary.
        timed_cue_ts = sorted(
            float(c["t_s"]) for c in (a.get("cues") or []) if c.get("t_s") is not None
        )

        # Settings > Mix > Drop length: 0 = auto (detected body, extended to
        # 8 bars for set drops), otherwise force every drop to N bars.
        drop_bars = float((req.config or {}).get("drop_bars") or 0.0)

        def _extended_end(d: dict) -> float | None:
            end = d.get("end_s")
            kick, per = d.get("kick_s"), d.get("kick_period_s")
            if end is None or kick is None:
                return end
            if not a.get("cues") and drop_bars <= 0:
                return end
            bar = 4.0 * float(per) if per else 4.0 * 60.0 / float(a.get("bpm") or 128.0)
            want = float(kick) + (drop_bars if drop_bars > 0 else 8.0) * bar
            nxt = next((t for t in timed_cue_ts if t > float(kick) + 1.0), None)
            if nxt is not None:
                want = min(want, nxt - 0.5)
            if drop_bars > 0:
                return want
            return max(float(end), want)

        for d in chosen:
            start, end, kick = d.get("start_s"), _extended_end(d), d.get("kick_s")
            if start is None or end is None or float(end) <= float(start):
                continue  # no usable drop
            clips.append(
                {
                    "track_id": fh[:16],
                    "start_s": float(start),
                    "end_s": float(end),
                    "kick_s": float(kick) if kick is not None else None,
                    "title": d.get("title") or None,
                    "length_bars": 16,
                    "_bpm": float(a.get("bpm", 0.0)),
                    "_t": float(start),
                }
            )
    if not clips:
        raise RuntimeError("no usable drops found in any track")
    max_clips = int((req.config or {}).get("max_clips") or 0)
    if max_clips > 0 and len(clips) > max_clips:
        clips = clips[:max_clips]
    # BPM ascending across tracks; multiple clips of one track keep set order.
    clips.sort(key=lambda c: (c["_bpm"], c["_t"]))
    for i, c in enumerate(clips):
        c.pop("_t")
        bpm = c.pop("_bpm")
        if i > 0 and c["kick_s"] is not None:
            breath = 8.0 * 60.0 / bpm if bpm > 0 else 3.5
            c["start_s"] = max(0.0, c["kick_s"] - breath)

    # 5. Render, mapped to 70-100%.
    config = {
        **AUTOMIX_DEFAULT_CONFIG,
        **(req.config or {}),
        "clips": clips,
        "exports_dir": str(active_exports_dir()),
    }

    def render_progress(stage: str, pct: float, msg: str = "") -> None:
        progress("render", min(99.5, 70.0 + pct * 0.30), msg)

    _check_cancel()
    return render_mod.render_mix(config, _resolve_track_path, render_progress, cancel)


@app.post("/api/automix")
async def post_automix(req: schemas.AutomixRequest) -> dict:
    job_id = uuid.uuid4().hex
    progress = make_progress(job_id)
    cancel_ev = _register_cancel(job_id)

    async def _run():
        try:
            record = await asyncio.to_thread(
                _automix_pipeline, req, progress, cancel_ev.is_set
            )
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "render",
                    "percent": 100.0,
                    "message": _done_message(record),
                    "done": True,
                    "output_path": record["output_path"],
                    "short_path": record.get("short_path"),
                    "render_id": record["id"],
                }
            )
        except Exception as e:
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "render",
                    "percent": 100.0,
                    "message": "Cancelled" if _is_cancelled_error(e) else f"error: {e}",
                    "done": True,
                }
            )
        finally:
            _JOB_CANCEL.pop(job_id, None)

    asyncio.create_task(_run())
    return {"job_id": job_id}


@app.get("/api/renders")
async def get_renders() -> list[dict]:
    return await asyncio.to_thread(db.list_renders)


@app.get("/api/projects")
async def list_projects() -> list[dict]:
    def _run() -> list[dict]:
        projs = db.list_projects()
        if not projs:
            # First run: seed a Default so there's always something to open.
            projs = [_create_project("Default")]
        active = db.get_active_project_id()
        for p in projs:
            p["active"] = p["id"] == active
        return projs

    return await asyncio.to_thread(_run)


@app.get("/api/projects/active")
async def get_active_project() -> dict:
    return await asyncio.to_thread(_active_project)


@app.post("/api/projects")
async def post_project(payload: schemas.ProjectCreate) -> dict:
    def _run() -> dict:
        proj = _create_project(payload.name, payload.config)
        db.set_active_project_id(proj["id"])  # open the new project immediately
        return proj

    return await asyncio.to_thread(_run)


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str) -> dict:
    p = await asyncio.to_thread(db.get_project, project_id)
    if not p:
        raise HTTPException(status_code=404, detail="project not found")
    return p


@app.patch("/api/projects/{project_id}")
async def patch_project(project_id: str, payload: schemas.ProjectRename) -> dict:
    def _run() -> dict:
        if not db.get_project(project_id):
            raise HTTPException(status_code=404, detail="project not found")
        db.rename_project(project_id, payload.name.strip() or "Untitled")
        return db.get_project(project_id)

    return await asyncio.to_thread(_run)


@app.put("/api/projects/{project_id}/config")
async def put_project_config(project_id: str, payload: schemas.ProjectConfig) -> dict:
    def _run() -> dict:
        if not db.get_project(project_id):
            raise HTTPException(status_code=404, detail="project not found")
        db.update_project_config(project_id, payload.config)
        return db.get_project(project_id)

    return await asyncio.to_thread(_run)


@app.post("/api/projects/{project_id}/activate")
async def activate_project(project_id: str) -> dict:
    def _run() -> dict:
        proj = db.get_project(project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        db.set_active_project_id(project_id)
        db.touch_project(project_id)
        _TRACK_PATH_CACHE.clear()  # track ids are per-project; drop stale entries
        return db.get_project(project_id)

    return await asyncio.to_thread(_run)


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str) -> dict:
    def _run() -> dict:
        proj = db.get_project(project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        slug = proj.get("slug") or ""
        if slug:
            shutil.rmtree(IMPORTS_DIR / slug, ignore_errors=True)
            shutil.rmtree(EXPORTS_DIR / slug, ignore_errors=True)
        db.delete_project(project_id)
        if db.get_active_project_id() == project_id:
            remaining = db.list_projects()
            if remaining:
                db.set_active_project_id(remaining[0]["id"])
            else:
                db.set_app_state("active_project_id", "")
        _TRACK_PATH_CACHE.clear()
        return {"deleted": project_id}

    return await asyncio.to_thread(_run)


@app.get("/api/mixes")
async def list_mixes() -> list[dict]:
    """All rendered automix videos, newest first."""

    def _run() -> list[dict]:
        out = []
        # Renders for the active project live directly in exports/<slug>/ as
        # automix_*.mp4 (+ _short.mp4 + .verify.json). One entry per full mix —
        # the Short is folded in as short_path, not listed separately.
        all_mp4 = list(active_exports_dir().rglob("automix_*.mp4"))
        fulls = [p for p in all_mp4 if not p.name.endswith("_short.mp4")]
        full_set = set(fulls)
        # Short-only renders leave just a *_short.mp4 with no full video; list
        # those on their own so they still show up in the library.
        entries = list(fulls)
        for sp in all_mp4:
            if not sp.name.endswith("_short.mp4"):
                continue
            base = sp.with_name(sp.name[: -len("_short.mp4")] + ".mp4")
            if base not in full_set:
                entries.append(sp)
        entries.sort(key=lambda x: x.stat().st_mtime, reverse=True)
        for p in entries:
            st = p.stat()
            is_short = p.name.endswith("_short.mp4")
            short = None if is_short else p.with_name(f"{p.stem}_short.mp4")
            out.append(
                {
                    "filename": p.name,
                    "path": f"videos/{p.relative_to(VIDEOS_DIR).as_posix()}",
                    "short_path": (
                        f"videos/{short.relative_to(VIDEOS_DIR).as_posix()}"
                        if short is not None and short.exists()
                        else None
                    ),
                    "size_bytes": st.st_size,
                    "created_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
                }
            )
        return out

    return await asyncio.to_thread(_run)


def _safe_video_file(filename: str, prefix: str | None = None) -> Path:
    name = Path(filename).name  # strip any path components
    if name != filename or "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="invalid filename")
    if prefix and not name.startswith(prefix):
        raise HTTPException(status_code=400, detail="not a rendered mix")
    # Renders live directly in the active project's exports/<slug>/; search by
    # basename (timestamped, so unique).
    p = next((q for q in active_exports_dir().rglob(name) if q.is_file()), None)
    if p is None:
        raise HTTPException(status_code=404, detail="file not found")
    return p


@app.delete("/api/mixes/{filename}")
async def delete_mix(filename: str) -> dict:
    p = _safe_video_file(filename, prefix="automix_")

    def _remove() -> None:
        # Mixes share the project export folder, so remove just this mix's trio
        # (full + Short + verification report), never the folder itself.
        for f in (p, p.with_name(f"{p.stem}_short.mp4"), p.with_suffix(".verify.json")):
            f.unlink(missing_ok=True)

    await asyncio.to_thread(_remove)
    return {"deleted": filename}


@app.delete("/api/tracks/{track_id}")
async def delete_track(track_id: str) -> dict:
    path = _resolve_track_path(track_id)
    if path.name.startswith("automix_"):
        raise HTTPException(status_code=400, detail="use /api/mixes to delete renders")
    await asyncio.to_thread(path.unlink)
    _TRACK_PATH_CACHE.pop(track_id, None)
    return {"deleted": path.name}


PREVIEW_CACHE_DIR = paths.CACHE_DIR / "previews"


@app.get("/api/tracks/{track_id}/clip")
async def get_track_clip(track_id: str, start: float, end: float):
    """A clip's audio segment as WAV — feeds the browser's live mix preview.
    Cut from the cached analysis WAV when available (instant), else the
    source video. Cached on disk per (track, start, end)."""
    path = _resolve_track_path(track_id)
    start = max(0.0, float(start))
    dur = min(120.0, float(end) - start)
    if dur <= 0:
        raise HTTPException(status_code=400, detail="end must be after start")

    fh = analysis_mod.file_hash(path)
    # "n14" = loudness-normalized to -14 LUFS, matching the renderer — so a
    # quiet master previews at the same level it will have in the export.
    out = PREVIEW_CACHE_DIR / f"{fh}_{start:.2f}_{dur:.2f}_n14.wav"

    def _run() -> Path:
        if out.exists():
            return out
        PREVIEW_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        wav = analysis_mod.WAV_CACHE_DIR / f"{fh}.wav"
        src = wav if wav.exists() else path
        tmp = out.with_suffix(".tmp.wav")
        cmd = [
            "ffmpeg", "-y", "-ss", f"{start:.3f}", "-t", f"{dur:.3f}",
            "-i", str(src), "-vn", "-ac", "2", "-ar", "44100",
            "-acodec", "pcm_f32le", str(tmp),
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        normed = out.with_suffix(".norm.wav")
        # Same normalization the renderer uses: pure linear gain (loudnorm's
        # dynamic mode pumps loud EDM program) + a peak safety net.
        render_mod._normalize_linear(tmp, normed, -14.0)
        render_mod._limit_peaks(normed, ceiling_db=-1.2)
        tmp.unlink(missing_ok=True)
        normed.rename(out)
        return out

    p = await asyncio.to_thread(_run)
    return FileResponse(p, media_type="audio/wav")


class TracklistRequest(schemas.BaseModel):
    text: str = ""
    auto: bool = False  # fetch chapters/description from YouTube instead


@app.post("/api/tracklist/parse")
async def parse_tracklist_preview(req: TracklistRequest) -> dict:
    """Dry-run parse of pasted tracklist text (1001tracklists page copies,
    timestamped lists, plain lists) so the UI can preview the cues."""
    cues = analysis_mod.parse_tracklist(req.text)
    return {"cues": cues}


@app.post("/api/tracks/{track_id}/cues")
async def post_track_cues(track_id: str, req: TracklistRequest) -> dict:
    """Attach a pasted tracklist (timestamped or not) to a track and label
    its detected drops with the cue titles."""
    path = _resolve_track_path(track_id)
    fh = analysis_mod.file_hash(path)

    def _run() -> dict:
        if req.auto:
            meta = db.get_track_meta(fh) or {}
            vid = meta.get("video_id")
            if not vid:
                raise ValueError("no YouTube video id recorded for this track")
            cues = youtube_mod.fetch_cues_from_youtube(str(vid))
            if not cues:
                raise ValueError("no chapters or timestamped tracklist found on YouTube")
        else:
            cues = analysis_mod.parse_tracklist(req.text)
        if not cues:
            raise ValueError("no tracklist lines recognized")
        cached = db.get_analysis(fh)
        if cached is None:
            raise ValueError("analyze the track first")
        wav = analysis_mod.WAV_CACHE_DIR / f"{fh}.wav"
        drops = analysis_mod.apply_cues(
            cached.get("drops") or [], cues,
            wav_path=wav if wav.exists() else None,
            bpm=float(cached.get("bpm", 0.0)),
            downbeats=[float(x) for x in (cached.get("downbeats") or [])],
        )
        cached["drops"] = drops
        cached["cues"] = cues
        db.put_analysis(fh, cached)
        labeled = sum(1 for d in drops if d.get("title"))
        return {"cues": len(cues), "labeled": labeled}

    try:
        return await asyncio.to_thread(_run)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class DropRetitleRequest(schemas.BaseModel):
    old_title: str
    new_title: str


@app.post("/api/tracks/{track_id}/drops/retitle")
async def retitle_drops(track_id: str, req: DropRetitleRequest) -> dict:
    """Rename a song's drops (all candidates sharing the old title) plus the
    matching tracklist cue — chapter names are sometimes wrong."""
    path = _resolve_track_path(track_id)
    fh = analysis_mod.file_hash(path)
    new = req.new_title.strip()
    if not new:
        raise HTTPException(status_code=400, detail="title must not be empty")

    def _run() -> dict:
        cached = db.get_analysis(fh)
        if cached is None:
            raise ValueError("analyze the track first")
        n = 0
        for d in cached.get("drops") or []:
            if (d.get("title") or "") == req.old_title:
                d["title"] = new
                n += 1
        for c in cached.get("cues") or []:
            if (c.get("title") or "") == req.old_title:
                c["title"] = new
        db.put_analysis(fh, cached)
        return {"renamed": n}

    try:
        return await asyncio.to_thread(_run)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.patch("/api/tracks/{track_id}")
async def rename_track(track_id: str, req: schemas.RenameTrackRequest) -> dict:
    """Set a custom display title for a library track."""
    path = _resolve_track_path(track_id)
    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="title must not be empty")

    def _run() -> dict:
        fh = analysis_mod.file_hash(path)
        meta = db.get_track_meta(fh) or {}
        db.put_track_meta(
            fh,
            title=title,
            artist=meta.get("artist", ""),
            source_url=meta.get("source_url", ""),
            video_id=meta.get("video_id", ""),
        )
        return {"id": track_id, "title": title}

    return await asyncio.to_thread(_run)


@app.post("/api/tracks/refresh-titles")
async def refresh_titles() -> dict:
    """Re-resolve canonical titles for every library track via Deezer/iTunes.
    Tracks without a confident catalog match keep their cleaned filename title."""

    def _run() -> dict:
        updated: list[dict] = []
        for path in sorted(IMPORTS_DIR.rglob("*.mp4")):
            if path.name.startswith("automix_"):
                continue
            fh = analysis_mod.file_hash(path)
            meta = db.get_track_meta(fh)
            current = meta["title"] if meta and meta.get("title") else youtube_mod.clean_title(path.stem)
            # Title-only filenames need an artist hint; get the uploader from
            # YouTube when we know the source video.
            hint = ""
            vid = (meta or {}).get("video_id", "")
            if vid and " - " not in youtube_mod.clean_title(path.stem):
                try:
                    import yt_dlp
                    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
                        info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False, process=False)
                    hint = str((info or {}).get("uploader") or (info or {}).get("channel") or "")
                except Exception:
                    hint = ""
            resolved = youtube_mod.resolve_full_title(path.stem, artist_hint=hint)
            if resolved and resolved != current:
                db.put_track_meta(
                    fh,
                    title=resolved,
                    source_url=(meta or {}).get("source_url", ""),
                    video_id=(meta or {}).get("video_id", ""),
                )
                updated.append({"from": current, "to": resolved})
        return {"updated": len(updated), "changes": updated}

    return await asyncio.to_thread(_run)


@app.get("/api/models/status")
async def models_status() -> dict:
    return await asyncio.to_thread(models_setup.get_status)


@app.post("/api/models/download")
async def models_download() -> dict:
    if not await asyncio.to_thread(models_setup.ml_installed):
        raise HTTPException(
            status_code=409,
            detail=(
                "The optional neural stack isn't installed in this venv. "
                'Install it with: pip install -e "backend[ml]" (~2-3 GB, needs a GPU to be practical), '
                "then retry. The built-in lite analyzer works without it."
            ),
        )
    job_id = "models"
    progress = make_progress(job_id)

    async def _run():
        try:
            await asyncio.to_thread(models_setup.download_with_progress, progress)
        except Exception as e:
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "download",
                    "percent": 100.0,
                    "message": f"error: {e}",
                    "done": True,
                }
            )

    asyncio.create_task(_run())
    return {"job_id": job_id}


# ---------- WebSocket ----------

@app.websocket("/ws/progress")
async def ws_progress(ws: WebSocket) -> None:
    await ws.accept()
    await hub.register(ws, None)
    try:
        while True:
            try:
                msg = await ws.receive_text()
            except WebSocketDisconnect:
                break
            try:
                data = json.loads(msg)
                if isinstance(data, dict) and "subscribe" in data:
                    sub = data["subscribe"]
                    await hub.update_subscription(ws, sub if isinstance(sub, str) else None)
            except Exception:
                pass
    finally:
        await hub.unregister(ws)
