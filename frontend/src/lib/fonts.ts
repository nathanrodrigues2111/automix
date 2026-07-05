import { apiUrl } from "@/lib/backend"
import type { FontInfo } from "@/api/types"

/** Title fonts live on the backend (assets/fonts). This loads one into the
 *  document via the FontFace API so the live preview and the settings
 *  dropdown render with the exact font the mix will be burned with. */
const loading = new Map<string, Promise<void>>()

export function ensureFontLoaded(font: FontInfo): Promise<void> {
  const existing = loading.get(font.id)
  if (existing) return existing
  const promise = (async () => {
    const url = apiUrl(`/api/fonts/${encodeURIComponent(font.id)}/file`)
    const face = new FontFace(font.family, `url("${url}")`)
    await face.load()
    document.fonts.add(face)
  })().catch((e) => {
    loading.delete(font.id) // allow a retry on the next call
    throw e
  })
  loading.set(font.id, promise)
  return promise
}
