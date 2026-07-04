from __future__ import annotations

import asyncio
import json
import re
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

import analysis as analysis_mod
import db
import models_setup
import render as render_mod
import schemas
import youtube as youtube_mod

app = FastAPI(title="Automix Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BACKEND_DIR = Path(__file__).parent
PROJECT_ROOT = BACKEND_DIR.parent
VIDEOS_DIR = PROJECT_ROOT / "videos"
IMPORTS_DIR = VIDEOS_DIR / "imports"  # downloaded source tracks
EXPORTS_DIR = VIDEOS_DIR / "exports"  # rendered automix outputs
WAVEFORM_CACHE_DIR = BACKEND_DIR / ".cache" / "waveforms"

IMPORTS_DIR.mkdir(parents=True, exist_ok=True)
EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
# One-time migration: files that used to live flat in videos/.
for _p in VIDEOS_DIR.glob("*.mp4"):
    _dest = (EXPORTS_DIR if _p.name.startswith("automix_") else IMPORTS_DIR) / _p.name
    if not _dest.exists():
        _p.rename(_dest)


def _rekey_moved_files() -> None:
    """The file hash is path-based, so files that migrated from videos/ into
    imports/ got new hashes — re-point their DB rows (analysis, titles) and
    rename cached artifacts so nothing has to be re-analyzed. Idempotent."""
    import hashlib

    previews_dir = BACKEND_DIR / ".cache" / "previews"
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
    if not IMPORTS_DIR.exists():
        return []
    tracks: list[dict] = []
    for path in sorted(IMPORTS_DIR.rglob("*.mp4")):
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
                    db.put_analysis(fh, cached)
                except Exception:
                    cached["drops"] = []
        rel = str(path.relative_to(PROJECT_ROOT))
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
    for path in IMPORTS_DIR.rglob("*.mp4"):
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


@app.post("/api/render")
async def post_render(req: schemas.RenderRequest) -> dict:
    job_id = uuid.uuid4().hex
    progress = make_progress(job_id)
    config = req.model_dump()

    async def _run():
        try:
            progress("render", 1.0, "Starting render")
            record = await asyncio.to_thread(
                render_mod.render_mix, config, _resolve_track_path, progress
            )
            # Final message with the real output path so the UI can play/download it.
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "render",
                    "percent": 100.0,
                    "message": "Done",
                    "done": True,
                    "output_path": record["output_path"],
                    "render_id": record["id"],
                }
            )
        except Exception as e:
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "render",
                    "percent": 100.0,
                    "message": f"error: {e}",
                    "done": True,
                }
            )

    asyncio.create_task(_run())
    # output_path is unknown until render finishes; UI must read it from the
    # final WS progress message (which carries `output_path`).
    return {"job_id": job_id, "output_path": None}


@app.post("/api/youtube/import")
async def post_youtube_import(req: schemas.YouTubeImportRequest) -> dict:
    job_id = uuid.uuid4().hex
    progress = make_progress(job_id)

    async def _run():
        try:
            results = await asyncio.to_thread(
                youtube_mod.import_playlist, req.url, IMPORTS_DIR, progress, req.max_tracks
            )
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "download",
                    "percent": 100.0,
                    "message": f"Imported {len(results)} tracks",
                    "done": True,
                }
            )
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


# ---------- Automix: import → analyze → pick drops → render ----------

AUTOMIX_DEFAULT_CONFIG: dict[str, Any] = {
    # Beat-match: stretch clips (ffmpeg atempo, pitch-preserving) to a common
    # BPM so the whole mix rides one steady grid — the reference EDMPAPA mixes
    # hold ~129 BPM throughout. Clips >8% off stay native (render.py clamps).
    "no_time_stretch": False,
    "snap_to_downbeat": True,
    # Short, beat-snapped blend. Long crossfades overlap two off-tempo beat
    # grids (clips play at native BPM) and audibly clash; ~1 beat-bar of
    # overlap keeps the cut tight, EDMPAPA style.
    "crossfade_bars": 0.5,
    "loudness_lufs": -14,
    "use_stem_crossfade": False,
    "use_eq_bass_swap": False,
    "harmonic_pitch_shift_max_semitones": 0,
    "brand_overlay": True,
    "show_titles": True,
}


def _track_title(path: Path) -> str:
    meta = db.get_track_meta(analysis_mod.file_hash(path))
    if meta and meta.get("title"):
        return meta["title"]
    return youtube_mod.clean_title(path.stem)


def _automix_pipeline(req: schemas.AutomixRequest, progress) -> dict:
    """Sync pipeline run in a worker thread. Returns the render record."""
    # 1. Optional playlist import, mapped to 0-30%.
    if req.url:
        def dl_progress(stage: str, pct: float, msg: str = "") -> None:
            progress("download", min(30.0, pct * 0.30), msg)

        youtube_mod.import_playlist(req.url, IMPORTS_DIR, dl_progress, req.max_tracks)

    # 2. Determine source tracks.
    if req.track_ids:
        paths = [_resolve_track_path(tid) for tid in req.track_ids]
    else:
        paths = [
            p for p in sorted(IMPORTS_DIR.rglob("*.mp4"))
            if not p.name.startswith("automix_")
        ]
    if not paths:
        raise RuntimeError("no tracks found to mix")

    # 3. Analyze tracks missing cached analysis, mapped to 30-70%.
    n = len(paths)
    entries: list[tuple[str, dict]] = []
    for i, path in enumerate(paths):
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
        entries.append((fh, cached))
    progress("analysis", 70.0, f"Analysis ready for {len(entries)}/{n} tracks")

    # 4. Build clips: best-scoring drop per track, ordered by BPM ascending.
    clips: list[dict] = []
    # Transition style measured from the reference EDMPAPA mixes: each track
    # plays at full energy until just before the NEXT kick, then a short
    # "breath" (riser tail), then the drop slams in. The breath is exactly
    # 2 beats at the clip's own BPM: after time-stretching to the target BPM
    # it equals the 0.5-bar crossfade, so the incoming kick lands precisely on
    # the downbeat where the outgoing clip ends — beat-matched transitions.
    # The first clip keeps its full detected buildup as the mix intro.

    for fh, a in entries:
        drops = a.get("drops") or []
        if drops:
            best = max(drops, key=lambda d: float(d.get("score", 0.0)))
            start, end, kick = best.get("start_s"), best.get("end_s"), best.get("kick_s")
        else:
            start, end, kick = a.get("drop_start_s"), a.get("drop_end_s"), None
        if start is None or end is None or float(end) <= float(start):
            continue  # no usable drop in this track
        clips.append(
            {
                "track_id": fh[:16],
                "start_s": float(start),
                "end_s": float(end),
                "kick_s": float(kick) if kick is not None else None,
                "length_bars": 16,
                "_bpm": float(a.get("bpm", 0.0)),
            }
        )
    if not clips:
        raise RuntimeError("no usable drops found in any track")
    clips.sort(key=lambda c: c["_bpm"])
    for i, c in enumerate(clips):
        bpm = c.pop("_bpm")
        if i > 0 and c["kick_s"] is not None:
            breath = 2.0 * 60.0 / bpm if bpm > 0 else 1.0
            c["start_s"] = max(c["start_s"], c["kick_s"] - breath)

    # 5. Render, mapped to 70-100%.
    config = {**AUTOMIX_DEFAULT_CONFIG, **(req.config or {}), "clips": clips}

    def render_progress(stage: str, pct: float, msg: str = "") -> None:
        progress("render", min(99.5, 70.0 + pct * 0.30), msg)

    return render_mod.render_mix(config, _resolve_track_path, render_progress)


@app.post("/api/automix")
async def post_automix(req: schemas.AutomixRequest) -> dict:
    job_id = uuid.uuid4().hex
    progress = make_progress(job_id)

    async def _run():
        try:
            record = await asyncio.to_thread(_automix_pipeline, req, progress)
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "render",
                    "percent": 100.0,
                    "message": "Done",
                    "done": True,
                    "output_path": record["output_path"],
                    "render_id": record["id"],
                }
            )
        except Exception as e:
            hub.publish_sync(
                {
                    "job_id": job_id,
                    "stage": "render",
                    "percent": 100.0,
                    "message": f"error: {e}",
                    "done": True,
                }
            )

    asyncio.create_task(_run())
    return {"job_id": job_id}


@app.get("/api/renders")
async def get_renders() -> list[dict]:
    return await asyncio.to_thread(db.list_renders)


@app.post("/api/projects")
async def post_project(payload: schemas.ProjectCreate) -> dict:
    pid = uuid.uuid4().hex
    return await asyncio.to_thread(db.add_project, pid, payload.name, payload.config)


@app.get("/api/projects")
async def list_projects() -> list[dict]:
    return await asyncio.to_thread(db.list_projects)


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str) -> dict:
    p = await asyncio.to_thread(db.get_project, project_id)
    if not p:
        raise HTTPException(status_code=404, detail="project not found")
    return p


@app.get("/api/mixes")
async def list_mixes() -> list[dict]:
    """All rendered automix videos, newest first."""

    def _run() -> list[dict]:
        out = []
        for p in sorted(EXPORTS_DIR.glob("automix_*.mp4"), key=lambda x: x.stat().st_mtime, reverse=True):
            st = p.stat()
            out.append(
                {
                    "filename": p.name,
                    "path": f"videos/exports/{p.name}",
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
    p = EXPORTS_DIR / name
    if not p.exists():
        raise HTTPException(status_code=404, detail="file not found")
    return p


@app.delete("/api/mixes/{filename}")
async def delete_mix(filename: str) -> dict:
    p = _safe_video_file(filename, prefix="automix_")
    await asyncio.to_thread(p.unlink)
    return {"deleted": filename}


@app.delete("/api/tracks/{track_id}")
async def delete_track(track_id: str) -> dict:
    path = _resolve_track_path(track_id)
    if path.name.startswith("automix_"):
        raise HTTPException(status_code=400, detail="use /api/mixes to delete renders")
    await asyncio.to_thread(path.unlink)
    _TRACK_PATH_CACHE.pop(track_id, None)
    return {"deleted": path.name}


PREVIEW_CACHE_DIR = Path(__file__).parent / ".cache" / "previews"


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
    out = PREVIEW_CACHE_DIR / f"{fh}_{start:.2f}_{dur:.2f}.wav"

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
            "-acodec", "pcm_s16le", str(tmp),
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        tmp.rename(out)
        return out

    p = await asyncio.to_thread(_run)
    return FileResponse(p, media_type="audio/wav")


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
