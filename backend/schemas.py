from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field


class Segment(BaseModel):
    start: float
    end: float
    label: str


class Analysis(BaseModel):
    bpm: float
    key_camelot: str
    lufs: float
    drop_start_s: float
    drop_end_s: float
    beats: list[float]
    downbeats: list[float]
    segments: list[Segment]


class Track(BaseModel):
    id: str
    filename: str
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


class RenderRequest(BaseModel):
    clips: list[RenderClip]
    target_bpm: float
    crossfade_bars: float = 1.0
    loudness_lufs: float = -14.0
    use_stem_crossfade: bool = True
    harmonic_pitch_shift_max_semitones: float = 2.0


class RenderJobResponse(BaseModel):
    job_id: str
    output_path: str


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
    allin1: Literal["ready", "missing", "downloading"]
    demucs: Literal["ready", "missing", "downloading"]
    downloaded_bytes: int = 0
    total_bytes: int = 0


class ProgressMessage(BaseModel):
    job_id: str
    stage: Literal["analysis", "stems", "render", "download"]
    percent: float = Field(ge=0, le=100)
    message: str = ""
    done: bool = False
