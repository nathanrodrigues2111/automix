export interface Segment {
  start: number
  end: number
  label: string
}

export interface Drop {
  start_s: number
  end_s: number
  score: number
}

export interface TrackAnalysis {
  bpm: number
  key_camelot: string
  lufs: number
  drop_start_s: number
  drop_end_s: number
  beats: number[]
  downbeats: number[]
  segments: Segment[]
  drops?: Drop[]
}

export interface Track {
  id: string
  filename: string
  path: string
  duration_s: number
  size_bytes: number
  codec_video: string
  codec_audio: string
  analyzed: boolean
  analysis: TrackAnalysis | null
}

export interface WaveformPeaks {
  version: number
  channels: number[][]
  sample_rate: number
  samples_per_pixel: number
  bits: number
  length: number
}

export interface AnalyzeRequest {
  track_id: string
}

export interface JobResponse {
  job_id: string
}

export interface RenderClip {
  track_id: string
  start_s: number
  length_bars: number
  end_s?: number | null
}

export interface RenderConfig {
  clips: RenderClip[]
  target_bpm: number
  crossfade_bars: number
  loudness_lufs: number
  use_stem_crossfade: boolean
  use_eq_bass_swap?: boolean
  snap_to_downbeat?: boolean
  hard_cut?: boolean
  no_time_stretch?: boolean
  harmonic_pitch_shift_max_semitones: number
  proxy?: boolean
}

export interface RenderResponse {
  job_id: string
  output_path: string | null
}

export interface RenderRecord {
  id: string
  output_path: string
  created_at: string
  config: RenderConfig
}

export interface Project {
  id: string
  name: string
  created_at: string
  updated_at: string
  config: RenderConfig
}

export interface ProjectCreate {
  name: string
  config: RenderConfig
}

export type ModelState = "ready" | "missing" | "downloading"

export interface ModelsStatus {
  allin1: ModelState
  demucs: ModelState
  downloaded_bytes: number
  total_bytes: number
}

export type ProgressStage =
  | "analysis"
  | "stems"
  | "render"
  | "download"

export interface ProgressMessage {
  job_id: string
  stage: ProgressStage
  percent: number
  message: string
  done: boolean
  output_path?: string | null
  render_id?: string | null
}
