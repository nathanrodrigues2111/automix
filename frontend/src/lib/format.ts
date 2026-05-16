export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--"
  const total = Math.floor(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3))
  return `${(bytes / Math.pow(1000, i)).toFixed(1)} ${units[i]}`
}
