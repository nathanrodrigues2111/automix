# Automix — Setup Guide

Everything you need to run Automix from source on **Linux, macOS, or Windows**.
There is one bootstrap script per platform that installs every dependency for
you. If you'd rather do it by hand, the manual steps are at the bottom.

---

## TL;DR — one command

The script installs the system tools it can (uv, Python 3.12, Node via Volta,
ffmpeg, yt-dlp) and then all project dependencies. It is **safe to re-run** —
every step skips work that's already done.

### Linux / macOS

```bash
git clone https://github.com/nathanrodrigues2111/automix.git
cd automix
./scripts/setup.sh
```

### Windows (PowerShell)

```powershell
git clone https://github.com/nathanrodrigues2111/automix.git
cd automix
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

### Already have Node? Then just:

```bash
npm run setup          # dispatches to the right script for your OS
```

`npm run setup` needs Node already installed (it *is* a Node script). On a
brand-new machine with no Node, run the platform script directly (above) — it
installs Node for you via Volta.

Optional extras (either script):

```bash
./scripts/setup.sh --with-rubberband    # BPM stretch / pitch-shift support
./scripts/setup.sh --with-ml            # neural analysis stack (torch, ~2-3 GB)
```
```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -WithRubberband -WithMl
```

When it finishes:

```bash
npm run dev            # backend :8000 + frontend :5173
```

Open <http://localhost:5173>.

---

## What gets installed

| Dependency | What for | How the script installs it |
| --- | --- | --- |
| **uv** | Python toolchain + venv manager; also fetches Python | official installer (per-user, no sudo/admin) |
| **Python 3.10+** | backend runtime (FastAPI, librosa, etc.) | uses your newest installed Python (3.10–3.14 all work), else fetches 3.12 via uv |
| **Node.js 20+** + npm | build tooling + frontend | **Volta** (preferred), else your OS package manager |
| **ffmpeg / ffprobe** | all audio/video rendering | apt / dnf / pacman / brew / **winget / choco / scoop** |
| **yt-dlp** | YouTube playlist/video import | `uv tool install yt-dlp` (also bundled in the backend venv) |
| **concurrently, rimraf** | root dev scripts (`npm run dev`, `clean`) | `npm install` |
| Backend Python deps | FastAPI, librosa, soundfile, pydantic, … + `[dev]` (pytest) | `uv pip install -e ".[dev]"` into `backend/.venv` |
| Frontend deps | React 19, Vite, Tailwind, … | `npm --prefix frontend install` |
| *rubberband* *(optional)* | BPM time-stretch / pitch-shift modes only | `--with-rubberband` |
| *ML stack* *(optional)* | neural drop analysis (allin1 + demucs + torch) | `--with-ml` |

### Node is managed by Volta

This repo **pins its Node/npm version** in `package.json` under the `volta`
field, so everyone gets the same toolchain:

```json
"volta": { "node": "24.18.0", "npm": "11.16.0" }
```

If you have [Volta](https://volta.sh) installed, it auto-selects that exact
version whenever you `cd` into the repo — nothing to do. The setup scripts
install Volta for you if it's missing and you don't already have a usable Node.

### Which Python versions are supported?

**3.10 through 3.14** (`requires-python = ">=3.10"` in `backend/pyproject.toml`).
The setup uses your newest installed Python; if you have none, uv fetches 3.12.

Older revisions capped this at `<3.13` because of a `numpy<2.0` pin (numpy 1.26
ships no wheels for Python 3.13+). That pin is now lifted to `numpy>=1.26`, which
resolves to numpy 2.x on modern Pythons. The full backend test suite and the
drop-detection DSP path both pass on Python 3.14 + numpy 2.x.

Two caveats:
- The optional **`[ml]` extra** (`torch`/`demucs`/`allin1`) may still pull numpy
  back to 1.26 on older Pythons and is only lightly tested on 3.13/3.14; it stays
  opt-in and is excluded from packaged builds.
- Whichever Python you use, it's isolated in `backend/.venv` — your system Python
  is never modified.

---

## Per-platform prerequisites (if installing manually)

You only need these if you skip the setup script. The scripts handle all of it.

| Platform | System package manager the script uses | Notes |
| --- | --- | --- |
| 🐧 **Debian/Ubuntu** | `apt-get` | Node via NodeSource if Volta isn't used |
| 🐧 **Fedora** | `dnf` | |
| 🐧 **Arch** | `pacman` | |
| 🐧 **openSUSE** | `zypper` | |
| 🍎 **macOS** | `brew` | `brew install ffmpeg` etc. |
| 🪟 **Windows** | `winget` → `choco` → `scoop` (first found) | Chocolatey fully supported; if you already use `choco install ffmpeg`, the script detects it and skips |

### Manual steps

```bash
# 1. uv  (Linux/macOS)
curl -LsSf https://astral.sh/uv/install.sh | sh
#    uv  (Windows PowerShell)
#    irm https://astral.sh/uv/install.ps1 | iex

# 2. Python + Node + media tools
uv python install 3.12
# Node: install Volta (https://volta.sh), then `volta install node@20`
# ffmpeg: brew install ffmpeg  |  sudo apt-get install -y ffmpeg  |  winget install Gyan.FFmpeg  |  choco install ffmpeg -y
uv tool install yt-dlp

# 3. Project deps
npm install                                              # root: concurrently, rimraf
cd backend && uv venv .venv --python 3.12 --seed \
  && uv pip install -e ".[dev]" && cd ..                 # backend venv + Python deps
npm --prefix frontend install                            # frontend
```

(`npm run install:all` does the backend+frontend halves too; it uses your
newest installed Python — or fetches 3.12 via uv if none — and installs the
`[dev]` extra automatically.)

---

## Verify your setup

```bash
npm run check-system     # confirms every tool is present, with install hints
```

`○` marks optional tools (yt-dlp global copy, rubberband) — those never fail the
check.

---

## Everyday scripts

| Command | Does |
| --- | --- |
| `npm run setup` | Install/repair the whole dev environment (this guide) |
| `npm run dev` | Start backend (:8000) + frontend (:5173) together |
| `npm run install:all` | Reinstall backend venv + frontend deps |
| `npm test` | Backend pytest suite |
| `npm run lint` | ruff (backend) + eslint (frontend) |
| `npm run check-system` | Verify system tools are on PATH |
| `npm run clean` | Remove venv, caches, node_modules, build output |

---

## Troubleshooting

- **"Node 20+ still not on PATH" after install** — Volta modifies PATH; open a
  new terminal and re-run, or run `volta install node@20` yourself.
- **`uv`/`yt-dlp` not found in a new terminal (Linux/macOS)** — add
  `export PATH="$HOME/.local/bin:$PATH"` to your shell profile.
- **numpy build error on install** — you're on a Python with no matching numpy
  wheel and no C compiler. Update the backend deps (`cd backend && uv lock`) or
  let uv build the venv on 3.12 (delete `backend/.venv` and re-run setup).
- **Windows: script won't run (execution policy)** — invoke it as
  `powershell -ExecutionPolicy Bypass -File scripts\setup.ps1`.
- **ffmpeg installed but not detected** — open a new terminal so PATH refreshes,
  then `npm run check-system`.
