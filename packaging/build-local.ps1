<#
.SYNOPSIS
  Build the Automix desktop exe locally on Windows (no GitHub release needed).

.DESCRIPTION
  Mirrors what the CI release workflow does, but runs on your machine using the
  existing backend/.venv. Produces an onedir build at dist/Automix/Automix.exe.

  Steps:
    1. Ensure backend/.venv has pyinstaller + pywebview.
    2. Ensure frontend/dist exists (runs `npm run build` if missing).
    3. Ensure bin/ has ffmpeg, ffprobe, yt-dlp.
    4. Run PyInstaller against packaging/automix.spec.

  NOTE: the spec's `console` flag controls whether the app opens a terminal
  alongside the window. Keep it True while debugging (backend errors print
  live); flip to False in packaging/automix.spec for a clean release build.

.PARAMETER Run
  Launch the built exe when the build finishes.

.EXAMPLE
  ./packaging/build-local.ps1
  ./packaging/build-local.ps1 -Run
#>
param(
    [switch]$Run
)

$ErrorActionPreference = "Stop"

# Repo root = parent of this script's folder (packaging/).
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
Write-Host "Repo root: $Root" -ForegroundColor Cyan

$VenvPython = Join-Path $Root "backend\.venv\Scripts\python.exe"
$Pyinstaller = Join-Path $Root "backend\.venv\Scripts\pyinstaller.exe"

if (-not (Test-Path $VenvPython)) {
    throw "backend\.venv not found. Create it first (cd backend; uv sync) then re-run."
}

# 1. Build tooling in the venv (idempotent; skips if already satisfied).
Write-Host "`n[1/4] Ensuring pyinstaller + pywebview in backend\.venv ..." -ForegroundColor Cyan
& uv pip install --python $VenvPython pyinstaller pywebview
if ($LASTEXITCODE -ne 0) { throw "failed to install build deps" }

# 2. Built frontend.
Write-Host "`n[2/4] Checking frontend\dist ..." -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $Root "frontend\dist\index.html"))) {
    Write-Host "  frontend\dist missing - running npm run build ..." -ForegroundColor Yellow
    Push-Location (Join-Path $Root "frontend")
    if (-not (Test-Path "node_modules")) { & npm install; if ($LASTEXITCODE -ne 0) { throw "npm install failed" } }
    & npm run build
    Pop-Location
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} else {
    Write-Host "  frontend\dist ok" -ForegroundColor Green
}

# 3. Bundled tools.
Write-Host "`n[3/4] Checking bin\ (ffmpeg, ffprobe, yt-dlp) ..." -ForegroundColor Cyan
$missing = @()
foreach ($tool in "ffmpeg.exe", "ffprobe.exe", "yt-dlp.exe") {
    if (-not (Test-Path (Join-Path $Root "bin\$tool"))) { $missing += $tool }
}
if ($missing.Count -gt 0) {
    Write-Host "  missing: $($missing -join ', ') - downloading via fetch_tools.py ..." -ForegroundColor Yellow
    & $VenvPython (Join-Path $Root "packaging\fetch_tools.py")
    if ($LASTEXITCODE -ne 0) { throw "fetch_tools.py failed" }
} else {
    Write-Host "  bin\ ok" -ForegroundColor Green
}

# 3b. Regenerate the boot splash so name + version reflect the current source
# (read live from package.json / changelog.ts; never baked into a stale PNG).
Write-Host "`n[3b] Regenerating splash.png ..." -ForegroundColor Cyan
& uv run --with pillow python (Join-Path $Root "packaging\make_splash.py")
if ($LASTEXITCODE -ne 0) { throw "make_splash.py failed" }

# 4. Freeze.
Write-Host "`n[4/4] Running PyInstaller (this takes a few minutes) ..." -ForegroundColor Cyan
# A running Automix.exe holds file locks under dist\Automix\_internal, which
# makes PyInstaller's clean of the old dist fail with WinError 5 / 145. Close it
# first so the rebuild always succeeds.
$running = Get-Process Automix -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "  Closing running Automix.exe (PID $($running.Id -join ', ')) ..." -ForegroundColor Yellow
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 800
}
if (Test-Path (Join-Path $Root "build")) { Remove-Item -Recurse -Force (Join-Path $Root "build") }
if (Test-Path (Join-Path $Root "dist"))  { Remove-Item -Recurse -Force (Join-Path $Root "dist") }
& $Pyinstaller --noconfirm (Join-Path $Root "packaging\automix.spec")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed" }

$ExePath = Join-Path $Root "dist\Automix\Automix.exe"
Write-Host "`nBuild complete: $ExePath" -ForegroundColor Green

if ($Run) {
    Write-Host "Launching ..." -ForegroundColor Cyan
    & $ExePath
}
