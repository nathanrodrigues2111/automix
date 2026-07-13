<#
.SYNOPSIS
  Automix — one-shot dev environment bootstrap for Windows (PowerShell).

.DESCRIPTION
  Installs every prerequisite the project needs and then all project deps:
    system tools : uv, python 3.12, node 20+, ffmpeg/ffprobe, yt-dlp
    optional     : rubberband (-WithRubberband), neural ML stack (-WithMl)
    project deps : root npm (concurrently, rimraf), backend venv, frontend node_modules

  System packages install via winget (preferred), then choco, then scoop.
  uv / python / yt-dlp install per-user (no admin). Safe to re-run.

.EXAMPLE
  # From the repo root, in PowerShell:
  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -WithRubberband -WithMl
#>
[CmdletBinding()]
param(
  [switch]$WithRubberband,
  [switch]$WithMl
)

$ErrorActionPreference = "Stop"
$PythonVersion = "3.12"   # backend requires >=3.10,<3.13 — pin a supported minor

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !   $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  X   $m" -ForegroundColor Red; exit 1 }
function Have($c) { $null -ne (Get-Command $c -ErrorAction SilentlyContinue) }

# Refresh this session's PATH from the machine + user registry so tools
# installed a moment ago (uv, node, ffmpeg) become callable without a restart.
function Refresh-Path {
  $m = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $u = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = ($m, $u, "$env:USERPROFILE\.local\bin") -join ";"
}

# Run from the repo root regardless of where the script was invoked from.
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# ---- pick a system package manager ------------------------------------------
$Sys = $null
if     (Have winget) { $Sys = "winget" }
elseif (Have choco)  { $Sys = "choco" }
elseif (Have scoop)  { $Sys = "scoop" }

Step "Automix setup - Windows$(if ($Sys) { " (package manager: $Sys)" })"
if (-not $Sys) { Warn "No winget/choco/scoop found; some system packages may need manual install." }

# Install a package by its per-manager id. Any id may be $null to skip a manager.
function Install-Pkg($friendly, $wingetId, $chocoId, $scoopId) {
  switch ($Sys) {
    "winget" { if ($wingetId) { Write-Host "  $ winget install --id $wingetId" -ForegroundColor DarkGray; winget install --id $wingetId --accept-source-agreements --accept-package-agreements -e --silent; return $true } }
    "choco"  { if ($chocoId)  { Write-Host "  $ choco install $chocoId -y" -ForegroundColor DarkGray; choco install $chocoId -y; return $true } }
    "scoop"  { if ($scoopId)  { Write-Host "  $ scoop install $scoopId" -ForegroundColor DarkGray; scoop install $scoopId; return $true } }
  }
  Warn "Install '$friendly' manually (no supported package manager)."
  return $false
}

# =============================================================================
# 1. uv - Python toolchain + venv manager (also fetches Python for us)
# =============================================================================
Step "uv (Python manager)"
if (Have uv) {
  Ok "uv already installed ($(uv --version))"
} else {
  Warn "installing uv via the official installer (per-user, no admin)"
  powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"
  Refresh-Path
  if (-not (Have uv)) { Die "uv install failed - see https://docs.astral.sh/uv/" }
  Ok "uv installed ($(uv --version))"
}

# =============================================================================
# 2. Python (backend supports 3.10+; the venv step prefers your newest
#    installed Python, so this just guarantees a fallback exists via uv)
# =============================================================================
Step "Python (fallback $PythonVersion via uv)"
uv python install $PythonVersion
Ok "Python $PythonVersion available via uv (used only if no system Python 3.10+ is found)"

# =============================================================================
# 3. Node.js 20+ and npm - Volta preferred (this repo pins Node via its
#    "volta" field in package.json), winget/choco/scoop as a fallback.
# =============================================================================
Step "Node.js 20+ (Volta preferred)"
function Node-Ok {
  if (-not (Have node)) { return $false }
  return ([int](((node -v) -replace '^v','') -split '\.')[0]) -ge 20
}
if (Node-Ok) {
  if (Have volta) { Ok "node $(node -v) already installed (via Volta)" } else { Ok "node $(node -v) already installed" }
} else {
  # No usable Node yet. Prefer Volta since the project pins its Node version there.
  if (-not (Have volta)) {
    Warn "installing Volta (Node toolchain manager - what this project pins with)"
    Install-Pkg "Volta" "Volta.Volta" "volta" "volta" | Out-Null
    Refresh-Path
  }
  if (Have volta) {
    # Installs a default toolchain so node/npm resolve everywhere; inside the
    # repo the "volta" pin in package.json takes precedence automatically.
    volta install node@20
  } else {
    Install-Pkg "Node.js LTS" "OpenJS.NodeJS.LTS" "nodejs-lts" "nodejs-lts" | Out-Null
  }
  Refresh-Path
  if (Node-Ok) { Ok "node $(node -v)" } else { Warn "Node 20+ still not on PATH - open a new terminal (Volta needs it), then re-run." }
}

# =============================================================================
# 4. ffmpeg / ffprobe
# =============================================================================
Step "ffmpeg / ffprobe"
if ((Have ffmpeg) -and (Have ffprobe)) {
  Ok "ffmpeg present ($((ffmpeg -version | Select-Object -First 1)))"
} else {
  Install-Pkg "ffmpeg" "Gyan.FFmpeg" "ffmpeg" "ffmpeg" | Out-Null
  Refresh-Path
  if (Have ffmpeg) { Ok "ffmpeg installed" } else { Warn "ffmpeg still missing - open a new terminal or install manually." }
}

# =============================================================================
# 5. yt-dlp (installed as a uv tool so it lands on PATH globally)
# =============================================================================
Step "yt-dlp"
if (Have yt-dlp) {
  Ok "yt-dlp already on PATH"
} else {
  uv tool install yt-dlp
  Refresh-Path
  Ok "yt-dlp installed via uv tool"
}

# =============================================================================
# 6. rubberband (OPTIONAL - only for BPM stretch / pitch-shift modes)
# =============================================================================
if ($WithRubberband) {
  Step "rubberband (optional)"
  if (Have rubberband) { Ok "rubberband already installed" }
  else { Install-Pkg "rubberband" $null $null "rubberband" | Out-Null }
} else {
  Warn "Skipping rubberband (optional). Pass -WithRubberband to install it."
}

# =============================================================================
# 7. Project dependencies
# =============================================================================
Step "Root dev tools (concurrently, rimraf)"
npm install

Step "Backend venv + Python deps"
# Delegates to scripts/install-backend.mjs: reuses an existing venv, picks the
# newest installed Python (>=3.10) or fetches $PythonVersion via uv, installs [dev].
npm run install:backend
if ($WithMl) {
  Step "Neural ML stack (allin1 + demucs + torch - several GB)"
  Push-Location backend
  uv pip install -e ".[ml]"
  Pop-Location
}

Step "Frontend node_modules"
npm --prefix frontend install

# =============================================================================
# 8. Verify
# =============================================================================
Step "System check"
try { node scripts/check-system.mjs } catch { }

Write-Host "`nSetup complete." -ForegroundColor Green
Write-Host "Start the app with:  npm run dev"
Write-Host "   Backend -> http://localhost:8000   Frontend -> http://localhost:5173"
Write-Host "If a new terminal can't find uv/yt-dlp, they live in %USERPROFILE%\.local\bin." -ForegroundColor DarkGray
