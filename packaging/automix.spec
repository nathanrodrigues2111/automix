# PyInstaller spec for the Automix desktop package.
# Built per-OS in CI. Bundles: app.py entry, the backend package, the built
# frontend (dist), read-only assets, and static ffmpeg/ffprobe/yt-dlp in bin/.
#
# Run from the repo root:  pyinstaller packaging/automix.spec
# Expects (populated by CI before this runs):
#   frontend/dist/   built frontend
#   bin/             ffmpeg, ffprobe, yt-dlp (+ .exe on Windows)

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH).resolve().parent  # packaging/ -> repo root
IS_WIN = sys.platform.startswith("win")

datas = [
    (str(ROOT / "backend"), "backend"),
    (str(ROOT / "frontend" / "dist"), "dist"),
    (str(ROOT / "assets"), "assets"),
]
binaries = []

# Static tools -> bundled bin/ (app.py prepends this to PATH at launch).
bin_dir = ROOT / "bin"
if bin_dir.is_dir():
    for f in bin_dir.iterdir():
        if f.is_file():
            binaries.append((str(f), "bin"))

# librosa/numba/soundfile/scipy pull in data files and lazy submodules that
# PyInstaller misses without help.
hiddenimports = []
for pkg in ("librosa", "numba", "soundfile", "scipy", "sklearn", "audioread"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass
# Backend modules are imported dynamically (import main), so name them.
hiddenimports += [
    "main", "render", "analysis", "db", "youtube",
    "schemas", "models_setup", "ordering", "verify", "paths",
]
hiddenimports += collect_submodules("uvicorn")

a = Analysis(
    [str(ROOT / "app.py")],
    pathex=[str(ROOT), str(ROOT / "backend")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # ML stack is intentionally excluded to keep the package lean.
    excludes=["torch", "demucs", "allin1", "tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Automix",
    console=False,
    disable_windowed_traceback=False,
    icon=str(ROOT / "packaging" / "icon.ico") if (ROOT / "packaging" / "icon.ico").exists() else None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    name="Automix",
)

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="Automix.app",
        icon=str(ROOT / "packaging" / "icon.icns") if (ROOT / "packaging" / "icon.icns").exists() else None,
        bundle_identifier="com.edmpapa.automix",
        info_plist={"NSHighResolutionCapable": True},
    )
