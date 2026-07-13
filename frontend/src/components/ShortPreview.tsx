import { useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
import { apiUrl } from "@/lib/backend"
import type { RenderConfig } from "@/api/types"

/**
 * Live Short caption preview. Instead of approximating in CSS, it asks the
 * backend to render the caption frame with the SAME code the renderer uses
 * (rounded per-line boxes, chosen font, color Noto emoji) so the preview
 * matches the output exactly. Debounced so typing the title stays smooth.
 */
export function ShortPreview({ config }: { config: Omit<RenderConfig, "clips"> }) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const objUrl = useRef<string | null>(null)

  const title = config.short_title ?? ""
  const shortFont = config.short_font ?? null
  const titleFont = config.title_font ?? null
  const showArtist = config.short_show_artist ?? false

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(apiUrl("/api/short-preview"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            short_title: title,
            short_font: shortFont,
            title_font: titleFont,
            short_show_artist: showArtist,
          }),
        })
        if (!res.ok) throw new Error(String(res.status))
        const blob = await res.blob()
        if (cancelled) return
        const next = URL.createObjectURL(blob)
        if (objUrl.current) URL.revokeObjectURL(objUrl.current)
        objUrl.current = next
        setUrl(next)
      } catch {
        // Keep the last good preview (e.g. if the backend is momentarily down).
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [title, shortFont, titleFont, showArtist])

  useEffect(
    () => () => {
      if (objUrl.current) URL.revokeObjectURL(objUrl.current)
    },
    [],
  )

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Preview
      </div>
      <div className="relative mx-auto aspect-[9/16] w-full max-w-[248px] overflow-hidden rounded-2xl border border-border/60 bg-black">
        {url && (
          <img
            src={url}
            alt="Short caption preview"
            className="h-full w-full object-cover"
          />
        )}
        {loading && (
          <div className="absolute right-2 top-2 text-muted-foreground/70">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          </div>
        )}
      </div>
    </div>
  )
}
