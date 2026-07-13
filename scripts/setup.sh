#!/usr/bin/env bash
# =============================================================================
# Automix — one-shot dev environment bootstrap for Linux & macOS.
#
# Installs every prerequisite the project needs and then all project deps:
#   system tools : uv, python 3.12, node 20+, ffmpeg/ffprobe, yt-dlp
#   optional     : rubberband-cli (--with-rubberband), neural ML stack (--with-ml)
#   project deps : root npm (concurrently, rimraf), backend venv, frontend node_modules
#
# Safe to re-run: every step is idempotent and skips work already done.
#
# Usage:
#   ./scripts/setup.sh                 # everything required
#   ./scripts/setup.sh --with-rubberband --with-ml
#
# No sudo is used for uv / python / yt-dlp (they land in ~/.local). System
# packages (ffmpeg, node, rubberband) use your package manager and MAY prompt
# for sudo.
# =============================================================================
set -euo pipefail

# ---- pretty output ----------------------------------------------------------
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'; else B=; G=; Y=; R=; D=; N=; fi
step() { printf '\n%s==>%s %s%s%s\n' "$B" "$N" "$B" "$1" "$N"; }
ok()   { printf '%s  ✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '%s  !%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '%s  ✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

WITH_RUBBERBAND=0
WITH_ML=0
for arg in "$@"; do
  case "$arg" in
    --with-rubberband) WITH_RUBBERBAND=1 ;;
    --with-ml)         WITH_ML=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

# Run from the repo root regardless of where the script is invoked from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PYTHON_VERSION="3.12"   # backend requires >=3.10,<3.13 — pin a supported minor

# ---- detect platform / package manager --------------------------------------
OS="$(uname -s)"
PM=""            # package-manager command family
PM_INSTALL=""    # install invocation
case "$OS" in
  Darwin)
    PLATFORM="macOS"
    if have brew; then PM="brew"; PM_INSTALL="brew install"; fi
    ;;
  Linux)
    PLATFORM="Linux"
    if   have apt-get; then PM="apt";    PM_INSTALL="sudo apt-get install -y";  SUDO_UPDATE="sudo apt-get update";
    elif have dnf;     then PM="dnf";    PM_INSTALL="sudo dnf install -y";
    elif have pacman;  then PM="pacman"; PM_INSTALL="sudo pacman -S --noconfirm";
    elif have zypper;  then PM="zypper"; PM_INSTALL="sudo zypper install -y";
    fi
    ;;
  *) PLATFORM="$OS" ;;
esac

step "Automix setup — $PLATFORM${PM:+ (package manager: $PM)}"
[ -n "$PM" ] || warn "No supported package manager found; system packages (ffmpeg/node) may need manual install."

# pkg <friendly> <apt> <brew> <dnf> <pacman> <zypper>
pkg() {
  local name="$1" apt="$2" brew="$3" dnf="$4" pac="$5" zyp="$6" spec=""
  case "$PM" in
    apt)    spec="$apt" ;;
    brew)   spec="$brew" ;;
    dnf)    spec="$dnf" ;;
    pacman) spec="$pac" ;;
    zypper) spec="$zyp" ;;
    *) warn "Install '$name' manually (no known package manager)."; return 1 ;;
  esac
  [ -n "${SUDO_UPDATE:-}" ] && { $SUDO_UPDATE >/dev/null 2>&1 || true; SUDO_UPDATE=""; }
  echo "  ${D}\$ $PM_INSTALL $spec${N}"
  $PM_INSTALL $spec
}

# =============================================================================
# 1. uv — Python toolchain + venv manager (also fetches Python for us)
# =============================================================================
step "uv (Python manager)"
if have uv; then
  ok "uv already installed ($(uv --version))"
else
  warn "installing uv via the official installer (no sudo, lands in ~/.local/bin)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  # Make uv available in THIS shell without re-login.
  export PATH="$HOME/.local/bin:$PATH"
  have uv || die "uv install failed — see https://docs.astral.sh/uv/"
  ok "uv installed ($(uv --version))"
fi

# =============================================================================
# 2. Python (backend supports 3.10+; the venv step prefers your newest
#    installed Python, so this just guarantees a fallback exists via uv)
# =============================================================================
step "Python (fallback $PYTHON_VERSION via uv)"
uv python install "$PYTHON_VERSION"
ok "Python $PYTHON_VERSION available via uv (used only if no system Python 3.10+ is found)"

# =============================================================================
# 3. Node.js 20+ and npm — Volta preferred (this repo pins Node via its
#    "volta" field in package.json), OS package manager as a fallback.
# =============================================================================
step "Node.js 20+ (Volta preferred)"
node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }
node_ok() { have node && [ "$(node_major 2>/dev/null || echo 0)" -ge 20 ] 2>/dev/null; }

if node_ok && have volta; then
  ok "node $(node -v) already installed (via Volta)"
elif node_ok; then
  ok "node $(node -v) already installed"
else
  # No usable Node yet. Prefer Volta since the project pins its Node version there.
  if ! have volta; then
    warn "installing Volta (Node toolchain manager — what this project pins with)"
    curl https://get.volta.sh | bash -s -- --skip-setup || warn "Volta installer failed"
    export VOLTA_HOME="$HOME/.volta"; export PATH="$VOLTA_HOME/bin:$PATH"
    have volta && ok "Volta installed ($(volta --version))"
  fi
  if have volta; then
    # Installs a default toolchain so `node`/`npm` resolve everywhere; inside
    # the repo the "volta" pin in package.json takes precedence automatically.
    volta install node@20 || warn "'volta install node@20' failed"
  else
    # Last resort: the OS package manager.
    case "$PM" in
      brew)   pkg node node node@20 nodejs nodejs nodejs20 ;;
      apt)    warn "installing Node 20 from NodeSource"; curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs ;;
      dnf)    pkg node "" "" nodejs "" "" ;;
      pacman) pkg node "" "" "" nodejs "" ;;
      zypper) pkg node "" "" "" "" nodejs20 ;;
      *)      warn "Install Node 20+ manually (https://volta.sh or https://nodejs.org)." ;;
    esac
  fi
  node_ok && ok "node $(node -v)" || warn "Node 20+ still not on PATH — open a new shell (Volta needs it), then re-run."
fi

# =============================================================================
# 4. ffmpeg / ffprobe
# =============================================================================
step "ffmpeg / ffprobe"
if have ffmpeg && have ffprobe; then
  ok "ffmpeg present ($(ffmpeg -version | head -n1))"
else
  pkg ffmpeg ffmpeg ffmpeg ffmpeg ffmpeg ffmpeg || warn "Install ffmpeg manually (a static build in ~/.local/bin also works)."
  have ffmpeg && ok "ffmpeg installed" || warn "ffmpeg still missing."
fi

# =============================================================================
# 5. yt-dlp (installed as a uv tool so it lands on PATH globally)
# =============================================================================
step "yt-dlp"
if have yt-dlp; then
  ok "yt-dlp already on PATH ($(yt-dlp --version 2>/dev/null || echo present))"
else
  uv tool install yt-dlp
  ok "yt-dlp installed via uv tool"
fi

# =============================================================================
# 6. rubberband-cli (OPTIONAL — only for BPM stretch / pitch-shift modes)
# =============================================================================
if [ "$WITH_RUBBERBAND" -eq 1 ]; then
  step "rubberband-cli (optional)"
  if have rubberband; then ok "rubberband already installed"; else
    pkg rubberband rubberband-cli rubberband rubberband rubberband rubberband || warn "Install rubberband-cli manually."
  fi
else
  warn "Skipping rubberband-cli (optional). Pass --with-rubberband to install it."
fi

# =============================================================================
# 7. Project dependencies
# =============================================================================
step "Root dev tools (concurrently, rimraf)"
npm install

step "Backend venv + Python deps"
# Delegates to scripts/install-backend.mjs: it reuses an existing venv, picks
# the newest installed Python (>=3.10) or fetches $PYTHON_VERSION via uv, and
# installs the [dev] extra. Node is guaranteed present by this point.
npm run install:backend
if [ "$WITH_ML" -eq 1 ]; then
  step "Neural ML stack (allin1 + demucs + torch — several GB)"
  ( cd backend && uv pip install -e ".[ml]" )
fi

step "Frontend node_modules"
npm --prefix frontend install

# =============================================================================
# 8. Verify
# =============================================================================
step "System check"
node scripts/check-system.mjs || true

printf '\n%s✓ Setup complete.%s Start the app with:  %snpm run dev%s\n' "$G$B" "$N" "$B" "$N"
printf '   Backend → http://localhost:8000   Frontend → http://localhost:5173\n'
if ! have uv >/dev/null 2>&1 || [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  printf '\n%sNote:%s uv/yt-dlp live in ~/.local/bin. If a new terminal can'\''t find them, add this to your shell profile:\n' "$Y" "$N"
  printf '   export PATH="$HOME/.local/bin:$PATH"\n'
fi
