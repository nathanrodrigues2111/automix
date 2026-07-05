/** User-selectable accent color: overrides the theme's --primary/--ring on
 *  the root element (wins in both light and dark). Persisted locally. */

export interface AccentPreset {
  name: string
  /** oklch() color used for --primary and --ring. */
  value: string
}

export const ACCENTS: AccentPreset[] = [
  { name: "Violet", value: "oklch(0.606 0.25 292.717)" },
  { name: "Purple", value: "oklch(0.627 0.265 303.9)" },
  { name: "Fuchsia", value: "oklch(0.667 0.295 322.15)" },
  { name: "Pink", value: "oklch(0.656 0.241 354.308)" },
  { name: "Rose", value: "oklch(0.645 0.246 16.439)" },
  { name: "Red", value: "oklch(0.637 0.237 25.331)" },
  { name: "Orange", value: "oklch(0.705 0.213 47.604)" },
  { name: "Amber", value: "oklch(0.769 0.188 70.08)" },
  { name: "Lime", value: "oklch(0.768 0.233 130.85)" },
  { name: "Emerald", value: "oklch(0.696 0.17 162.48)" },
  { name: "Teal", value: "oklch(0.704 0.14 182.503)" },
  { name: "Cyan", value: "oklch(0.715 0.143 215.221)" },
  { name: "Sky", value: "oklch(0.685 0.169 237.323)" },
  { name: "Blue", value: "oklch(0.623 0.214 259.815)" }, // app default
  { name: "Indigo", value: "oklch(0.585 0.233 277.117)" },
]

/** The accent used when nothing is stored (a stored value always wins). */
export const DEFAULT_ACCENT_NAME = "Blue"
export const DEFAULT_ACCENT =
  ACCENTS.find((a) => a.name === DEFAULT_ACCENT_NAME)?.value ?? ACCENTS[0].value

/** True when `value` is one of the built-in presets. */
export function isPresetAccent(value: string | null): boolean {
  return !value || ACCENTS.some((a) => a.value === value)
}

const KEY = "automix.accent.v1"

// Original favicon markup, fetched once so it can be recolored per accent.
let faviconSvg: string | null = null

async function updateFavicon(value: string | null): Promise<void> {
  const link = document.querySelector<HTMLLinkElement>("link[rel='icon']")
  if (!link) return
  if (!value) {
    link.href = `${import.meta.env.BASE_URL}favicon.svg`
    return
  }
  if (faviconSvg == null) {
    try {
      faviconSvg = await (await fetch(`${import.meta.env.BASE_URL}favicon.svg`)).text()
    } catch {
      return
    }
  }
  const recolored = faviconSvg
    .replaceAll("#863bff", value)
    .replace(/color\(display-p3[^)]*\)/g, value)
  link.href = "data:image/svg+xml," + encodeURIComponent(recolored)
}

export function applyAccent(value: string | null): void {
  const root = document.documentElement
  const v = value ?? DEFAULT_ACCENT
  root.style.setProperty("--primary", v)
  root.style.setProperty("--ring", v)
  void updateFavicon(v)
  // Canvas-based UI (e.g. the timeline waveform) can't use CSS vars; let it
  // know the accent changed so it can re-resolve its colors.
  window.dispatchEvent(new CustomEvent("automix:accent"))
}

/** Resolve the CURRENT accent (--primary) to [r, g, b]. Canvas colors can't
 *  reference CSS vars, and the value is an oklch() string, so it's rendered
 *  onto a 1x1 canvas and read back. Falls back to the default Blue. */
export function accentRgb(): [number, number, number] {
  const fallback: [number, number, number] = [59, 130, 246]
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue("--primary")
      .trim()
    if (!v) return fallback
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return fallback
    ctx.fillStyle = v
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2]]
  } catch {
    return fallback
  }
}

export function loadAccent(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function setAccent(value: string | null): void {
  try {
    if (value) localStorage.setItem(KEY, value)
    else localStorage.removeItem(KEY)
  } catch {
    // storage unavailable — accent just won't persist
  }
  applyAccent(value)
}

/** Apply the persisted accent once at startup. */
export function initAccent(): void {
  applyAccent(loadAccent())
}
