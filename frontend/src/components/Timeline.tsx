import { useEffect, useRef } from "react"
import WaveSurfer from "wavesurfer.js"
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js"
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js"
import type { Drop, Track } from "@/api/types"
import { trackVideoUrl } from "@/api/client"
import { useEffectiveTheme } from "@/lib/theme"

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
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<RegionsPlugin | null>(null)
  const startRegionRef = useRef<Region | null>(null)
  const endRegionRef = useRef<Region | null>(null)
  const selectionRegionRef = useRef<Region | null>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  const theme = useEffectiveTheme()

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
      height: 120,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      url: trackVideoUrl(track.id),
      plugins: [regions, timeline],
    })

    wsRef.current = ws
    regionsRef.current = regions

    ws.on("ready", () => {
      // Waveform is visual-only — the master <video> is the audio source.
      ws.setVolume(0)
      const duration = ws.getDuration()
      const startEnd = Math.min(dropStart + 0.05, duration)
      const startRegion = regions.addRegion({
        id: "drop_start",
        start: dropStart,
        end: startEnd,
        color: "rgba(34, 197, 94, 0.35)",
        drag: true,
        resize: false,
      })
      const endRegion = regions.addRegion({
        id: "drop_end",
        start: Math.max(0, dropEnd - 0.05),
        end: Math.min(duration, dropEnd),
        color: "rgba(239, 68, 68, 0.35)",
        drag: true,
        resize: false,
      })
      startRegionRef.current = startRegion
      endRegionRef.current = endRegion

      // A 0.05s region is sub-pixel at full-track zoom — rebuild each marker
      // element into a DAW-style trim handle: a slim glowing line spanning the
      // waveform with a rounded grip knob on top. Inline styles because the
      // waveform lives in a shadow root that outside CSS can't reach.
      const styleHandle = (r: Region, rgb: string, gripTop: boolean) => {
        const el = (r as unknown as { element?: HTMLElement }).element
        if (!el) return
        Object.assign(el.style, {
          minWidth: "18px",
          marginLeft: "-9px",
          background: "transparent",
          cursor: "ew-resize",
          zIndex: "6",
        })
        el.innerHTML = `
          <div style="position:absolute;top:0;bottom:0;left:50%;width:2px;
            transform:translateX(-50%);border-radius:1px;
            background:rgba(${rgb},0.95);
            box-shadow:0 0 8px rgba(${rgb},0.7);"></div>
          <div style="position:absolute;${gripTop ? "top:2px" : "bottom:2px"};left:50%;
            transform:translateX(-50%);width:14px;height:18px;border-radius:7px;
            background:linear-gradient(180deg,rgba(${rgb},1),rgba(${rgb},0.75));
            box-shadow:0 1px 4px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.35);
            display:flex;align-items:center;justify-content:center;gap:2px;">
            <span style="width:1.5px;height:8px;border-radius:1px;background:rgba(255,255,255,0.85)"></span>
            <span style="width:1.5px;height:8px;border-radius:1px;background:rgba(255,255,255,0.85)"></span>
          </div>`
        el.onmouseenter = () => (el.style.filter = "brightness(1.25)")
        el.onmouseleave = () => (el.style.filter = "")
      }
      styleHandle(startRegion, "52, 211, 153", true)
      styleHandle(endRegion, "251, 113, 133", false)

      // Shaded DAW-style selection band between the trim markers.
      selectionRegionRef.current = regions.addRegion({
        id: "selection",
        start: dropStart,
        end: Math.min(duration, dropEnd),
        color: "rgba(168, 85, 247, 0.12)",
        drag: false,
        resize: false,
      })

      // Each detected drop gets its own non-draggable highlight band.
      const drops = track.analysis?.drops ?? []
      drops.forEach((d: Drop, i: number) => {
        regions.addRegion({
          id: `drop_${i}`,
          start: d.start_s,
          end: Math.min(duration, d.end_s),
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

    // Snap a dragged marker to the nearest downbeat when within 0.2s of one,
    // so manual trims still land on bar lines (like the auto-detected cuts).
    const snap = (t: number): number => {
      const dbs = track.analysis?.downbeats
      if (!dbs?.length) return t
      const nearest = dbs.reduce((a, b) =>
        Math.abs(b - t) < Math.abs(a - t) ? b : a,
      )
      return Math.abs(nearest - t) <= 0.2 ? nearest : t
    }

    subs.push(
      regions.on("region-updated", (region) => {
        if (region.id === "drop_start") {
          const snapped = snap(region.start)
          if (Math.abs(snapped - region.start) > 0.001) {
            region.setOptions({ start: snapped, end: snapped + 0.05 })
          }
          const end = endRegionRef.current?.start ?? dropEnd
          onChangeRef.current({
            dropStart: Math.min(snapped, end - 1),
            dropEnd: end,
          })
        } else if (region.id === "drop_end") {
          const snapped = snap(region.start)
          if (Math.abs(snapped - region.start) > 0.001) {
            region.setOptions({ start: snapped, end: snapped + 0.05 })
          }
          const start = startRegionRef.current?.start ?? dropStart
          onChangeRef.current({
            dropStart: start,
            dropEnd: Math.max(snapped, start + 1),
          })
        }
      }),
    )

    return () => {
      subs.forEach((u) => u())
      ws.destroy()
      wsRef.current = null
      regionsRef.current = null
      startRegionRef.current = null
      endRegionRef.current = null
      selectionRegionRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, theme])

  useEffect(() => {
    const s = startRegionRef.current
    if (s && Math.abs(s.start - dropStart) > 0.01) {
      s.setOptions({ start: dropStart, end: dropStart + 0.05 })
    }
    selectionRegionRef.current?.setOptions({ start: dropStart, end: dropEnd })
  }, [dropStart, dropEnd])

  useEffect(() => {
    const e = endRegionRef.current
    if (e && Math.abs(e.start - dropEnd) > 0.01) {
      e.setOptions({ start: dropEnd - 0.05, end: dropEnd })
    }
  }, [dropEnd])

  useEffect(() => {
    const ws = wsRef.current
    if (!ws || externalTime === undefined) return
    const cur = ws.getCurrentTime()
    if (Math.abs(cur - externalTime) > 0.25) {
      const dur = ws.getDuration()
      if (dur > 0) ws.seekTo(externalTime / dur)
    }
  }, [externalTime])

  return (
    <div className="relative w-full">
      <div ref={containerRef} className="w-full rounded-md bg-card p-2" />
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
