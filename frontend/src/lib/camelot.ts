import type { Track } from "@/api/types"

export interface CamelotKey {
  number: number
  letter: "A" | "B"
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
