export interface Segment {
  start: number
  end: number
  label: string
}

export interface Drop {
  start_s: number
  end_s: number
  kick_s?: number
  /** Measured kick period (seconds per beat) inside the drop body. */
  kick_period_s?: number
  score: number
  /** From a set's tracklist cues. */
  title?: string | null
  /** For labeled sets: the auto-picked drop for its song. false = an
   *  alternate candidate the user can swap in manually. */
  primary?: boolean
  /** 0-1: how confident the picker is that this candidate is the song's
   *  real main drop (position in segment + relative strength). */
  confidence?: number
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
  /** Cleaned display title from the backend — prefer over formatTrackTitle(filename). */
  title?: string
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
  kick_s?: number | null
  /** Overrides the source track's display title (set cues). */
  title?: string | null
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
  /** EDMPAPA-style black bars + logo overlay on the final render. */
  brand_overlay?: boolean
  /** Soften each hard video cut with a quick 0.25s fade (default on). */
  video_cut_fade?: boolean
  /** xfade style at cuts: "fade", a named xfade transition, or "variety"
   *  to cycle punchy styles per cut. */
  video_transition?: string
  /** Per-track title overlay on the final render. */
  show_titles?: boolean
  /** Black+silent tail reserved for YouTube end screens (seconds, 0 = off). */
  outro_s?: number
  /** Output canvas: "480p" | "720p" | "1080p" | "1440p" | "2160p". */
  resolution?: string
  /** Export naming: "file" (source video name + random number) | "timestamp". */
  filename_style?: string
  /** Force every drop clip to N bars (0 = auto: detected drop body). */
  drop_bars?: number
  /** Also render a vertical YouTube Short of the first drop. */
  make_short?: boolean
  harmonic_pitch_shift_max_semitones: number
  proxy?: boolean
}

export interface MixRecord {
  filename: string
  /** Relative path like "videos/automix_...mp4" — link as `/${path}`. */
  path: string
  size_bytes: number
  created_at: string
}

export interface DeleteResponse {
  deleted: boolean
}

export interface RefreshTitlesResponse {
  updated: number
  changes: unknown[]
}

export interface YoutubeImportRequest {
  url: string
  max_tracks?: number | null
  video_ids?: string[] | null
  max_height?: number | null
}

export interface PlaylistEntry {
  id: string
  title: string
  uploader: string
  duration_s: number | null
}

export interface AutomixRequest {
  url?: string | null
  track_ids?: string[] | null
  max_tracks?: number | null
  video_ids?: string[] | null
  max_height?: number | null
  config?: Partial<Omit<RenderConfig, "clips">>
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

export type ModelState = "ready" | "missing" | "downloading" | "unavailable"

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
  short_path?: string | null
  render_id?: string | null
}
