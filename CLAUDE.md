# Automix — project knowledge for Claude Code

EDM drop-mix builder for the EDMPAPA YouTube channel: imports tracks from
YouTube playlists, detects drops, and renders branded beat-matched video
mixes. Owner: Nathan Rodrigues.

## Running it

- Backend: FastAPI on :8000 (`backend/`, run with `uv run uvicorn main:app --reload` from `backend/`). Usually already running with hot reload.
- Frontend: Vite dev server on :5173 (`frontend/`, `npm run dev`), proxies `/api`, `/videos`, `/ws` to :8000. Usually already running.
- Environment: no sudo. ffmpeg / yt-dlp / uv live in `~/.local/bin`. Lite analysis mode (no torch; allin1/demucs not installed — librosa fallback everywhere). This ffmpeg build has NO drawtext; titles are burned with libass (`ass` filter + `fontsdir=assets`).
- Backend tests: `cd backend && uv run pytest tests/ -q`. The golden-truth detection tests skip when videos are missing.

## Layout

- `videos/imports/` downloaded source tracks; `videos/exports/` rendered `automix_*.mp4`. Whole `videos/` is gitignored.
- `backend/.cache/`: `wavs/` (analysis WAVs keyed by file hash), `stems/`, `waveforms/`, `previews/` (live-preview clip WAVs, suffix `_n14` = loudnorm -14), `renders/` (temp workdirs).
- `assets/`: `Bebas-Regular.ttf` (title font, family name "Bebas", caps-only), `edmpapa11.png` (FULL-FRAME 1920x1080 brand overlay: opaque bars + wordmark, transparent middle, composited 1:1), `black-bars.png` (bars only, shown during the intro), `into.avi` (intro animation, 3.0s, 4096x2304 BGRA raw, **2.7GB, gitignored** — web transcode lives at `frontend/public/intro.mp4`).
- **CRITICAL**: `analysis.file_hash()` is PATH-based (path+size). Moving a video file orphans its analysis/titles. `db.rekey_file_hash()` + the startup migration in `main.py` handle known moves — re-key rather than re-analyze.

## Audio pipeline (the hard-won parts)

- Drop detection (`analysis.find_drops`, `DROPS_VERSION = 5`; bump it to force library-wide re-scan via the lazy backfill in `_scan_tracks`):
  - Candidates scored on LOW-BAND (≤150 Hz) energy jumps; full-band only breaks ties. Vocal choruses / spoken intros spike full-band but not sub-bass.
  - Validation gates per drop body: bass_frac ≥ 0.18, bass_lift ≥ 1.15, kick periodicity boosts score.
  - `kick_s` refined to the drop body's first kick attack; clip end snaps to the LAST real kick + measured period (empirical local grid, up to 4 bars back).
  - `kick_period_s`: sub-frame (parabolic) least-squares fitted kick period. The renderer prefers 60/kick_period_s over the global BPM estimate (which is ~1% off and causes audible drift across blends).
- Transitions (renderer, `render.py`):
  - Every kick-anchored clip is normalized to a 2-bar pre-kick lead-in (carries the vocal/riser build); crossfade spans the lead-in so the incoming kick lands exactly on the outgoing clip's final downbeat.
  - `_kick_align_crossfade`: per-seam, measures the outgoing wav's actual kick grid and the incoming clip's first kick (sub-frame peaks) and nudges the crossfade modulo one period. This cancels ALL upstream bias. Prints `[align]` diagnostics.
  - Crossfade curves: outgoing cos^1.6 × 0.75 (fast decay so the incoming vocal reads), incoming sin^0.85.
  - Quality calibration (user-validated by ear): seam phase error ≤ 0.04 beats = "perfect", ~0.08 acceptable, 0.15+ audibly off. Verify with the phase method in the memory file `transition-quality-calibration`.
- The AUDIO timeline is the single source of truth: video xfade offsets and title windows are computed from exact audio clip lengths (video re-encodes quantize to frames and drift). atempo output is pinned to exact expected sample length. Titles switch at the crossfade END (= the incoming kick).
- Loudness: every clip loudnorms to `loudness_lufs` (-14 default), two-pass full / single-pass proxy. Preview clips served by `/api/tracks/{id}/clip` are also normalized to -14 so preview == export loudness.
- Intro/outro: intro overlay screen-blended, timed to END on the first drop's kick (first clip's lead-in auto-extends to fit); during the intro only black bars show (no wordmark, no title) — everything pops in at the kick. Outro: 10s black+silence appended by concat-copy for YouTube end screens (end screens occupy the last 5–20s).
- Render record carries `seam_times` and `crossfades` for verification.

## Frontend architecture notes

- Live preview (`hooks/useLivePreview.ts`): Web Audio graph of clip segments with equal-power crossfades; the MAIN video player doubles as program monitor (muted, rAF-synced to the audio clock, switching tracks per clip) with the brand overlay/titles/intro/outro simulated in `VideoPreview`. Muted players don't claim audio focus. Preview clips play at native BPM (no in-browser stretch) — the only intended preview/render difference.
- **NEVER put the vidstack MediaPlayerInstance in React state** — its getters throw when enumerated and crash React 19 dev render-logging (breaks ALL state updates). Keep it in refs, pass getters.
- WaveSurfer v7 renders in a shadow DOM: Tailwind classes do nothing inside it. Timeline trim handles live OUTSIDE in normal DOM with pixel math from scroll/zoom geometry. Timeline owns its own scrolling (`autoScroll: false`).
- Audio focus bus (`lib/audioFocus.ts`): exclusive playback + global spacebar via `registerPlayer`.
- `lib/backend.ts`: all API/media/WS URLs go through `apiUrl()/wsUrl()`. Same-origin locally; defaults to `http://localhost:8000` on hosted origins. User-overridable in Settings → Connection (localStorage `automix.backend.v1`).
- Changelog: `src/changelog.ts` (version per entry; `APP_VERSION` = newest). Add an entry + bump version for notable releases.
- Settings persisted under `automix.settings.v3` — bump the key when changing defaults that stored configs would pin.

## Hosting / deploy

- Source repo (`nathanrodrigues2111/automix`) is PRIVATE and must stay private.
- The BUILT frontend only is public: `scripts/deploy-pages.sh` builds with `--base=/automix-app/` and force-pushes dist to the public `nathanrodrigues2111/automix-app` repo → GitHub Pages at https://nathanrodrigues2111.github.io/automix-app/ (free plan requires the public repo; that's why the split exists).
- The hosted page talks to the user's local backend (browsers exempt localhost from mixed-content). Backend CORS allows `*.github.io` / `*.pages.dev`.
- Public assets referenced in code must use `import.meta.env.BASE_URL` (Pages serves under a subpath).

## Working conventions (user preferences)

- NO em-dashes in user-visible UI text; plain natural sentences. Consistent spacing scales in UI (labels 12px from controls).
- Verify in the real browser (Playwright MCP) — but the user often actively uses the same browser; check before driving it, don't fight their session.
- Verify audio work by rendering proxy mixes and measuring (kick phase, LUFS, frame luma) — iterate until measurably right; the user's ear matches the phase metric.
- Frontend checks: `cd frontend && npx tsc --noEmit && npx vite build`. tsc alone has missed missing-import runtime crashes; prefer both.
- Commits: user says "commit pull push"; conventional summary title + bullet body; end with the Claude co-author line. Never commit `videos/`, `.playwright-mcp/`, or `assets/*.avi` (2.7GB).
- The user queues rapid follow-up asks mid-task; fold them in without dropping the current thread.
