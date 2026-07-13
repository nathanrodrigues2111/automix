import { useEffect } from "react"
import { useFonts } from "@/api/client"
import { ensureFontLoaded } from "@/lib/fonts"
import type { CSSProperties } from "react"
import type { FontInfo, RenderConfig } from "@/api/types"

/**
 * A lightweight, self-contained mockup of the rendered vertical Short's
 * caption layout. NOT a real render — a 9:16 placeholder that approximates
 * how the title (top) and artist/track (bottom) boxes will look, updating
 * live as the Short title / font change. Sizes use container-query units
 * (cqw) so the captions stay proportional to the frame at any preview size.
 */
export function ShortPreview({ config }: { config: Omit<RenderConfig, "clips"> }) {
  const fonts = useFonts()
  const list = fonts.data?.fonts ?? []

  const find = (id?: string | null): FontInfo | undefined =>
    id ? list.find((f) => f.id === id) : undefined
  const resolved = find(config.short_font) ?? find(config.title_font) ?? find(fonts.data?.default)
  const family = resolved?.family ?? "sans-serif"
  const fontFamily = `'${family}', sans-serif`

  useEffect(() => {
    if (resolved) void ensureFontLoaded(resolved).catch(() => {})
  }, [resolved])

  const title = (config.short_title ?? "").trim()

  // Shared box look — padding + radius in em so they scale with the font size.
  const box: CSSProperties = {
    fontFamily,
    fontWeight: 800,
    color: "#000",
    background: "#fff",
    padding: "0.28em 0.55em",
    borderRadius: "0.42em",
    lineHeight: 1.08,
    maxWidth: "88%",
    textAlign: "center",
    boxShadow: "0 0.4cqw 1.6cqw rgba(0,0,0,0.35)",
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Preview
      </div>
      <div
        className="relative mx-auto aspect-[9/16] w-full max-w-[248px] overflow-hidden rounded-2xl border border-border/60"
        style={{
          containerType: "inline-size",
          background:
            "radial-gradient(120% 80% at 50% 20%, #241014 0%, #14141c 45%, #050507 100%)",
        }}
        aria-label="Short caption preview"
      >
        {/* Title caption — upper area */}
        <div className="absolute inset-x-0 top-[9%] flex justify-center">
          <div
            style={{ ...box, fontSize: "9cqw", opacity: title ? 1 : 0.45 }}
          >
            {title || "Your Short title"}
          </div>
        </div>

        {/* Artist / track caption — lower area (sample text) */}
        <div className="absolute inset-x-0 bottom-[12%] flex justify-center">
          <div style={{ ...box, fontSize: "9.5cqw" }}>
            <div
              className="uppercase"
              style={{ fontSize: "0.62em", letterSpacing: "0.02em", lineHeight: 1.1 }}
            >
              Artist Name
            </div>
            <div className="uppercase" style={{ lineHeight: 1.02 }}>
              Track Name
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
