import { useEffect, useRef } from "react"
import WaveSurfer from "wavesurfer.js"
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js"
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js"
import type { Track } from "@/api/types"
import { trackVideoUrl } from "@/api/client"

interface TimelineProps {
  track: Track
  dropStart: number
  dropEnd: number
  onChange: (range: { dropStart: number; dropEnd: number }) => void
  onTimeUpdate?: (currentTime: number) => void
  onReady?: (wavesurfer: WaveSurfer) => void
  externalTime?: number
}

export function Timeline({
  track,
  dropStart,
  dropEnd,
  onChange,
  onTimeUpdate,
  onReady,
  externalTime,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const regionsRef = useRef<RegionsPlugin | null>(null)
  const startRegionRef = useRef<Region | null>(null)
  const endRegionRef = useRef<Region | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!containerRef.current) return

    const regions = RegionsPlugin.create()
    const timeline = TimelinePlugin.create({
      height: 20,
      timeInterval: 1,
      primaryLabelInterval: 5,
      style: { fontSize: "10px", color: "rgba(255,255,255,0.6)" },
    })

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: "rgba(168, 85, 247, 0.55)",
      progressColor: "rgba(168, 85, 247, 0.95)",
      cursorColor: "rgba(255,255,255,0.8)",
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

      drawBeatGrid(ws, track)

      onReady?.(ws)
    })

    const subs: Array<() => void> = []

    subs.push(
      ws.on("timeupdate", (t) => {
        onTimeUpdate?.(t)
      }),
    )

    subs.push(
      regions.on("region-updated", (region) => {
        if (region.id === "drop_start") {
          onChangeRef.current({
            dropStart: region.start,
            dropEnd: endRegionRef.current?.start ?? dropEnd,
          })
        } else if (region.id === "drop_end") {
          onChangeRef.current({
            dropStart: startRegionRef.current?.start ?? dropStart,
            dropEnd: region.start,
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id])

  useEffect(() => {
    const s = startRegionRef.current
    if (s && Math.abs(s.start - dropStart) > 0.01) {
      s.setOptions({ start: dropStart, end: dropStart + 0.05 })
    }
  }, [dropStart])

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
  const downbeats = new Set(track.analysis.downbeats)
  track.analysis.beats.forEach((t) => {
    const isDownbeat = downbeats.has(t)
    const tick = document.createElement("div")
    Object.assign(tick.style, {
      position: "absolute",
      top: "0",
      bottom: "0",
      width: "1px",
      left: `${(t / duration) * 100}%`,
      background: isDownbeat
        ? "rgba(250, 204, 21, 0.55)"
        : "rgba(255,255,255,0.12)",
    })
    fragment.appendChild(tick)
  })
  overlay.appendChild(fragment)
}
