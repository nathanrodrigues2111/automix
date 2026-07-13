import { useEffect } from "react"
import { useFonts } from "@/api/client"
import { ensureFontLoaded } from "@/lib/fonts"
import type { FontInfo, RenderConfig } from "@/api/types"

/**
 * A lightweight, self-contained mockup of the rendered vertical Short's
 * caption layout. It is NOT a real render — just a 9:16 placeholder that
 * approximates how the title and artist/track boxes will look, updating
 * live as the Short settings (title text, font) change.
 */
export function ShortPreview({ config }: { config: Omit<RenderConfig, "clips"> }) {
  const fonts = useFonts()
  const list = fonts.data?.fonts ?? []

  // Resolve the Short's font: prefer short_font, fall back to the video
  // title font, else the backend default.
  const find = (id?: string | null): FontInfo | undefined =>
    id ? list.find((f) => f.id === id) : undefined
  const resolved =
    find(config.short_font) ??
    find(config.title_font) ??
    find(fonts.data?.default)
  const family = resolved?.family ?? "sans-serif"

  // Load the resolved font into the document so it renders in its real face.
  useEffect(() => {
    if (resolved) void ensureFontLoaded(resolved).catch(() => {})
  }, [resolved])

  const title = (config.short_title ?? "").trim()
  const fontStack = `'${family}', sans-serif`

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Preview
      </div>
      <div
        className="relative mx-auto aspect-[9/16] max-h-[420px] w-auto overflow-hidden rounded-xl border border-border/60"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 12%, #1a0b0b 0%, #12131a 45%, #060608 100%)",
        }}
        aria-label="Short caption preview"
      >
        {/* Title caption — top third */}
        <div className="absolute inset-x-0 top-[14%] flex justify-center px-5">
          {title ? (
            <div
              className="max-w-full rounded-2xl bg-white px-4 py-2 text-center font-extrabold leading-tight text-black"
              style={{
                fontFamily: fontStack,
                fontWeight: 800,
                fontSize: "clamp(13px, 4.2vw, 20px)",
              }}
            >
              {title}
            </div>
          ) : (
            <div
              className="max-w-full rounded-2xl bg-white/40 px-4 py-2 text-center font-extrabold leading-tight text-black/50"
              style={{
                fontFamily: fontStack,
                fontWeight: 800,
                fontSize: "clamp(13px, 4.2vw, 20px)",
              }}
            >
              Your Short title
            </div>
          )}
        </div>

        {/* Artist / track caption — lower third (sample text) */}
        <div className="absolute inset-x-0 bottom-[16%] flex justify-center px-5">
          <div
            className="max-w-full rounded-2xl bg-white px-4 py-2 text-center text-black"
            style={{ fontFamily: fontStack, fontWeight: 800 }}
          >
            <div
              className="uppercase leading-tight tracking-wide"
              style={{ fontSize: "clamp(10px, 3vw, 15px)" }}
            >
              Artist Name
            </div>
            <div
              className="uppercase leading-tight"
              style={{ fontSize: "clamp(15px, 5vw, 24px)" }}
            >
              Track Name
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
