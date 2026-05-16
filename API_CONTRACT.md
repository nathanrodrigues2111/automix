# API Contract — Automix

Backend serves on `localhost:8000`. Frontend serves on `localhost:5173` with a Vite proxy `/api` → `localhost:8000` and `/ws` → `localhost:8000`.

## HTTP Endpoints

### `GET /api/tracks`
Scans `videos/` (recursively, .mp4 only). Returns:
```json
[
  {
    "id": "string (sha256 of file path + size, 16 chars)",
    "filename": "...",
    "path": "videos/...",
    "duration_s": 234.5,
    "size_bytes": 256000000,
    "codec_video": "h264",
    "codec_audio": "aac",
    "analyzed": true,
    "analysis": {                 // null if analyzed=false
      "bpm": 128.0,
      "key_camelot": "8A",
      "lufs": -8.2,
      "drop_start_s": 64.3,
      "drop_end_s": 95.1,
      "beats": [0.46, 0.93, ...],
      "downbeats": [0.46, 2.34, ...],
      "segments": [{"start": 0, "end": 16, "label": "intro"}, ...]
    }
  }
]
```

### `POST /api/analyze`
Body: `{ "track_id": "..." }`
Returns: `{ "job_id": "uuid" }`
Progress streamed over `/ws/progress` keyed by `job_id`. Result cached to SQLite by file hash.

### `GET /api/tracks/{track_id}/waveform`
Returns precomputed waveform peaks for wavesurfer.js:
```json
{ "version": 2, "channels": [[...]], "sample_rate": 8000, "samples_per_pixel": 256, "bits": 16, "length": N }
```

### `GET /api/tracks/{track_id}/video`
Streams the MP4 with HTTP range support so `<video>` can seek.

### `POST /api/render`
Body:
```json
{
  "clips": [
    { "track_id": "...", "start_s": 64.3, "length_bars": 16 }
  ],
  "target_bpm": 128.0,
  "crossfade_bars": 1.0,
  "loudness_lufs": -14.0,
  "use_stem_crossfade": true,
  "harmonic_pitch_shift_max_semitones": 2
}
```
Returns: `{ "job_id": "uuid", "output_path": "videos/automix_<ts>.mp4" }`
Progress streamed over `/ws/progress`.

### `GET /api/renders`
Returns list of completed renders: `[{ "id", "output_path", "created_at", "config": {...} }]`.

### `POST /api/projects` / `GET /api/projects/{id}` / `GET /api/projects`
Save/load mix projects: `{ id, name, created_at, updated_at, config: <same shape as /api/render body> }`.

### `GET /api/models/status`
Returns: `{ "allin1": "ready" | "missing" | "downloading", "demucs": "ready" | "missing" | "downloading", "downloaded_bytes": N, "total_bytes": M }`

### `POST /api/models/download`
Triggers download of missing weights. Progress streamed over `/ws/progress` with `job_id="models"`.

## WebSocket — `/ws/progress`

Client connects, optionally sends `{"subscribe": "<job_id>"}` (or no message to receive all). Server sends:
```json
{ "job_id": "uuid", "stage": "analysis|stems|render|download", "percent": 42.0, "message": "...", "done": false }
```

## Stable shapes
- Times in seconds (floats).
- BPM as float.
- Key as Camelot string (e.g., "8A", "12B").
- LUFS as negative float (e.g., -14.0).
