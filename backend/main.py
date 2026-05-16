from __future__ import annotations

import asyncio
import json
import re
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import analysis as analysis_mod
from . import db
from . import models_setup
from . import render as render_mod
from . import schemas

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
WAVEFORM_CACHE_DIR = BACKEND_DIR / ".cache" / "waveforms"

VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
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
    VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
    WAVEFORM_CACHE_DIR.mkdir(parents=True, exist_ok=True)


# ---------- Track scanning ----------

def _scan_tracks() -> list[dict]:
    if not VIDEOS_DIR.exists():
        return []
    tracks: list[dict] = []
    for path in sorted(VIDEOS_DIR.rglob("*.mp4")):
        try:
            basic = analysis_mod.probe_basic(path)
        except Exception:
            continue
        fh = analysis_mod.file_hash(path)
        tid = fh[:16]
        cached = db.get_analysis(fh)
        rel = str(path.relative_to(PROJECT_ROOT))
        tracks.append(
            {
                "id": tid,
                "filename": path.name,
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
    for path in VIDEOS_DIR.rglob("*.mp4"):
        if analysis_mod.file_hash(path)[:16] == track_id:
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

    expected_ts = "pending"
    expected_path = f"videos/automix_<ts>.mp4"

    async def _run():
        try:
            progress("render", 1.0, "Starting render")
            await asyncio.to_thread(
                render_mod.render_mix, config, _resolve_track_path, progress
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
    return {"job_id": job_id, "output_path": expected_path}


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


@app.get("/api/models/status")
async def models_status() -> dict:
    return await asyncio.to_thread(models_setup.get_status)


@app.post("/api/models/download")
async def models_download() -> dict:
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
