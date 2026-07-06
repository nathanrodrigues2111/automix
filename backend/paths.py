"""Central filesystem roots, overridable by environment for packaged builds.

In normal dev/run everything resolves exactly as before (videos next to the
repo, caches under backend/.cache). When the app is frozen into a self-contained
package, the launcher sets AUTOMIX_DATA to a user-writable folder (e.g.
~/Automix) so the library, caches, and SQLite DB persist outside the read-only
bundle, and AUTOMIX_ASSETS to the bundled assets directory.
"""

from __future__ import annotations

import os
from pathlib import Path

_BACKEND_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _BACKEND_DIR.parent

_data_env = os.environ.get("AUTOMIX_DATA")
_DATA_ROOT = Path(_data_env) if _data_env else None

# Writable roots.
VIDEOS_DIR = (_DATA_ROOT / "videos") if _DATA_ROOT else (_PROJECT_ROOT / "videos")
CACHE_DIR = (_DATA_ROOT / ".cache") if _DATA_ROOT else (_BACKEND_DIR / ".cache")
DB_PATH = CACHE_DIR / "automix.sqlite"

# Read-only bundled assets (fonts, overlays). Stays inside the package.
ASSETS_DIR = Path(os.environ.get("AUTOMIX_ASSETS", str(_PROJECT_ROOT / "assets")))
