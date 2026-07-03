# Automix — Local EDM Auto-Mixer

Local-only web tool that turns a **YouTube playlist URL into a single branded drop-mashup video** in one click: it downloads every track (yt-dlp, highest-quality H.264 MP4), detects each track's drops, trims them, stitches them into one seamless mix, and renders a 1080p MP4 with EDMPAPA-style branding — black letterbox bars, logo top-right, and the clean track title bottom-center in the Cubano font, switching at every transition.

A web editor is also included for hand-tuning: waveform timeline with beat grid and drop markers, looping drop previews (Vidstack player), drag-to-reorder clips, and Camelot auto-ordering. Style reference: <https://www.youtube.com/watch?v=tb4eIN1VRbc>.

## Prerequisites

- Node 20+
- Python 3.11+ (or [`uv`](https://docs.astral.sh/uv/) — preferred; the installer uses it automatically when present)
- `ffmpeg` / `ffprobe` on PATH (a [static build](https://johnvansickle.com/ffmpeg/) in `~/.local/bin` works fine)
- Optional: `rubberband-cli` — only needed for BPM time-stretch / pitch-shift modes (the default drops-only mode doesn't use it)
- Optional: NVIDIA GPU + the `[ml]` extra (allin1/demucs) for neural structure analysis and stem-aware crossfades — everything works without it via the built-in librosa fallback ("lite analysis mode")

Run `npm run check-system` to verify everything is on `PATH`.

## Quick start

```bash
npm install            # installs root dev tools (concurrently, rimraf)
npm run install:all    # creates backend/.venv + Python deps, installs frontend node_modules
npm run dev            # starts FastAPI (:8000) and Vite (:5173) in parallel
```

Then open <http://localhost:5173>, paste a YouTube playlist (or single video) URL into the **Auto-Mix** panel and hit **Auto-Mix**. Progress streams live through Download → Analyze → Render; the finished video plays inline and lands in `videos/automix_<timestamp>.mp4`.

Prefer to hand-tune? Use **Import only** to just download the playlist into the library, preview/loop each detected drop, add the ones you like to the Mix Editor, reorder, and hit Render.

Other useful scripts: `npm test`, `npm run lint`, `npm run clean`. All scripts are cross-platform (Linux / macOS / Windows).

To enable the optional neural stack (better segmentation + stem-aware crossfades, ~2-3 GB):

```bash
backend/.venv/bin/pip install -e "backend[ml]"
```

## How it works

- **Import** — `yt-dlp` downloads each playlist entry as highest-quality H.264 MP4 + AAC, skips already-downloaded videos, and stores a cleaned display title (junk like "(Official Video)" stripped, "feat./remix" kept) keyed by file hash in SQLite.
- **Analysis** — with the `[ml]` extra, `allin1` labels segments and `demucs` separates stems to pin the exact drop frame. Without it, a librosa energy-jump detector finds drop moments (quiet buildup → sudden loud), snapped to downbeats, with an octave-error fold for EDM BPM ranges. Key (Camelot) via Krumhansl-Schmuckler chroma matching; loudness via `ffmpeg loudnorm`.
- **Auto-mix** — picks the best-scoring drop per track, orders clips by ascending BPM, and aligns each crossfade so the outgoing drop ends exactly when the incoming drop kicks.
- **Render** — per-clip trim → (optional) rubberband time-stretch/pitch-shift → two-pass loudnorm to −14 LUFS → equal-power / stem-aware audio crossfades → matching video xfades → mux → **branding pass** (1920×1080 canvas, black bars, `assets/edmpapa11.png` logo, per-clip titles in `assets/Cubano.ttf` rendered via libass, timed to switch at crossfade midpoints) → H.264 CRF 17 + AAC 320k.
- Analysis results are cached in SQLite per file hash, so re-runs are instant.

## Project layout

```
automix/
├── assets/                 edmpapa11.png overlay + Cubano.ttf title font
├── backend/                FastAPI app — import, analysis, render, WebSocket progress
│   ├── main.py             endpoints incl. /api/youtube/import and /api/automix
│   ├── youtube.py          yt-dlp playlist import + title cleaning
│   ├── analysis.py         allin1/demucs (optional) + librosa drop detection
│   ├── render.py           ffmpeg trim, crossfade, concat, branding overlay
│   ├── ordering.py         Camelot + BPM auto-ordering
│   ├── db.py               SQLite cache (analyses, track meta, renders, projects)
│   ├── schemas.py
│   ├── tests/              detection + title/window unit tests
│   └── pyproject.toml      lean core deps; heavy neural stack behind [ml] extra
├── frontend/               Vite + React 19 + TypeScript + Tailwind v4
│   └── src/components/     AutomixPanel, TrackList, Timeline, VideoPreview (Vidstack),
│                           MixEditor, SettingsDialog (right sheet), RenderDialog
├── videos/                 downloaded source MP4s + rendered automix_*.mp4 outputs
├── scripts/                cross-platform Node helpers (install, venv runner, system check)
├── API_CONTRACT.md         HTTP + WebSocket contract between frontend and backend
└── README.md
```

## UI notes

- **Themes**: AMOLED true-black dark mode and light mode, System/Light/Dark toggle in the header, persisted.
- **Settings**: gear icon → right-side sheet (target BPM, crossfade, loudness, stem crossfade, branding + title toggles, preview looping). Persisted to localStorage.
- **Mobile**: Auto-Mix–first layout; the track library slides in as a left drawer so the preview stays visible.
- **Drop previews loop** by default until you pause — toggle in the preview header or Settings.

## Configuration

- **Source videos**: paste a playlist URL, or drop `.mp4` files into `videos/` manually — `GET /api/tracks` scans on demand.
- **Rendered output**: `videos/automix_<timestamp>.mp4` (1080p H.264 CRF 17, AAC 320k).
- **Branding**: replace `assets/edmpapa11.png` / `assets/Cubano.ttf` to re-skin; toggle overlay and titles per render in Settings. See `API_CONTRACT.md` for the exact request shapes.

## Tests

```bash
npm test
```

Runs `pytest`: drop-detection golden tests (skipped without cached model data), `clean_title` cases, and the title-window/crossfade timeline math.
