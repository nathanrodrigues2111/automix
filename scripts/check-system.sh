#!/usr/bin/env bash
# check-system.sh — verify required CLI tools are present.
# Exits non-zero if any required tool is missing.

set -u

OK="\033[32m✓\033[0m"
BAD="\033[31m✗\033[0m"
DIM="\033[2m"
RESET="\033[0m"

missing=0

detect_os() {
  case "$(uname -s)" in
    Linux*)
      if command -v apt-get >/dev/null 2>&1; then echo "debian";
      elif command -v dnf >/dev/null 2>&1; then echo "fedora";
      elif command -v pacman >/dev/null 2>&1; then echo "arch";
      else echo "linux"; fi
      ;;
    Darwin*) echo "macos" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    FreeBSD*) echo "freebsd" ;;
    *) echo "unknown" ;;
  esac
}

OS=$(detect_os)

hint() {
  local tool="$1"
  case "$OS:$tool" in
    debian:ffmpeg)      echo "  sudo apt-get install -y ffmpeg" ;;
    debian:rubberband)  echo "  sudo apt-get install -y rubberband-cli" ;;
    debian:python3.11)  echo "  sudo apt-get install -y python3.11 python3.11-venv python3.11-dev" ;;
    debian:node)        echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs" ;;
    debian:npm)         echo "  installed alongside nodejs (see above)" ;;
    fedora:ffmpeg)      echo "  sudo dnf install -y ffmpeg" ;;
    fedora:rubberband)  echo "  sudo dnf install -y rubberband" ;;
    fedora:python3.11)  echo "  sudo dnf install -y python3.11" ;;
    fedora:node)        echo "  sudo dnf install -y nodejs npm" ;;
    fedora:npm)         echo "  sudo dnf install -y nodejs npm" ;;
    arch:ffmpeg)        echo "  sudo pacman -S ffmpeg" ;;
    arch:rubberband)    echo "  sudo pacman -S rubberband" ;;
    arch:python3.11)    echo "  sudo pacman -S python311  (or use pyenv)" ;;
    arch:node)          echo "  sudo pacman -S nodejs npm" ;;
    arch:npm)           echo "  sudo pacman -S nodejs npm" ;;
    macos:ffmpeg)       echo "  brew install ffmpeg" ;;
    macos:rubberband)   echo "  brew install rubberband" ;;
    macos:python3.11)   echo "  brew install python@3.11" ;;
    macos:node)         echo "  brew install node@20" ;;
    macos:npm)          echo "  installed alongside node (see above)" ;;
    freebsd:ffmpeg)     echo "  sudo pkg install ffmpeg" ;;
    freebsd:rubberband) echo "  sudo pkg install rubberband" ;;
    freebsd:python3.11) echo "  sudo pkg install python311" ;;
    freebsd:node)       echo "  sudo pkg install node20" ;;
    freebsd:npm)        echo "  sudo pkg install npm" ;;
    *)                  echo "  install '$tool' via your platform's package manager" ;;
  esac
}

check() {
  local tool="$1"
  local cmd="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    local version
    version=$("$cmd" --version 2>&1 | head -n1)
    printf "${OK} %-14s ${DIM}%s${RESET}\n" "$tool" "$version"
    return 0
  else
    printf "${BAD} %-14s ${DIM}not found${RESET}\n" "$tool"
    hint "$tool"
    missing=$((missing + 1))
    return 1
  fi
}

check_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    printf "${BAD} %-14s ${DIM}not found${RESET}\n" "node"
    hint node
    missing=$((missing + 1))
    return
  fi
  local v
  v=$(node --version 2>&1 | sed 's/^v//')
  local major="${v%%.*}"
  if [ "${major:-0}" -ge 20 ] 2>/dev/null; then
    printf "${OK} %-14s ${DIM}v%s${RESET}\n" "node" "$v"
  else
    printf "${BAD} %-14s ${DIM}v%s (need >=20)${RESET}\n" "node" "$v"
    hint node
    missing=$((missing + 1))
  fi
}

check_python() {
  local cmd
  for cmd in python3.11 python3.12 python3.13 python3; do
    if command -v "$cmd" >/dev/null 2>&1; then
      local v major minor
      v=$("$cmd" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)
      major="${v%%.*}"
      minor="${v##*.}"
      if [ "${major:-0}" -ge 3 ] && [ "${minor:-0}" -ge 11 ] 2>/dev/null; then
        printf "${OK} %-14s ${DIM}%s (%s)${RESET}\n" "python>=3.11" "$v" "$cmd"
        return 0
      fi
    fi
  done
  printf "${BAD} %-14s ${DIM}need python 3.11+${RESET}\n" "python>=3.11"
  hint python3.11
  missing=$((missing + 1))
}

echo "automix — system check (OS: $OS)"
echo "--------------------------------"
check ffmpeg ffmpeg
check rubberband rubberband
check_python
check_node_version
check npm npm

echo "--------------------------------"
if [ "$missing" -eq 0 ]; then
  echo -e "${OK} All required tools present."
  exit 0
else
  echo -e "${BAD} $missing required tool(s) missing — see hints above."
  exit 1
fi
