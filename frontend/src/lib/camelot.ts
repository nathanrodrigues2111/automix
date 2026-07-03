import type { Track } from "@/api/types"

export interface CamelotKey {
  number: number
  letter: "A" | "B"
}

// Map Camelot number → hue (Mixed-In-Key-inspired wheel):
//  1=red-orange, 2=orange, 3=yellow, 4=lime, 5=green, 6=teal,
//  7=cyan, 8=blue, 9=indigo, 10=purple, 11=magenta, 12=pink-red
export function camelotHue(num: number): number {
  return ((num - 1) * 30 + 10) % 360
}

export interface CamelotColors {
  bg: string
  fg: string
  border: string
}

export function camelotColors(
  key: string | null | undefined,
  scheme: "light" | "dark" = "dark",
): CamelotColors | null {
  const k = parseCamelot(key)
  if (!k) return null
  const hue = camelotHue(k.number)
  const sat = k.letter === "A" ? 55 : 78
  const lt = k.letter === "A" ? 52 : 62
  if (scheme === "light") {
    // Darker text on a soft tint so chips stay readable on light surfaces.
    return {
      bg: `hsl(${hue} ${sat}% ${lt}% / 0.14)`,
      fg: `hsl(${hue} ${Math.min(100, sat + 12)}% ${Math.max(24, lt - 24)}%)`,
      border: `hsl(${hue} ${sat}% ${lt}% / 0.45)`,
    }
  }
  return {
    bg: `hsl(${hue} ${sat}% ${lt}% / 0.18)`,
    fg: `hsl(${hue} ${Math.min(100, sat + 20)}% ${Math.min(85, lt + 28)}%)`,
    border: `hsl(${hue} ${sat}% ${lt}% / 0.5)`,
  }
}

export function parseCamelot(key: string | undefined | null): CamelotKey | null {
  if (!key) return null
  const m = /^(\d{1,2})([AB])$/i.exec(key.trim())
  if (!m) return null
  const num = parseInt(m[1], 10)
  if (num < 1 || num > 12) return null
  return { number: num, letter: m[2].toUpperCase() as "A" | "B" }
}

export function camelotDistance(a: CamelotKey, b: CamelotKey): number {
  const same = a.letter === b.letter
  const diff = Math.min(
    (a.number - b.number + 12) % 12,
    (b.number - a.number + 12) % 12,
  )
  if (same) return diff
  return diff === 0 ? 1 : diff + 1
}

export function isCamelotCompatible(a: string, b: string): boolean {
  const pa = parseCamelot(a)
  const pb = parseCamelot(b)
  if (!pa || !pb) return false
  return camelotDistance(pa, pb) <= 1
}

export function autoOrderTracks<T extends { analysis: Track["analysis"] }>(
  items: T[],
): T[] {
  const analyzed = items.filter((t) => t.analysis)
  const unanalyzed = items.filter((t) => !t.analysis)
  if (analyzed.length <= 1) return [...analyzed, ...unanalyzed]

  const sorted = [...analyzed].sort(
    (a, b) => (a.analysis!.bpm ?? 0) - (b.analysis!.bpm ?? 0),
  )

  const result: T[] = [sorted.shift()!]
  while (sorted.length > 0) {
    const last = result[result.length - 1].analysis!.key_camelot
    let bestIdx = 0
    let bestDist = Number.POSITIVE_INFINITY
    sorted.forEach((cand, idx) => {
      const pa = parseCamelot(last)
      const pb = parseCamelot(cand.analysis!.key_camelot)
      if (!pa || !pb) return
      const dist = camelotDistance(pa, pb)
      if (dist < bestDist) {
        bestDist = dist
        bestIdx = idx
      }
    })
    result.push(sorted.splice(bestIdx, 1)[0])
  }

  return [...result, ...unanalyzed]
}
