"""Automix desktop launcher.

Boots the FastAPI backend, serves the built frontend from the same origin, and
opens it in a native window. Everything (Python, deps, ffmpeg, yt-dlp, the UI)
ships inside one package; this file is the entry point PyInstaller freezes.

Run in dev with a built frontend:  `python app.py`
"""

from __future__ import annotations

import json
import os
import re
import socket
import sys
import threading
import time
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)
# When frozen, PyInstaller extracts everything under sys._MEIPASS; in dev the
# repo root is this file's directory.
BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))

# A windowed build (console=False) has no console, so PyInstaller leaves
# sys.stdout / sys.stderr as None. Two things then break: any stray print()
# raises, and uvicorn's default log formatter calls sys.stdout.isatty() to pick
# colors, crashing with "'NoneType' object has no attribute 'isatty'" ->
# "Unable to configure formatter 'default'". Give them a harmless sink.
if sys.stdout is None or sys.stderr is None:
    import io

    class _NullStream(io.TextIOBase):
        def write(self, _s):  # noqa: D401 - swallow output silently
            return 0

        def isatty(self):
            return False

        def flush(self):
            pass

    if sys.stdout is None:
        sys.stdout = _NullStream()
    if sys.stderr is None:
        sys.stderr = _NullStream()

# On Windows, a windowed (no-console) build flashes a console window for every
# child process the backend spawns (ffmpeg / ffprobe / yt-dlp) — several appear
# during the startup track scan. The backend runs in THIS process (app.py
# imports `main`), so patching subprocess.Popen here — before the backend is
# imported — transparently adds CREATE_NO_WINDOW to every subprocess call
# (run/call/check_output all route through Popen). No backend edits needed.
if sys.platform.startswith("win"):
    import subprocess as _subprocess

    _CREATE_NO_WINDOW = 0x08000000
    _orig_popen_init = _subprocess.Popen.__init__

    def _popen_no_window(self, *args, **kwargs):
        kwargs["creationflags"] = kwargs.get("creationflags", 0) | _CREATE_NO_WINDOW
        _orig_popen_init(self, *args, **kwargs)

    _subprocess.Popen.__init__ = _popen_no_window

# User-writable home for the library, caches, and DB (outside the read-only
# bundle so it survives updates and app restarts).
DATA_DIR = Path(os.environ.get("AUTOMIX_DATA") or (Path.home() / "Automix"))
(DATA_DIR / "videos").mkdir(parents=True, exist_ok=True)
os.environ["AUTOMIX_DATA"] = str(DATA_DIR)

# Bundled read-only assets (fonts, brand overlays).
_assets = BASE / "assets"
if _assets.is_dir():
    os.environ["AUTOMIX_ASSETS"] = str(_assets)

# Bundled ffmpeg / ffprobe / yt-dlp win over anything on the system PATH.
_bin = BASE / "bin"
if _bin.is_dir():
    os.environ["PATH"] = str(_bin) + os.pathsep + os.environ.get("PATH", "")

# The backend modules are top-level (the server runs with backend/ as cwd), so
# put it on the path before importing.
BACKEND_DIR = BASE / "backend"
if BACKEND_DIR.is_dir():
    sys.path.insert(0, str(BACKEND_DIR))

# Built frontend: bundled at BASE/dist, or frontend/dist when running from source.
DIST_DIR = BASE / "dist"
if not DIST_DIR.is_dir():
    DIST_DIR = BASE / "frontend" / "dist"


def _app_version() -> str:
    """Current version, read at runtime (never hardcoded). Env override wins,
    else the newest changelog entry from the bundled/source changelog.ts."""
    env = os.environ.get("AUTOMIX_VERSION")
    if env:
        return env.lstrip("vV")
    try:
        txt = (BASE / "frontend" / "src" / "changelog.ts").read_text(encoding="utf-8")
        m = re.search(r'version:\s*"([^"]+)"', txt)
        if m:
            return m.group(1)
    except Exception:
        pass
    return ""


def _app_author() -> str:
    """Creator name, read at runtime. Env override wins, else package.json."""
    env = os.environ.get("AUTOMIX_AUTHOR")
    if env:
        return env
    try:
        pkg = json.loads((BASE / "package.json").read_text(encoding="utf-8"))
        author = pkg.get("author")
        if isinstance(author, dict):
            author = author.get("name")
        if author:
            return str(author)
    except Exception:
        pass
    return ""


# Splash credit line (bottom-left), e.g. "Nathan Rodrigues  ·  v0.13.1". Shown
# as live splash text above the boot status, so nothing is baked into the image.
def _credit_line() -> str:
    name, ver = _app_author(), _app_version()
    bits = [b for b in (name, f"v{ver}" if ver else "") if b]
    return "  ·  ".join(bits)


_CREDIT = _credit_line()


def _port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _stable_port() -> int:
    """Return a port that stays the same across launches.

    The frontend persists all its settings in localStorage, which is keyed by
    origin (scheme + host + PORT). A random port every launch = a fresh, empty
    localStorage every launch, so the user's settings appear to reset. Pin a
    remembered port (default 8770) so the origin is stable; only pick a new one
    if it is genuinely occupied, and remember that choice too.
    """
    remembered = DATA_DIR / "port"
    try:
        saved = int(remembered.read_text().strip())
        if 1024 <= saved <= 65535 and _port_is_free(saved):
            return saved
    except Exception:
        pass

    port = 8770 if _port_is_free(8770) else _free_port()
    try:
        remembered.write_text(str(port), encoding="utf-8")
    except Exception:
        pass
    return port


def _splash(text: str | None = None, close: bool = False) -> None:
    """Update or close the PyInstaller boot splash (no-op outside a frozen
    Windows/Linux build — pyi_splash only exists when the spec bundles one).

    The status message renders on top; the credit line (name + version) shows
    on the line below it — both as live text, bottom-center."""
    try:
        import pyi_splash

        if text is not None:
            msg = "\n".join(b for b in (text, _CREDIT) if b) or text
            pyi_splash.update_text(msg)
        if close:
            pyi_splash.close()
    except Exception:
        pass


def _build_app():
    from fastapi.staticfiles import StaticFiles

    import main  # noqa: E402  (import after env + sys.path are set)

    if DIST_DIR.is_dir():
        # Mounted last so /api, /videos, and /ws keep priority; this catches
        # the SPA routes. Same origin means the frontend needs no config.
        main.app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="ui")
    return main.app


def _wait_until_up(port: int, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.1)
    return False


def _launch() -> None:
    _splash("Starting backend…")
    import uvicorn

    app = _build_app()
    port = _stable_port()

    # If uvicorn throws inside the daemon thread (missing bundled module,
    # lifespan/startup crash, bad bind), the exception would die silently and
    # the main thread would only ever see the generic "did not come up" timeout
    # below. Stash the real traceback so it can be surfaced instead.
    serve_error: list[str] = []

    def serve() -> None:
        try:
            # log_config=None skips uvicorn's dictConfig (whose default
            # formatter probes sys.stdout.isatty()); logging falls back to the
            # already-configured root logger. Safe even with the stdio guard
            # above, and avoids color escape codes in a windowed build.
            uvicorn.run(
                app, host="127.0.0.1", port=port, log_level="warning",
                log_config=None,
            )
        except BaseException:
            import traceback

            serve_error.append(traceback.format_exc())

    threading.Thread(target=serve, daemon=True).start()
    if not _wait_until_up(port):
        if serve_error:
            raise RuntimeError(
                "backend crashed on startup:\n" + serve_error[0]
            )
        raise RuntimeError("backend did not come up on 127.0.0.1")

    url = f"http://127.0.0.1:{port}"
    _splash("Opening window…")
    try:
        import webview  # pywebview

        # Support both fullscreen and windowed. Default is windowed; set
        # AUTOMIX_FULLSCREEN=1 (or true/yes/on) to launch the same build
        # borderless full screen.
        fullscreen = os.environ.get("AUTOMIX_FULLSCREEN", "").strip().lower() in (
            "1", "true", "yes", "on",
        )
        window = webview.create_window(
            "Automix",
            url,
            width=1360,
            height=900,
            min_size=(1024, 680),
            fullscreen=fullscreen,
        )
        # Keep the splash up until the real window is on screen (falls back to
        # closing it now if this pywebview has no shown event).
        try:
            window.events.shown += lambda: _splash(close=True)
        except Exception:
            _splash(close=True)
        webview.start()
        _splash(close=True)  # in case the shown event never fired
    except Exception as e:
        # No native webview available: fall back to the default browser and
        # keep the server alive.
        print(f"native window unavailable ({e}); opening browser", file=sys.stderr)
        _splash(close=True)
        import webbrowser

        webbrowser.open(url)
        print(f"Automix running at {url} (press Ctrl+C to quit)")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass


def main_entry() -> None:
    # A windowed build has no console, so a startup crash would vanish silently.
    # Capture it to a log next to the user's data and surface it in a dialog so
    # it can actually be reported.
    try:
        _launch()
    except Exception:
        import traceback

        tb = traceback.format_exc()
        _splash(close=True)  # don't leave the splash floating over the error
        print(tb, file=sys.stderr)
        try:
            (DATA_DIR / "startup-error.log").write_text(tb, encoding="utf-8")
        except Exception:
            pass
        if sys.platform.startswith("win"):
            try:
                import ctypes

                ctypes.windll.user32.MessageBoxW(
                    0, tb[-1600:], "Automix failed to start", 0x10
                )
            except Exception:
                pass
        raise


if __name__ == "__main__":
    main_entry()
