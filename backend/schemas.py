from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


class Segment(BaseModel):
    start: float
    end: float
    label: str


class Drop(BaseModel):
    start_s: float
    end_s: float
    kick_s: float | None = None  # time of the actual drop kick (used to align crossfades)
    score: float = 0.0


class Analysis(BaseModel):
    bpm: float
    key_camelot: str
    lufs: float
    drop_start_s: float
    drop_end_s: float
    beats: list[float]
    downbeats: list[float]
    segments: list[Segment]
    drops: list[Drop] = []


class Track(BaseModel):
    id: str
    filename: str
    title: str = ""  # display title (from track_meta or cleaned filename)
    path: str
    duration_s: float
    size_bytes: int
    codec_video: str
    codec_audio: str
    analyzed: bool
    analysis: Analysis | None = None


class AnalyzeRequest(BaseModel):
    track_id: str


class JobResponse(BaseModel):
    job_id: str


class RenderClip(BaseModel):
    track_id: str
    start_s: float
    length_bars: float
    # If set, render uses this exact end time and ignores length_bars + snapping.
    end_s: float | None = None
    # Drop kick time in source coordinates — used to compute the buildup length
    # so the incoming clip's drop hits exactly when the outgoing clip's drop ends.
    kick_s: float | None = None


class RenderRequest(BaseModel):
    clips: list[RenderClip]
    target_bpm: float = 0.0  # 0 = auto (mean of source BPMs)
    crossfade_bars: float = 1.0
    loudness_lufs: float = -14.0
    use_stem_crossfade: bool = True
    use_eq_bass_swap: bool = True
    snap_to_downbeat: bool = True
    harmonic_pitch_shift_max_semitones: float = 2.0
    proxy: bool = False  # 720p, ultrafast preset, single-pass loudnorm, skip stems
    hard_cut: bool = False  # cut on downbeat with no crossfade (drops-only style)
    no_time_stretch: bool = False  # drops-only fast path: trim+concat each source, no BPM matching
    brand_overlay: bool = True  # EDMPAPA letterbox bars + logo pass
    show_titles: bool = True  # per-clip track title in the bottom bar


class YouTubeImportRequest(BaseModel):
    url: str
    max_tracks: int | None = None


class AutomixRequest(BaseModel):
    url: str | None = None  # optional playlist/video URL to import first
    track_ids: list[str] | None = None  # explicit tracks; default = all in videos/
    max_tracks: int | None = None
    config: dict = Field(default_factory=dict)  # RenderRequest-style overrides


class RenderJobResponse(BaseModel):
    job_id: str
    output_path: str | None = None  # null until render completes; final path arrives over WS


class RenderRecord(BaseModel):
    id: str
    output_path: str
    created_at: str
    config: dict


class Project(BaseModel):
    id: str
    name: str
    created_at: str
    updated_at: str
    config: dict


class ProjectCreate(BaseModel):
    name: str
    config: dict


class WaveformResponse(BaseModel):
    version: int = 2
    channels: list[list[float]]
    sample_rate: int = 8000
    samples_per_pixel: int = 256
    bits: int = 16
    length: int


class ModelsStatus(BaseModel):
    allin1: Literal["ready", "missing", "downloading", "unavailable"]
    demucs: Literal["ready", "missing", "downloading", "unavailable"]
    downloaded_bytes: int = 0
    total_bytes: int = 0


class ProgressMessage(BaseModel):
    job_id: str
    stage: Literal["analysis", "stems", "render", "download"]
    percent: float = Field(ge=0, le=100)
    message: str = ""
    done: bool = False
    output_path: str | None = None
    render_id: str | None = None
