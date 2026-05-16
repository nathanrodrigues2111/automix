from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

ProgressCb = Callable[[str, float, str], None] | None


def _allin1_cache_dirs() -> list[Path]:
    candidates: list[Path] = []
    try:
        import allin1  # type: ignore

        pkg_dir = Path(allin1.__file__).parent
        candidates.append(pkg_dir / "models")
    except Exception:
        pass
    candidates.append(Path.home() / ".cache" / "allin1")
    return candidates


def _demucs_cache_dirs() -> list[Path]:
    th = os.environ.get("TORCH_HOME")
    bases = []
    if th:
        bases.append(Path(th))
    bases.append(Path.home() / ".cache" / "torch")
    return [b / "hub" / "checkpoints" for b in bases]


def _any_files(dirs: list[Path]) -> bool:
    for d in dirs:
        if d.exists() and any(d.iterdir()):
            return True
    return False


def get_status() -> dict:
    allin1_ok = _any_files(_allin1_cache_dirs())
    demucs_ok = _any_files(_demucs_cache_dirs())
    return {
        "allin1": "ready" if allin1_ok else "missing",
        "demucs": "ready" if demucs_ok else "missing",
        "downloaded_bytes": 0,
        "total_bytes": 0,
    }


def download_with_progress(callback: ProgressCb = None) -> dict:
    """Trigger weight downloads. allin1 lazy-downloads on first import/use;
    demucs downloads on first separate call."""
    if callback:
        callback("download", 5.0, "Initializing allin1")
    try:
        import allin1  # type: ignore
        # Touching analyze() with a tiny dummy isn't safe; rely on import.
        _ = allin1
    except Exception as e:
        if callback:
            callback("download", 100.0, f"allin1 init failed: {e}")

    if callback:
        callback("download", 40.0, "Initializing demucs")
    try:
        from demucs.pretrained import get_model  # type: ignore

        get_model("htdemucs")
    except Exception as e:
        if callback:
            callback("download", 100.0, f"demucs init failed: {e}")

    if callback:
        callback("download", 100.0, "Done")
    return get_status()
