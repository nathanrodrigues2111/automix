import { useEffect, useRef, useState } from "react"
import WaveSurfer from "wavesurfer.js"
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js"
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js"
import type { Drop, Track } from "@/api/types"
import { trackVideoUrl } from "@/api/client"
import { useEffectiveTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

/** Minimum selection length in seconds. */
const MIN_GAP_S = 1
/** Snap a dragged handle to a downbeat when within this window. */
const SNAP_WINDOW_S = 0.15
/** Height of the waveform drawing area (matches WaveSurfer `height`). */
const WAVE_HEIGHT = 120

interface TimelineProps {
  track: Track
  dropStart: number
  dropEnd: number
  onChange: (range: { dropStart: number; dropEnd: number }) => void
  /** Called when the user clicks/drags on the waveform to seek (in seconds). */
  onSeek?: (timeSec: number) => void
  /** Time to visually display the playhead at (driven by the master video). */
  externalTime?: number
  onReady?: (wavesurfer: WaveSurfer) => void
}

/** m:ss.cs — precise readout for the drag tooltip. */
function fmtHandleTime(s: number): string {
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${m}:${rest.toFixed(2).padStart(5, "0")}`
}

export function Timeline({
  track,
  dropStart,
  dropEnd,
  onChange,
  onSeek,
  externalTime,
  onReady,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [dragging, setDragging] = useState<"start" | "end" | null>(null)

  const theme = useEffectiveTheme()
  const duration = track.duration_s

  useEffect(() => {
    if (!containerRef.current) return

    const isDark = theme === "dark"
    const regions = RegionsPlugin.create()
    const timeline = TimelinePlugin.create({
      height: 18,
      timeInterval: 10,
      primaryLabelInterval: 30,
      style: {
        fontSize: "10px",
        color: isDark ? "rgba(255,255,255,0.5)" : "rgba(24,24,34,0.55)",
      },
    })

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "rgba(168, 85, 247, 0.55)",
      progressColor: "rgba(168, 85, 247, 0.95)",
      cursorColor: isDark ? "rgba(255,255,255,0.8)" : "rgba(24,24,34,0.8)",
      cursorWidth: 2,
      height: WAVE_HEIGHT,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      url: trackVideoUrl(track.id),
      plugins: [regions, timeline],
    })

    wsRef.current = ws

    ws.on("ready", () => {
      // Waveform is visual-only — the master <video> is the audio source.
      ws.setVolume(0)
      const dur = ws.getDuration()

      // Each detected drop gets its own non-draggable highlight band.
      const drops = track.analysis?.drops ?? []
      drops.forEach((d: Drop, i: number) => {
        regions.addRegion({
          id: `drop_${i}`,
          start: d.start_s,
          end: Math.min(dur, d.end_s),
          color: "rgba(251, 191, 36, 0.18)", // amber/yellow tint
          drag: false,
          resize: false,
          content: `D${i + 1}`,
        })
      })

      drawBeatGrid(ws, track)

      onReady?.(ws)
    })

    const subs: Array<() => void> = []

    // User clicks/drags the waveform → seek the video (the master clock).
    // Only listen to `interaction` (user-initiated). `seeking` also fires on
    // programmatic seekTo, which would create a feedback loop with externalTime.
    subs.push(
      ws.on("interaction", (newTime) => {
        onSeek?.(newTime)
      }),
    )

    return () => {
      subs.forEach((u) => u())
      ws.destroy()
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, theme])

  useEffect(() => {
    const ws = wsRef.current
    if (!ws || externalTime === undefined) return
    const cur = ws.getCurrentTime()
    if (Math.abs(cur - externalTime) > 0.25) {
      const dur = ws.getDuration()
      if (dur > 0) ws.seekTo(externalTime / dur)
    }
  }, [externalTime])

  // ---- Manual trim handles -------------------------------------------------

  const timeFromClientX = (clientX: number): number => {
    const el = overlayRef.current
    if (!el || duration <= 0) return 0
    const rect = el.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return frac * duration
  }

  const snapToDownbeat = (t: number): number => {
    const downbeats = track.analysis?.downbeats
    if (!downbeats?.length) return t
    let best = t
    let bestDiff = SNAP_WINDOW_S
    for (const d of downbeats) {
      const diff = Math.abs(d - t)
      if (diff < bestDiff) {
        bestDiff = diff
        best = d
      }
    }
    return best
  }

  const applyHandleTime = (which: "start" | "end", t: number) => {
    if (which === "start") {
      const next = Math.min(Math.max(0, t), dropEnd - MIN_GAP_S)
      if (Math.abs(next - dropStart) < 0.005) return // snap makes moves sticky
      onChange({ dropStart: next, dropEnd })
    } else {
      const next = Math.max(Math.min(duration, t), dropStart + MIN_GAP_S)
      if (Math.abs(next - dropEnd) < 0.005) return
      onChange({ dropStart, dropEnd: next })
    }
  }

  const startPct = duration > 0 ? (dropStart / duration) * 100 : 0
  const endPct = duration > 0 ? (dropEnd / duration) * 100 : 0

  return (
    <div className="relative w-full">
      <div ref={containerRef} className="w-full rounded-md bg-card p-2" />

      {duration > 0 && (
        <div
          ref={overlayRef}
          className="pointer-events-none absolute left-2 right-2 top-2 z-10"
          style={{ height: WAVE_HEIGHT }}
        >
          {/* Shaded selection between the trim handles, DAW-style. */}
          <div
            aria-hidden
            className="absolute inset-y-0 bg-primary/10 ring-1 ring-inset ring-primary/25"
            style={{
              left: `${startPct}%`,
              width: `${Math.max(0, endPct - startPct)}%`,
            }}
          />

          {(["start", "end"] as const).map((which) => {
            const t = which === "start" ? dropStart : dropEnd
            const pct = duration > 0 ? (t / duration) * 100 : 0
            const isStart = which === "start"
            const isDraggingThis = dragging === which
            return (
              <div
                key={which}
                role="slider"
                tabIndex={0}
                aria-label={isStart ? "Trim start" : "Trim end"}
                aria-valuemin={0}
                aria-valuemax={Math.round(duration)}
                aria-valuenow={Math.round(t)}
                aria-valuetext={fmtHandleTime(t)}
                title={`${isStart ? "Start" : "End"} · drag to trim (Shift = no snap)`}
                className="group pointer-events-auto absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize touch-none outline-none"
                style={{ left: `${pct}%` }}
                onPointerDown={(e) => {
                  e.preventDefault()
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setDragging(which)
                }}
                onPointerMove={(e) => {
                  if (dragging !== which) return
                  const raw = timeFromClientX(e.clientX)
                  applyHandleTime(which, e.shiftKey ? raw : snapToDownbeat(raw))
                }}
                onPointerUp={() => setDragging(null)}
                onPointerCancel={() => setDragging(null)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
                  e.preventDefault()
                  const step = e.shiftKey ? 1 : 0.1
                  const delta = e.key === "ArrowLeft" ? -step : step
                  applyHandleTime(which, t + delta)
                }}
              >
                {/* Grab bar */}
                <div
                  className={cn(
                    "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-[width,background-color]",
                    isStart ? "bg-emerald-500/80" : "bg-rose-500/80",
                    "group-hover:w-1 group-focus-visible:w-1",
                    isDraggingThis && "w-1",
                  )}
                />
                {/* Grip nub */}
                <div
                  className={cn(
                    "absolute left-1/2 h-3.5 w-2.5 -translate-x-1/2 rounded-sm ring-1 ring-black/20",
                    isStart ? "top-0 bg-emerald-500" : "bottom-0 bg-rose-500",
                    "group-focus-visible:ring-2 group-focus-visible:ring-ring",
                  )}
                />
                {/* Time tooltip while dragging */}
                {isDraggingThis && (
                  <div className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border/60 bg-popover px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-popover-foreground shadow-md">
                    {fmtHandleTime(t)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function drawBeatGrid(ws: WaveSurfer, track: Track) {
  if (!track.analysis) return
  const wrapper = (ws as unknown as { getWrapper?: () => HTMLElement | null }).getWrapper?.()
  if (!wrapper) return
  const duration = ws.getDuration()
  if (duration <= 0) return

  let overlay = wrapper.querySelector<HTMLDivElement>(".beat-grid-overlay")
  if (!overlay) {
    overlay = document.createElement("div")
    overlay.className = "beat-grid-overlay"
    Object.assign(overlay.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      zIndex: "3",
    })
    wrapper.appendChild(overlay)
  }
  overlay.innerHTML = ""

  const fragment = document.createDocumentFragment()
  // Only render downbeats — every-beat ticks are too dense across a full track.
  track.analysis.downbeats.forEach((t) => {
    const tick = document.createElement("div")
    Object.assign(tick.style, {
      position: "absolute",
      top: "0",
      bottom: "0",
      width: "1px",
      left: `${(t / duration) * 100}%`,
      background: "rgba(250, 204, 21, 0.35)",
    })
    fragment.appendChild(tick)
  })
  overlay.appendChild(fragment)
}
