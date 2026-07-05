import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import WaveSurfer from "wavesurfer.js"
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js"
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js"
import { Maximize2, Pause, Play, ZoomIn, ZoomOut } from "lucide-react"
import type { MediaPlayerInstance } from "@vidstack/react"
import type { Drop, Track } from "@/api/types"
import { trackVideoUrl } from "@/api/client"
import { accentRgb } from "@/lib/accent"
import { apiUrl } from "@/lib/backend"
import { useEffectiveTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

/** Waveform tint derived from the CURRENT accent color: the body fades from
 *  the accent down to a soft wash, and played audio brightens toward white. */
function waveAccentColors() {
  const [r, g, b] = accentRgb()
  const lift = (c: number) => Math.round(c + (255 - c) * 0.4)
  return {
    waveColor: [`rgba(${r}, ${g}, ${b}, 0.75)`, `rgba(${r}, ${g}, ${b}, 0.3)`],
    progressColor: [
      `rgba(${lift(r)}, ${lift(g)}, ${lift(b)}, 1)`,
      `rgba(${r}, ${g}, ${b}, 0.75)`,
    ],
  }
}

/** Minimum selection length in seconds. */
const MIN_GAP_S = 1
/** Snap a dragged handle to a downbeat when within this window. */
const SNAP_WINDOW_S = 0.15
/** Height of the waveform drawing area (matches WaveSurfer `height`). */
const WAVE_HEIGHT = 72
/** Hard ceiling for zoom, in pixels per second of audio. */
const MAX_PX_PER_SEC = 300
/** Initial zoom relative to fit-to-width. */
const DEFAULT_ZOOM = 4.8

interface TimelineProps {
  track: Track
  dropStart: number
  dropEnd: number
  onChange: (range: { dropStart: number; dropEnd: number }) => void
  /** Called when the user clicks/drags on the waveform to seek (in seconds). */
  onSeek?: (timeSec: number) => void
  /** Time to visually display the playhead at (driven by the master video). */
  externalTime?: number
  /** Master video playback state — drives the smooth playhead + follow. */
  isPlaying?: boolean
  /** Toggle play/pause on the master video. */
  onTogglePlay?: () => void
  /** Returns the master video player, for frame-accurate playhead reads.
   *  A getter (not the instance) so the player object never sits in React
   *  state/props where dev tooling would enumerate its throwing getters. */
  getMediaPlayer?: () => MediaPlayerInstance | null
  /** Extra controls rendered in the toolbar (e.g. "Add selection"). */
  actions?: ReactNode
  onReady?: (wavesurfer: WaveSurfer) => void
}

/** Scroll/zoom geometry of the waveform, mirrored into React state so the
 *  trim overlay (regular DOM — WaveSurfer renders in a shadow root where our
 *  stylesheet can't reach) can track the zoomed waveform in pixels. */
interface ViewGeom {
  scroll: number
  totalW: number
  visibleW: number
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
  isPlaying = false,
  onTogglePlay,
  getMediaPlayer,
  actions,
  onReady,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const [dragging, setDragging] = useState<"start" | "end" | null>(null)
  // Mirrored into a ref so the playhead-follow loops can check it without
  // re-subscribing: while a handle is being dragged, the view must not move.
  const draggingRef = useRef<"start" | "end" | null>(null)
  draggingRef.current = dragging
  const [view, setView] = useState<ViewGeom>({ scroll: 0, totalW: 0, visibleW: 0 })
  // True while the user is drag-panning the waveform view.
  const [panning, setPanning] = useState(false)
  const panningRef = useRef(false)
  // After a manual pan the view must stay where the user put it — follow
  // resumes on the next seek or when playback is (re)started.
  const followSuspendedRef = useRef(false)
  // Swallow the click WaveSurfer would turn into a seek right after a pan.
  const suppressClickRef = useRef(false)
  // null = fit the whole track to the container width (no h-scroll).
  const [pxPerSec, setPxPerSec] = useState<number | null>(null)
  // True until WaveSurfer has decoded and drawn the waveform.
  const [loading, setLoading] = useState(true)

  const theme = useEffectiveTheme()
  const duration = track.duration_s

  const fitPps = useCallback(() => {
    const w = containerRef.current?.clientWidth ?? 800
    return w / Math.max(1, duration)
  }, [duration])

  const syncView = useCallback(() => {
    const ws = wsRef.current
    const cont = containerRef.current
    if (!ws || !cont) return
    let totalW = 0
    try {
      totalW = ws.getWrapper().clientWidth
    } catch {
      return
    }
    const scroll = ws.getScroll()
    const visibleW = cont.clientWidth
    setView((prev) =>
      prev.scroll === scroll && prev.totalW === totalW && prev.visibleW === visibleW
        ? prev
        : { scroll, totalW, visibleW },
    )
  }, [])

  /** Scroll so the playhead stays visible. `lock` keeps it centered (used
   *  every frame during playback for a butter-smooth DAW-style follow). */
  const followPlayhead = useCallback(
    (t: number, lock = false) => {
      const ws = wsRef.current
      const cont = containerRef.current
      if (!ws || !cont) return
      if (panningRef.current || followSuspendedRef.current) return
      const dur = ws.getDuration()
      if (dur <= 0) return
      const total = ws.getWrapper().clientWidth
      const visible = cont.clientWidth
      if (total <= visible + 1) return // fully fits — nothing to follow
      const px = (t / dur) * total
      const scroll = ws.getScroll()
      if (lock) {
        const target = Math.min(Math.max(0, px - visible / 2), total - visible)
        if (Math.abs(target - scroll) > 0.5) ws.setScroll(target)
        return
      }
      const margin = visible * 0.1
      if (px < scroll + margin || px > scroll + visible - margin) {
        ws.setScroll(Math.max(0, px - visible * 0.3))
      }
      syncView()
    },
    [syncView],
  )

  useEffect(() => {
    if (!containerRef.current) return

    const isDark = theme === "dark"
    const regions = RegionsPlugin.create()
    const timeline = TimelinePlugin.create({
      height: 16,
      timeInterval: 10,
      primaryLabelInterval: 30,
      style: {
        fontSize: "10px",
        color: isDark ? "rgba(255,255,255,0.5)" : "rgba(24,24,34,0.55)",
      },
    })

    let cancelled = false
    const ws = WaveSurfer.create({
      container: containerRef.current,
      ...waveAccentColors(),
      cursorColor: isDark ? "rgba(255,255,255,0.85)" : "rgba(24,24,34,0.85)",
      cursorWidth: 2,
      height: WAVE_HEIGHT,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      // Scrolling is owned by followPlayhead(); wavesurfer's built-in
      // autoScroll also fires on programmatic seeks (e.g. while dragging a
      // trim handle auditions the edit), which would yank the view around.
      autoScroll: false,
      plugins: [regions, timeline],
    })

    // Server-side peaks instead of downloading + decoding the source media
    // in the browser: a 4K hour-long set is 300MB+ and kills the tab. The
    // waveform is visual-only anyway. Fall back to client decode if the
    // peaks endpoint fails.
    fetch(apiUrl(`/api/tracks/${track.id}/waveform`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((peaks: { channels: number[][] }) => {
        if (cancelled) return
        const ch = peaks.channels?.[0]
        if (!ch?.length) throw new Error("empty peaks")
        void ws.load("", [ch], track.duration_s)
      })
      .catch(() => {
        if (!cancelled) void ws.load(trackVideoUrl(track.id))
      })

    wsRef.current = ws
    setPxPerSec(null)
    setLoading(true)

    ws.on("ready", () => {
      setLoading(false)
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
      syncView()

      // Start zoomed in — the follow-playhead scroll keeps the view useful.
      setPxPerSec(Math.min(MAX_PX_PER_SEC, DEFAULT_ZOOM * fitPps()))

      onReady?.(ws)
    })

    const subs: Array<() => void> = []

    // User clicks/drags the waveform → seek the video (the master clock).
    // Only listen to `interaction` (user-initiated). `seeking` also fires on
    // programmatic seekTo, which would create a feedback loop with externalTime.
    subs.push(
      ws.on("interaction", (newTime) => {
        followSuspendedRef.current = false
        onSeek?.(newTime)
      }),
    )
    subs.push(ws.on("scroll", syncView))
    subs.push(ws.on("zoom", syncView))
    subs.push(ws.on("redrawcomplete", syncView))

    // Re-tint the waveform in place when the user picks a new accent.
    const onAccent = () => ws.setOptions(waveAccentColors())
    window.addEventListener("automix:accent", onAccent)
    subs.push(() => window.removeEventListener("automix:accent", onAccent))

    return () => {
      cancelled = true
      subs.forEach((u) => u())
      ws.destroy()
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id, theme])

  // Coarse sync while paused (seeks, drop previews). The rAF loop below owns
  // the playhead while playing.
  useEffect(() => {
    const ws = wsRef.current
    if (!ws || externalTime === undefined || isPlaying) return
    const cur = ws.getCurrentTime()
    if (Math.abs(cur - externalTime) > 0.25) {
      const dur = ws.getDuration()
      if (dur > 0) {
        ws.seekTo(externalTime / dur)
        if (!draggingRef.current) followPlayhead(externalTime)
      }
    }
  }, [externalTime, isPlaying, followPlayhead])

  // Smooth playhead: while playing, read the actual <video> clock every
  // animation frame (the React-level time updates are throttled to ~5fps)
  // and keep the view center-locked on the playhead when zoomed in.
  useEffect(() => {
    if (!isPlaying || !getMediaPlayer) return
    followSuspendedRef.current = false // (re)starting playback re-engages follow
    let raf = 0
    const tick = () => {
      const player = getMediaPlayer()
      const ws = wsRef.current
      if (player && ws && ws.getDuration() > 0) {
        const videoEl = player.el?.querySelector("video")
        const t = videoEl ? videoEl.currentTime : player.currentTime
        ws.setTime(t)
        if (!draggingRef.current) followPlayhead(t, true)
        syncView()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, getMediaPlayer, followPlayhead, syncView])

  // ---- Zoom ----------------------------------------------------------------

  const zoomBy = useCallback(
    (factor: number) => {
      setPxPerSec((prev) => {
        const fit = fitPps()
        const next = (prev ?? fit) * factor
        if (next <= fit * 1.01) return null // zoomed out to (or past) fit
        return Math.min(MAX_PX_PER_SEC, next)
      })
    },
    [fitPps],
  )

  // Apply zoom level; keep the playhead in view when the scale changes.
  useEffect(() => {
    const ws = wsRef.current
    if (!ws) return
    try {
      const dur = ws.getDuration()
      if (dur <= 0) return
      const cont = containerRef.current
      // While follow is suspended (user panned away), zoom around the view
      // center instead of snapping back to the playhead.
      const keepCenter = followSuspendedRef.current && cont
      const before = keepCenter
        ? {
            total: ws.getWrapper().clientWidth,
            scroll: ws.getScroll(),
            visible: cont.clientWidth,
          }
        : null
      ws.zoom(pxPerSec ?? fitPps())
      if (before && before.total > 0) {
        const centerFrac = (before.scroll + before.visible / 2) / before.total
        const total = ws.getWrapper().clientWidth
        ws.setScroll(Math.max(0, centerFrac * total - before.visible / 2))
      } else {
        followPlayhead(ws.getCurrentTime(), true)
      }
      syncView()
    } catch {
      // audio not decoded yet — the fit zoom is the default anyway
    }
  }, [pxPerSec, fitPps, followPlayhead, syncView])

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? 1.25 : 0.8)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [zoomBy])

  // ---- Drag to pan -----------------------------------------------------------

  // Drag the waveform horizontally to pan the view when zoomed in. A plain
  // click (below the movement threshold) still falls through as a seek.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const THRESHOLD_PX = 5
    let pan: {
      pointerId: number
      startX: number
      startScroll: number
      moved: boolean
    } | null = null

    const scrollable = () => {
      const ws = wsRef.current
      const cont = containerRef.current
      if (!ws || !cont) return null
      let total = 0
      try {
        total = ws.getWrapper().clientWidth
      } catch {
        return null
      }
      const visible = cont.clientWidth
      return total > visible + 1 ? { ws, max: total - visible } : null
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      const s = scrollable()
      if (!s) return
      pan = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startScroll: s.ws.getScroll(),
        moved: false,
      }
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!pan || e.pointerId !== pan.pointerId) return
      const dx = e.clientX - pan.startX
      if (!pan.moved && Math.abs(dx) < THRESHOLD_PX) return
      const s = scrollable()
      if (!s) return
      if (!pan.moved) {
        pan.moved = true
        panningRef.current = true
        setPanning(true)
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          // capture can fail if the pointer is already gone — pan still works
        }
      }
      s.ws.setScroll(Math.min(s.max, Math.max(0, pan.startScroll - dx)))
      syncView()
    }
    const endPan = (e: PointerEvent) => {
      if (!pan || e.pointerId !== pan.pointerId) return
      if (pan.moved) {
        followSuspendedRef.current = true
        suppressClickRef.current = true
        panningRef.current = false
        setPanning(false)
      }
      pan = null
    }
    // Capture-phase: after a pan, swallow the click before WaveSurfer's own
    // listener (inside its shadow root) turns it into a seek.
    const onClickCapture = (e: MouseEvent) => {
      if (!suppressClickRef.current) return
      suppressClickRef.current = false
      e.preventDefault()
      e.stopPropagation()
    }

    el.addEventListener("pointerdown", onPointerDown)
    el.addEventListener("pointermove", onPointerMove)
    el.addEventListener("pointerup", endPan)
    el.addEventListener("pointercancel", endPan)
    el.addEventListener("click", onClickCapture, true)
    return () => {
      el.removeEventListener("pointerdown", onPointerDown)
      el.removeEventListener("pointermove", onPointerMove)
      el.removeEventListener("pointerup", endPan)
      el.removeEventListener("pointercancel", endPan)
      el.removeEventListener("click", onClickCapture, true)
    }
  }, [syncView])

  // ---- Manual trim handles -------------------------------------------------

  const timeFromClientX = (clientX: number): number => {
    const el = overlayRef.current
    const ws = wsRef.current
    if (!el || duration <= 0) return 0
    const rect = el.getBoundingClientRect()
    let totalW = rect.width
    let scroll = 0
    if (ws) {
      try {
        totalW = ws.getWrapper().clientWidth
        scroll = ws.getScroll()
      } catch {
        // not rendered yet
      }
    }
    if (totalW <= 0) return 0
    const frac = Math.min(1, Math.max(0, (clientX - rect.left + scroll) / totalW))
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

  // Pixel positions of the selection under the current zoom + scroll.
  const totalW = view.totalW > 0 ? view.totalW : (containerRef.current?.clientWidth ?? 0)
  const timeToPx = (t: number) =>
    duration > 0 && totalW > 0 ? (t / duration) * totalW - view.scroll : 0
  const startPx = timeToPx(dropStart)
  const endPx = timeToPx(dropEnd)
  const zoomLabel = pxPerSec ? `${(pxPerSec / fitPps()).toFixed(1)}×` : "Fit"

  return (
    <div className="w-full space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onTogglePlay}
          disabled={!onTogglePlay}
          aria-label={isPlaying ? "Pause" : "Play"}
          title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/12 text-primary ring-1 ring-primary/25 transition-colors hover:bg-primary/20 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {isPlaying ? (
            <Pause className="h-3.5 w-3.5 fill-current" />
          ) : (
            <Play className="h-3.5 w-3.5 fill-current" />
          )}
        </button>
        <div className="flex items-center gap-0.5">
          {actions && <div className="mr-2 flex items-center">{actions}</div>}
          <span
            className="mr-1 font-mono text-[10px] tabular-nums text-muted-foreground/70"
            title="Zoom level (Ctrl+scroll on the waveform to zoom)"
          >
            {zoomLabel}
          </span>
          <button
            type="button"
            onClick={() => zoomBy(0.8)}
            disabled={pxPerSec === null}
            aria-label="Zoom out"
            title="Zoom out"
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => zoomBy(1.25)}
            aria-label="Zoom in"
            title="Zoom in"
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setPxPerSec(null)}
            disabled={pxPerSec === null}
            aria-label="Fit whole track"
            title="Fit whole track"
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="relative w-full overflow-hidden rounded-xl border border-border/60 bg-gradient-to-b from-card to-card/60 shadow-[inset_0_1px_0_color-mix(in_oklch,var(--foreground)_6%,transparent)]">
        <div
          ref={containerRef}
          className="w-full px-2 py-2"
          // cursor is an inherited property, so it reaches into WaveSurfer's
          // shadow DOM where our classes can't. Grab = pannable, grabbing = panning.
          style={{
            cursor: panning
              ? "grabbing"
              : view.totalW > view.visibleW + 1
                ? "grab"
                : undefined,
          }}
        />

        {loading && (
          <div className="absolute inset-0 z-20 flex items-center bg-card/90 px-2 py-2">
            <div
              className="w-full animate-pulse rounded-lg bg-muted/50"
              style={{ height: WAVE_HEIGHT }}
            />
          </div>
        )}

        {duration > 0 && totalW > 0 && !loading && (
          <div
            ref={overlayRef}
            className="pointer-events-none absolute left-2 right-2 top-2 z-10 overflow-hidden"
            style={{ height: WAVE_HEIGHT }}
          >
            {/* Shaded selection between the trim handles, DAW-style. */}
            <div
              aria-hidden
              className="absolute inset-y-0 bg-primary/10 ring-1 ring-inset ring-primary/25"
              style={{
                left: startPx,
                width: Math.max(0, endPx - startPx),
              }}
            />

            {(["start", "end"] as const).map((which) => {
              const t = which === "start" ? dropStart : dropEnd
              const px = timeToPx(t)
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
                  title={`${isStart ? "Start" : "End"} handle. Drag to trim, hold Shift to skip snapping`}
                  className="group pointer-events-auto absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize touch-none outline-none"
                  style={{ left: px }}
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
                      "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-primary/80 transition-[width,background-color]",
                      "group-hover:w-1 group-focus-visible:w-1",
                      isDraggingThis && "w-1",
                    )}
                  />
                  {/* Grip nub */}
                  <div
                    className={cn(
                      "absolute left-1/2 h-3.5 w-2.5 -translate-x-1/2 rounded-sm bg-primary ring-1 ring-black/20",
                      isStart ? "top-0" : "bottom-0",
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
