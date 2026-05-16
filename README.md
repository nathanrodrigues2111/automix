# Automix — Local EDM Auto-Mixer

Local-only web tool that scans a folder of EDM MP4s, auto-detects the first drop in each track using `allin1` (neural music structure analysis) plus `demucs` (stem separation), and stitches trimmed drops into a single seamless MP4 mashup. A web editor exposes a waveform timeline, video preview, and draggable trim markers so the auto-detected cuts can be nudged before rendering. Style reference: <https://www.youtube.com/watch?v=tb4eIN1VRbc>.

## Prerequisites

- Python 3.11
- Node 20+
- `ffmpeg`
- `rubberband-cli` (used by `pyrubberband` for time-stretching)
- Optional: NVIDIA GPU with CUDA — analysis runs ~10-20x faster than CPU

Run `make check-system` to verify everything is on `PATH`.

## Quick start

```bash
make install   # creates backend/.venv, installs Python deps, installs frontend node_modules
make dev       # starts FastAPI (:8000) and Vite (:5173) in parallel
```

Then open <http://localhost:5173>.

First run will trigger a one-time download of the `allin1` and `demucs` model weights (~2 GB total). The UI surfaces the download progress.

## How it works

- `allin1` labels each track's segments (intro / verse / chorus / bridge / outro); the first `chorus` segment is the coarse drop window.
- `demucs` separates the track into `drums`, `bass`, `vocals`, `other`. The onset of the drums stem near the chorus boundary pins the exact drop frame, snapped to the nearest downbeat.
- `librosa` estimates the musical key (Camelot wheel) and `ffmpeg loudnorm` measures EBU R128 loudness — both used for harmonic ordering and consistent levels in the render.
- The render pipeline trims each clip from its drop, time-stretches with `rubberband` to a target BPM, loudness-normalizes to -14 LUFS, and crossfades stem-aware (drums/bass fade independently of vocals/other) before concatenating to a single H.264 MP4.
- Analysis results are cached in SQLite per file hash, so re-opening a track is instant.

## Project layout

```
automix/
├── backend/                FastAPI app — analysis, render, WebSocket progress
│   ├── main.py
│   ├── analysis.py         allin1 + demucs + librosa drop detection
│   ├── render.py           ffmpeg trim, time-stretch, loudnorm, crossfade, concat
│   ├── ordering.py         Camelot + BPM auto-ordering
│   ├── db.py               SQLite cache
│   ├── schemas.py
│   ├── tests/              golden_truth.json + test_detection.py
│   └── pyproject.toml
├── frontend/               Vite + React 19 + TypeScript + Tailwind v4
│   ├── src/
│   │   ├── components/     TrackList, Timeline (wavesurfer), VideoPreview, MixEditor, RenderDialog
│   │   ├── hooks/useWebSocket.ts
│   │   └── api/client.ts
│   └── package.json
├── videos/                 source MP4s + rendered output mashups
├── scripts/check-system.sh
├── Makefile
├── API_CONTRACT.md         HTTP + WebSocket contract between frontend and backend
└── README.md
```

## Configuration

- **Source videos**: drop new `.mp4` files into `videos/`. `GET /api/tracks` scans the folder on demand — refresh the UI to pick them up.
- **Rendered output**: written to `videos/automix_<timestamp>.mp4`.
- **Target BPM, clip length (bars), crossfade length (bars), loudness target (LUFS), stem-aware crossfade toggle, max harmonic pitch-shift**: all tuned from the MixEditor panel in the UI. See `API_CONTRACT.md` for the exact shapes accepted by `POST /api/render`.

## Tests

```bash
make test
```

Runs `pytest` against `backend/tests/test_detection.py`, which asserts the detector lands within ±0.5s of the human-labeled `golden_truth.json` for the three sample tracks, BPM within ±1, and the Camelot key matches.
