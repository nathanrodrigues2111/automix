<div align="center">

# 🎧 Automix

**Turn a YouTube playlist into one branded, beat-matched EDM drop-mashup video — in a single click.**

Automix downloads every track in a playlist, finds each song's drop, trims it, and stitches the drops into one seamless, kick-aligned mix rendered at 1080p or 4K with EDMPAPA-style branding. A full waveform editor is built in for when you want to hand-tune the cut.

[![Live demo](https://img.shields.io/badge/live%20demo-github%20pages-2563eb?style=flat-square)](https://nathanrodrigues2111.github.io/automix-app/)
![Platforms](https://img.shields.io/badge/runs%20on-Linux%20·%20macOS%20·%20Windows-16a34a?style=flat-square)
![Python](https://img.shields.io/badge/python-3.11+-3776ab?style=flat-square&logo=python&logoColor=white)
![Node](https://img.shields.io/badge/node-20+-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![React](https://img.shields.io/badge/react-19-61dafb?style=flat-square&logo=react&logoColor=white)
![FastAPI](https://img.shields.io/badge/fastapi-backend-009688?style=flat-square&logo=fastapi&logoColor=white)
![ffmpeg](https://img.shields.io/badge/ffmpeg-render-007808?style=flat-square&logo=ffmpeg&logoColor=white)

</div>

---

## Download

Prebuilt, self-contained desktop packages (Python, ffmpeg, yt-dlp, and the UI all bundled — nothing else to install) are published on the [**latest release**](https://github.com/nathanrodrigues2111/automix/releases/latest):

| Platform | File |
| --- | --- |
| 🪟 Windows x64 | `Automix-windows-x64-setup.exe` (installer) |
| 🍎 macOS (Apple Silicon) | `Automix-macos-arm64.dmg` |
| 🍎 macOS (Intel) | `Automix-macos-x64.dmg` |
| 🐧 Linux x64 | `Automix-linux-x64.tar.gz` |
| 🐧 Linux arm64 | `Automix-linux-arm64.tar.gz` |

Run it and Automix opens in its own window; your library and renders live in `~/Automix`. The builds are **unsigned**, so the first launch shows an "unknown developer" prompt (right-click Open on macOS; on Windows 11, Smart App Control must be off or the build signed). Prefer to run from source? See [Quick start](#quick-start).

## What it does

Paste a YouTube playlist (or a single video, or an hour-long DJ set) and Automix runs the whole pipeline live in your browser:

```
Download  →  Analyze  →  Auto-Mix  →  Render
 yt-dlp      drops+BPM    order+align   1080p/4K MP4 + Short
```

The finished video plays inline and lands in `videos/`. Prefer to build it by hand? Import a playlist into the library, loop each detected drop, drag the ones you like into the Mix Editor, reorder, and render.

Style reference for the output format: <https://www.youtube.com/watch?v=tb4eIN1VRbc>.

## Highlights

- **🎯 Smart drop detection** — a bass-gated energy-jump detector finds the real drop in every track (vocal choruses and spoken intros no longer fool it), snaps starts to the pre-kick breath, and ranks candidates by confidence. In DJ sets it detects one drop per song from the tracklist.
- **🎚️ Ear-tight transitions** — every seam measures the actual kick grid on both sides and nudges the crossfade so the incoming drop lands exactly on the outgoing track's final downbeat. Calibrated by ear to sub-0.04-beat phase accuracy.
- **🎨 EDMPAPA branding pass** — 1920×1080 canvas with black letterbox bars, logo, and the clean track title (default font Bebas Neue, or pick/upload your own) switching at each transition. Includes a blended intro animation and a 10s outro reserved for YouTube end screens.
- **📱 Vertical Shorts** — every render also produces a 9:16 Short of the first minute, with artist/track titles and a watch-the-full-video end card. Toggle it off in Settings.
- **✂️ Live waveform editor** — beat grid, drop markers, looping previews, drag-to-reorder clips, Camelot + BPM auto-ordering, and drop-length control (Auto or a forced 4/8/12/16 bars).
- **🔊 Clean, loud audio** — float pipeline end to end (hot festival masters never clip), loudness set by linear gain + a final limiter to −14 LUFS. Preview loudness matches export loudness.
- **📋 Tracklist paste** — paste a whole 1001tracklists page as-is; song numbers, vote counts, and uploader junk are stripped and each drop is labeled with its song name.
- **✅ Self-verifying renders** — every export checks its own seam kick timing, loudness, true peak, and on-screen titles, and saves a report next to the file.
- **🌗 Polished UI** — AMOLED true-black dark mode + light mode, pickable accent color, mobile layout, live in-browser preview that simulates the intro, branding, titles, and outro.

## Runs everywhere

Automix is a local-first app — everything runs on **your** machine, nothing is uploaded. All tooling scripts are cross-platform and tested on **Linux, macOS, and Windows**:

| Platform | Status | Notes |
| --- | --- | --- |
| 🐧 **Linux** | ✅ Supported | Primary dev target; a static ffmpeg build in `~/.local/bin` works fine. |
| 🍎 **macOS** | ✅ Supported | `brew install ffmpeg yt-dlp uv` covers the prerequisites. |
| 🪟 **Windows** | ✅ Supported | Node scripts are cross-platform; install ffmpeg/yt-dlp on `PATH` (winget or scoop). |

Run `npm run check-system` on any OS to verify every dependency is on `PATH`.

## Prerequisites

- **Node 20+**
- **Python 3.11+** (or [`uv`](https://docs.astral.sh/uv/) — preferred; the installer uses it automatically when present)
- **`ffmpeg` / `ffprobe`** on `PATH` (a [static build](https://johnvansickle.com/ffmpeg/) works fine; no `drawtext` required — titles burn via libass)
- **`yt-dlp`** on `PATH` (for YouTube import)
- *Optional:* `rubberband-cli` — only for BPM time-stretch / pitch-shift modes (the default drops-only mode doesn't use it)
- *Optional:* NVIDIA GPU + the `[ml]` extra (`allin1`/`demucs`) for neural structure analysis and stem-aware crossfades — everything works without it via the built-in librosa fallback ("lite analysis mode")

## Quick start

```bash
npm install            # root dev tools (concurrently, rimraf)
npm run install:all    # creates backend/.venv + Python deps, installs frontend node_modules
npm run dev            # starts FastAPI (:8000) and Vite (:5173) in parallel
```

Open <http://localhost:5173>, paste a YouTube playlist or video URL into the **Auto-Mix** panel, and hit **Auto-Mix**. Progress streams live through Download → Analyze → Render.

Enable the optional neural stack (better segmentation + stem-aware crossfades, ~2–3 GB):

```bash
backend/.venv/bin/pip install -e "backend[ml]"
```

Other scripts: `npm test`, `npm run lint`, `npm run clean`, `npm run check-system`. All are cross-platform.

## How it works

- **Import** — `yt-dlp` downloads each playlist entry at the highest available resolution (4K+), merging the best video and audio streams, skips already-downloaded videos, and stores a cleaned display title keyed by file hash in SQLite. A quality cap (Best / 4K / 2K / 1080p / 720p) is configurable in Settings.
- **Analysis** — with the `[ml]` extra, `allin1` labels segments and `demucs` separates stems to pin the exact drop frame. Without it, a librosa bass-gated energy-jump detector finds drop moments, snapped to downbeats, with an octave-error fold for EDM BPM ranges. Key (Camelot) via Krumhansl-Schmuckler chroma matching; loudness via `ffmpeg loudnorm`. Results cache per file hash, so re-runs are instant.
- **Auto-mix** — picks the highest-confidence drop per track, orders clips by ascending BPM, and aligns each crossfade so the outgoing drop ends exactly when the incoming drop kicks.
- **Render** — per-clip trim → optional rubberband stretch → float loudnorm to −14 LUFS → kick-aligned crossfades (each seam re-measured from the actual audio) → matching video transitions → mux → **branding pass** (bars, logo, per-clip titles via libass, timed to the incoming kick) → H.264 CRF 17 + AAC 320k, plus a 9:16 Short.

> The **audio timeline is the single source of truth**: video crossfade offsets and title windows are computed from exact audio clip lengths, so nothing drifts across a long mix.

## Project layout

```
automix/
├── assets/                 edmpapa11.png overlay + selectable title fonts (Bebas Neue default)
├── backend/                FastAPI app — import, analysis, render, WebSocket progress
│   ├── main.py             endpoints incl. /api/youtube/import and /api/automix
│   ├── youtube.py          yt-dlp playlist import + title cleaning
│   ├── analysis.py         allin1/demucs (optional) + librosa drop detection
│   ├── render.py           ffmpeg trim, kick-aligned crossfade, concat, branding overlay
│   ├── ordering.py         Camelot + BPM auto-ordering
│   ├── db.py               SQLite cache (analyses, track meta, renders, projects)
│   └── tests/              detection + title/window unit tests
├── frontend/               Vite + React 19 + TypeScript + Tailwind v4
│   └── src/components/      AutomixPanel, TrackList, Timeline, VideoPreview, MixEditor, SettingsDialog
├── scripts/                cross-platform Node helpers (install, venv runner, system check)
├── videos/                 downloaded source MP4s + rendered automix_*.mp4 outputs
├── API_CONTRACT.md         HTTP + WebSocket contract between frontend and backend
└── README.md
```

## Configuration

- **Source videos** — paste a playlist/video URL, or drop `.mp4` files into `videos/` manually (`GET /api/tracks` scans on demand).
- **Rendered output** — `videos/automix_<name>_<timestamp>.mp4` (1080p/4K H.264 CRF 17, AAC 320k) plus a vertical Short.
- **Branding** — replace `assets/edmpapa11.png` and drop a TTF/OTF into the title-font picker to re-skin; toggle overlay, titles, intro, outro, and Shorts per render in Settings. See `API_CONTRACT.md` for exact request shapes.

## Desktop app (one-file package)

Automix can also ship as a single self-contained download per OS: the Python
backend, the built UI, and static `ffmpeg`/`yt-dlp` are all bundled, so users
run one file with nothing else installed. The launcher (`app.py`) boots the
backend and opens the UI in a native window, writing the library and renders to
`~/Automix`.

`.github/workflows/release.yml` builds the packages on a per-OS matrix
(Windows x64, macOS arm64 + x64, Linux x64 + arm64) and attaches them to a
`v*` release. Trigger it manually from the Actions tab (Run workflow) to test a
build without cutting a tag. Local build:

```bash
cd frontend && npm ci && npm run build && cd ..
pip install ./backend pyinstaller pywebview
python packaging/fetch_tools.py       # downloads ffmpeg/ffprobe/yt-dlp into bin/
pyinstaller --noconfirm packaging/automix.spec
```

Output lands in `dist/` (`Automix.app` on macOS, an `Automix/` folder elsewhere).
The heavy neural `[ml]` stack is intentionally excluded to keep the package lean.

## Deploy

The hosted UI at <https://nathanrodrigues2111.github.io/automix-app/> is the built frontend only — it talks to *your* local backend (browsers exempt localhost from mixed-content rules). `scripts/deploy-pages.sh` builds and publishes the public app repo. The source stays private.

## Tests

```bash
npm test
```

Runs `pytest`: drop-detection golden tests (skipped without cached model data), `clean_title` cases, and the title-window / crossfade timeline math.

---

<div align="center">
<sub>Built for the <b>EDMPAPA</b> YouTube channel · local-first · runs on Linux, macOS &amp; Windows</sub>
</div>
