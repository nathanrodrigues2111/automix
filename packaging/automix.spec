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
    # Read at runtime by app.py for the splash credit line (name + version),
    # so those values stay dynamic instead of baked into the splash image.
    (str(ROOT / "package.json"), "."),
    (str(ROOT / "frontend" / "src" / "changelog.ts"), "frontend/src"),
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
for pkg in (
    "librosa", "numba", "llvmlite", "soundfile", "soxr", "audioread",
    "lazy_loader", "pooch", "scipy", "sklearn", "joblib", "threadpoolctl",
):
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

# Boot splash: shows within ~a second of launching the exe, long before
# Python/uvicorn are up; app.py updates its status line and closes it once the
# window is on screen. Not supported by PyInstaller on macOS, and it needs
# Tcl/Tk SHARED libraries on the BUILD machine (CI's setup-python has them;
# uv-managed local pythons don't, and Splash aborts the build) — so skip the
# splash, never fail the build, when they're unavailable.
splash = None
if sys.platform != "darwin":
    try:
        # PyInstaller hard-codes the splash text anchor to bottom-left ("sw").
        # Flip it to bottom-center ("s") so a horizontally-centered text_pos
        # truly centers the (already center-justified) credit + status lines.
        from PyInstaller.building import splash_templates as _spt
        _spt.splash_canvas_text = _spt.splash_canvas_text.replace(
            "-anchor sw", "-anchor s"
        )
        splash = Splash(
            str(ROOT / "packaging" / "splash.png"),
            binaries=a.binaries,
            datas=a.datas,
            # Bottom-center: app.py renders the credit line (name + version) here,
            # with the live boot status on the line below it. x = image width / 2
            # (640 / 2 = 320); the anchor override above makes this the center.
            text_pos=(320, 360),
            text_size=11,
            text_color="#c7d2e4",
            text_default="Starting…",
            minify_script=True,
            always_on_top=False,
        )
    except BaseException as e:  # Splash raises SystemExit when Tcl/Tk is missing
        print(f"splash screen skipped: {e}", file=sys.stderr)
        splash = None

exe = EXE(
    pyz,
    a.scripts,
    *([splash] if splash else []),
    [],
    exclude_binaries=True,
    name="Automix",
    # Windowed build: no console. Startup crashes are still captured to
    # ~/Automix/startup-error.log + a Windows message box (see app.py).
    # Set to True only for local debug builds (backend traceback in terminal).
    console=False,
    disable_windowed_traceback=False,
    icon=str(ROOT / "packaging" / "icon.ico") if (ROOT / "packaging" / "icon.ico").exists() else None,
)
coll = COLLECT(
    exe,
    *([splash.binaries] if splash else []),
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
