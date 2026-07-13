import { useEffect } from "react"
import { useFonts } from "@/api/client"
import { ensureFontLoaded } from "@/lib/fonts"
import type { CSSProperties } from "react"
import type { FontInfo, RenderConfig } from "@/api/types"

/**
 * A lightweight, self-contained mockup of the rendered vertical Short's
 * caption layout. NOT a real render — a 9:16 placeholder approximating how
 * the title (top) and track (bottom) captions will look, updating live as the
 * Short title / font / artist toggle change. Uses `box-decoration-break:clone`
 * so each wrapped line gets its own rounded box (the TikTok/CapCut look), and
 * container-query units (cqw) so it scales with the frame.
 */
export function ShortPreview({ config }: { config: Omit<RenderConfig, "clips"> }) {
  const fonts = useFonts()
  const list = fonts.data?.fonts ?? []

  const find = (id?: string | null): FontInfo | undefined =>
    id ? list.find((f) => f.id === id) : undefined
  const resolved = find(config.short_font) ?? find(config.title_font) ?? find(fonts.data?.default)
  const family = resolved?.family ?? "sans-serif"

  useEffect(() => {
    if (resolved) void ensureFontLoaded(resolved).catch(() => {})
  }, [resolved])

  const title = (config.short_title ?? "").trim()
  const showArtist = config.short_show_artist ?? false

  // Per-line rounded box: `box-decoration-break: clone` clones the background,
  // padding and radius onto every wrapped line, hugging each line's width.
  const chip = (fontSize: string, opacity = 1): CSSProperties => ({
    fontFamily: `'${family}', sans-serif`,
    fontWeight: 800,
    color: "#000",
    background: "#fff",
    padding: "0.1em 0.42em",
    borderRadius: "0.4em",
    boxDecorationBreak: "clone",
    WebkitBoxDecorationBreak: "clone",
    fontSize,
    opacity,
  })

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
        {/* Title — upper area */}
        <div
          className="absolute inset-x-0 top-[9%] px-[7%] text-center"
          style={{ lineHeight: 1.5 }}
        >
          <span style={chip("9cqw", title ? 1 : 0.45)}>
            {title || "Your Short title"}
          </span>
        </div>

        {/* Track name (+ optional artist) — lower area (sample text) */}
        <div
          className="absolute inset-x-0 bottom-[13%] px-[7%] text-center"
          style={{ lineHeight: 1.5 }}
        >
          <span className="uppercase" style={chip("9.5cqw")}>
            {showArtist && (
              <>
                <span style={{ fontSize: "0.62em" }}>Artist Name</span>
                <br />
              </>
            )}
            Track Name
          </span>
        </div>
      </div>
    </div>
  )
}
