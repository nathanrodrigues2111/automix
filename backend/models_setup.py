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


def _allin1_importable() -> bool:
    try:
        import allin1  # type: ignore  # noqa: F401
        return True
    except Exception:
        return False


def _demucs_importable() -> bool:
    try:
        import demucs.pretrained  # type: ignore  # noqa: F401
        return True
    except Exception:
        return False


def ml_installed() -> bool:
    """True when the optional [ml] python stack (torch/allin1/demucs) is importable."""
    return _allin1_importable() or _demucs_importable()


def get_status() -> dict:
    # Three states per model:
    #   ready       — weights cached, neural path active
    #   missing     — python package installed but weights not downloaded yet
    #   unavailable — python package not installed (the [ml] extra); the
    #                 librosa fallback in analysis.py handles everything, so
    #                 this is informational, not a download prompt.
    if _allin1_importable():
        allin1 = "ready" if _any_files(_allin1_cache_dirs()) else "missing"
    else:
        allin1 = "unavailable"
    if _demucs_importable():
        demucs = "ready" if _any_files(_demucs_cache_dirs()) else "missing"
    else:
        demucs = "unavailable"
    return {
        "allin1": allin1,
        "demucs": demucs,
        "downloaded_bytes": 0,
        "total_bytes": 0,
    }


def _trigger_allin1_download(callback: ProgressCb) -> None:
    """Trigger real allin1 weight download by running analyze() on a tiny dummy WAV."""
    import tempfile
    import numpy as np
    import soundfile as sf
    import allin1  # type: ignore

    if callback:
        callback("download", 15.0, "Downloading allin1 weights (first run, may take minutes)")
    with tempfile.TemporaryDirectory() as tmp:
        dummy = Path(tmp) / "probe.wav"
        # 2s of silence at 44.1kHz stereo — minimum allin1 will accept.
        sf.write(str(dummy), np.zeros((88200, 2), dtype=np.float32), 44100)
        try:
            allin1.analyze(str(dummy), out_dir=str(Path(tmp) / "out"))
        except Exception as e:
            # analyze() may still fail on silent input; what we care about is
            # whether weights got downloaded as a side effect.
            if callback:
                callback("download", 50.0, f"allin1 probe finished: {e}")


def download_with_progress(callback: ProgressCb = None) -> dict:
    """Trigger weight downloads. allin1 only downloads on first analyze() call,
    so we run a probe analyze on a silent dummy."""
    if callback:
        callback("download", 5.0, "Checking allin1")
    if _allin1_importable():
        try:
            _trigger_allin1_download(callback)
        except Exception as e:
            if callback:
                callback("download", 55.0, f"allin1 download failed: {e}")
    else:
        if callback:
            callback("download", 55.0, "allin1 not importable — using fallback analyzer")

    if callback:
        callback("download", 60.0, "Initializing demucs")
    try:
        from demucs.pretrained import get_model  # type: ignore

        get_model("htdemucs")
    except Exception as e:
        if callback:
            callback("download", 100.0, f"demucs init failed: {e}")

    if callback:
        callback("download", 100.0, "Done")
    return get_status()
