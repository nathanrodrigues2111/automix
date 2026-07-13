"""Automix desktop launcher.

Boots the FastAPI backend, serves the built frontend from the same origin, and
opens it in a native window. Everything (Python, deps, ffmpeg, yt-dlp, the UI)
ships inside one package; this file is the entry point PyInstaller freezes.

Run in dev with a built frontend:  `python app.py`
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)
# When frozen, PyInstaller extracts everything under sys._MEIPASS; in dev the
# repo root is this file's directory.
BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))

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
            uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
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
    try:
        import webview  # pywebview

        # Support both fullscreen and windowed. Default is windowed; set
        # AUTOMIX_FULLSCREEN=1 (or true/yes/on) to launch the same build
        # borderless full screen.
        fullscreen = os.environ.get("AUTOMIX_FULLSCREEN", "").strip().lower() in (
            "1", "true", "yes", "on",
        )
        webview.create_window(
            "Automix",
            url,
            width=1360,
            height=900,
            min_size=(1024, 680),
            fullscreen=fullscreen,
        )
        webview.start()
    except Exception as e:
        # No native webview available: fall back to the default browser and
        # keep the server alive.
        print(f"native window unavailable ({e}); opening browser", file=sys.stderr)
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
