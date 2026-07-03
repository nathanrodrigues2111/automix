export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--"
  const total = Math.floor(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

/** Strip YouTube-style `[abcdefgh]` IDs and trailing `.mp4`/`.mkv` extensions
 *  from a track filename so it shows clean in the UI. */
export function formatTrackTitle(filename: string): string {
  return filename
    .replace(/\s*\[[A-Za-z0-9_-]{6,}\]/g, "")
    .replace(/\.(mp4|mkv|mov|webm|m4v)$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim()
}

/** Preferred display title for a track: the backend-cleaned `title` when
 *  present, falling back to a cleaned-up filename. */
export function displayTitle(track: {
  title?: string | null
  filename: string
}): string {
  const t = track.title?.trim()
  return t && t.length > 0 ? t : formatTrackTitle(track.filename)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3))
  return `${(bytes / Math.pow(1000, i)).toFixed(1)} ${units[i]}`
}
