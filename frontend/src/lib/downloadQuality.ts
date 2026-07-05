/** YouTube download quality preference: max video height for imported
 *  tracks. null = best available (4K+ when YouTube has it). Persisted
 *  locally and sent with every import request as `max_height`. */

export interface DownloadQualityOption {
  label: string
  /** Height cap in pixels; null = no cap (best available). */
  height: number | null
}

export const DOWNLOAD_QUALITIES: DownloadQualityOption[] = [
  { label: "Best available", height: null },
  { label: "2160p (4K)", height: 2160 },
  { label: "1440p (2K)", height: 1440 },
  { label: "1080p (Full HD)", height: 1080 },
  { label: "720p (HD)", height: 720 },
]

const KEY = "automix.downloadQuality.v1"

/** Stored height cap, or null for best available (the default). */
export function loadDownloadMaxHeight(): number | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null || raw === "best") return null
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function setDownloadMaxHeight(height: number | null): void {
  try {
    if (height === null) localStorage.setItem(KEY, "best")
    else localStorage.setItem(KEY, String(height))
  } catch {
    // storage unavailable — preference just won't persist
  }
}
