<div align="center">

<img src="frontend/public/favicon.svg" width="72" alt="Automix">

# Automix

### Drop mixes, on autopilot.

Automix imports tracks from YouTube playlists or your own files, finds every drop,
and renders beat-matched, branded video mixes. Hours of editing become minutes.

[![Website](https://img.shields.io/badge/website-automix-863bff?style=flat-square)](https://nathanrodrigues2111.github.io/automix-site/)
[![Web app](https://img.shields.io/badge/web%20app-open-863bff?style=flat-square)](https://nathanrodrigues2111.github.io/automix-app/)
[![Download](https://img.shields.io/badge/download-latest%20release-863bff?style=flat-square)](https://github.com/nathanrodrigues2111/automix/releases/latest)

**[Website](https://nathanrodrigues2111.github.io/automix-site/)** ·
**[Open the app](https://nathanrodrigues2111.github.io/automix-app/)** ·
**[Download](https://github.com/nathanrodrigues2111/automix/releases/latest)**

</div>

---

```
Import          →   Detect            →   Arrange           →   Render
playlists,          BPM, key, drops       timeline, live        branded 1080p mix
your own files      by sub-bass energy    preview               + vertical Short
```

## Download

Self-contained desktop packages. Python, ffmpeg, yt-dlp and the UI are all bundled, nothing else to install. Library and renders live in `~/Automix`.

| Platform | File |
| --- | --- |
| 🪟 Windows x64 | `Automix-windows-x64-setup.exe` |
| 🍎 macOS (Apple Silicon) | `Automix-macos-arm64.dmg` |
| 🐧 Linux x64 | `Automix-linux-x64.tar.gz` |
| 🐧 Linux arm64 | `Automix-linux-arm64.tar.gz` |

Packages are unsigned for now: on Windows let SmartScreen through (Smart App Control must be off), on macOS right-click the app and choose Open the first time.

## The hard parts, handled

- **🎯 Real drop detection.** Candidates are scored on sub-bass energy under 150 Hz and validated against bass lift and kick periodicity, so vocal choruses and spoken intros never fool it. In DJ sets it finds one drop per song from the tracklist.
- **🥁 Kick-aligned seams.** Every crossfade measures the actual kick grid on both sides and nudges itself so the incoming kick lands exactly on the outgoing downbeat. Calibrated by ear to 0.04 beats of phase accuracy.
- **🎧 Live preview.** Equal-power crossfades in the browser with the video following along. What you hear is what renders.
- **🎬 Branded output.** Full-frame channel overlay, track titles in your own fonts, an intro animation timed to end exactly on the first kick, and a 10s outro reserved for YouTube end screens.
- **📱 Shorts, included.** Each render can also produce a 9:16 Short cut around the strongest drop, ready to upload.
- **📁 Projects.** Each mix lives in its own workspace with its own tracks and exports. Switch projects without mixing up libraries.
- **📥 Import anything.** Paste a YouTube playlist and pick tracks, click Add files, or just drag and drop videos onto the track list. Everything lands analyzed and ready to mix.
- **🔊 Consistent loudness.** Float pipeline end to end, every clip normalized to -14 LUFS, previews matched to exports. Hot festival masters never clip.
- **✅ Self-verifying renders.** Every export checks its own seam timing, loudness, true peak and on-screen titles, and saves a report next to the file.
- **✨ Polished app.** True-black dark mode, pickable accent color, boot splash, download quality picker in the header, GPU-accelerated rendering when available.

## Run from source

```bash
./scripts/setup.sh                                             # Linux / macOS
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1     # Windows
npm run dev                                                    # FastAPI :8000 + Vite :5173
```

Open <http://localhost:5173>, paste a playlist, hit Auto-Mix. See [`SETUP.md`](SETUP.md) for details, `npm run check-system` to verify dependencies.

<details>
<summary><b>Prerequisites and optional extras</b></summary>

- **Node 20+**, **Python 3.10 to 3.14** (or [`uv`](https://docs.astral.sh/uv/), preferred)
- **`ffmpeg` / `ffprobe`** on `PATH` (a static build works, no `drawtext` needed, titles burn via libass)
- **`yt-dlp`** on `PATH` for YouTube import
- Optional: `rubberband-cli` for BPM time-stretch modes
- Optional neural stack (~2-3 GB, better segmentation + stem-aware crossfades):
  `backend/.venv/bin/pip install -e "backend[ml]"`. Everything works without it via the librosa fallback.

</details>

<details>
<summary><b>How the pipeline works</b></summary>

- **Import.** `yt-dlp` grabs each entry at the best available quality (configurable cap), merges best video and audio, skips what you already have. Local files upload as-is (mp4) or get remuxed to mp4.
- **Analysis.** Drops via a bass-gated energy-jump detector snapped to downbeats, BPM with an octave-error fold for EDM ranges, key via Krumhansl-Schmuckler chroma matching, loudness via `ffmpeg loudnorm`. Results cache per file, re-runs are instant.
- **Auto-mix.** Picks the highest-confidence drop per track, orders clips by BPM and Camelot key, and aligns each crossfade so the incoming drop kicks exactly when the outgoing one ends.
- **Render.** Per-clip trim, float loudnorm to -14 LUFS, kick-aligned crossfades re-measured from the actual audio, matching video transitions, then the branding pass. H.264 CRF 17 + AAC 320k, plus the Short. The audio timeline is the single source of truth, so nothing drifts across a long mix.

</details>

<details>
<summary><b>Project layout</b></summary>

```
automix/
├── assets/        brand overlay + selectable title fonts (Bebas Neue default)
├── backend/       FastAPI: import, analysis, render, WebSocket progress
├── frontend/      Vite + React 19 + TypeScript + Tailwind v4
├── packaging/     PyInstaller spec + tool fetcher + Inno Setup script
├── scripts/       cross-platform helpers (setup, deploy, system check)
├── site/          landing page source (deployed to automix-site)
└── videos/        imports and rendered mixes (gitignored)
```

</details>

<details>
<summary><b>Packaging and deploy</b></summary>

- **Desktop packages**: `.github/workflows/release.yml` builds Windows x64, macOS arm64 and Linux x64 + arm64 on a per-OS matrix and attaches them to each published `v*` release. `app.py` is the launcher: it boots the backend and opens the UI in a native window.
- **Web app**: `scripts/deploy-pages.sh` publishes the built frontend to [automix-app](https://nathanrodrigues2111.github.io/automix-app/). It talks to your local backend, your library never leaves your machine.
- **Landing page**: `scripts/deploy-site.sh` publishes `site/` to [automix-site](https://nathanrodrigues2111.github.io/automix-site/).
- **Tests**: `npm test` runs pytest (drop-detection golden tests, title cleaning, crossfade timeline math).

</details>

---

<div align="center">
<sub>Built for the <b>EDMPAPA</b> YouTube channel · local-first · Windows, macOS and Linux</sub>
</div>
