import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { RenderClip } from "@/api/types"
import {
  claimPlayback,
  onPlaybackClaimed,
  registerPlayer,
} from "@/lib/audioFocus"

/**
 * In-browser live preview of the mix: fetches each clip's audio segment
 * (cut server-side from the cached analysis WAVs) and schedules them in a
 * single Web Audio graph with equal-power crossfades — the transition
 * timing mirrors the renderer (overlap = the incoming clip's pre-kick
 * breath). No time-stretching, so clips play at their native BPM, but cut
 * points, order, and transitions sound exactly where the render will put
 * them.
 */

export interface LivePreviewState {
  status: "idle" | "loading" | "playing" | "paused"
  /** Seconds into the preview (schedule time, includes overlaps). */
  position: number
  /** Total preview length in seconds. */
  duration: number
  /** Index of the clip currently audible (last one that started). */
  activeIndex: number
}

interface Scheduled {
  sources: AudioBufferSourceNode[]
  /** Start time of each clip on the preview's own timeline. */
  clipStarts: number[]
  duration: number
  t0: number
}

// v=n14: server-side loudness normalization — bump to invalidate cached
// buffers when the clip audio processing changes.
const CLIP_REV = "n14"

function clipUrl(c: RenderClip): string {
  return `/api/tracks/${c.track_id}/clip?start=${c.start_s.toFixed(3)}&end=${(c.end_s ?? c.start_s + 20).toFixed(3)}&v=${CLIP_REV}`
}

function clipKey(c: RenderClip): string {
  return `${c.track_id}:${c.start_s.toFixed(3)}:${(c.end_s ?? 0).toFixed(3)}:${CLIP_REV}`
}

/** Crossfade into clip `c`: its pre-kick lead-in (2 bars), clamped sane. */
function crossfadeFor(c: RenderClip): number {
  const kick = c.kick_s
  if (kick != null && kick > c.start_s) {
    return Math.min(5.0, Math.max(0.2, kick - c.start_s))
  }
  return 1.0
}

const CURVE_N = 512
const FADE_IN = new Float32Array(
  Array.from({ length: CURVE_N }, (_, i) =>
    Math.sin(((i / (CURVE_N - 1)) * Math.PI) / 2),
  ),
)
const FADE_OUT = new Float32Array(
  Array.from({ length: CURVE_N }, (_, i) =>
    Math.cos(((i / (CURVE_N - 1)) * Math.PI) / 2),
  ),
)

export type LivePreview = ReturnType<typeof useLivePreview>

export function useLivePreview(clips: RenderClip[], outroS = 0) {
  const focusId = useId()
  const ctxRef = useRef<AudioContext | null>(null)
  const buffersRef = useRef<Map<string, AudioBuffer>>(new Map())
  const scheduledRef = useRef<Scheduled | null>(null)
  const [state, setState] = useState<LivePreviewState>({
    status: "idle",
    position: 0,
    duration: 0,
    activeIndex: -1,
  })
  const statusRef = useRef(state.status)
  statusRef.current = state.status

  const stop = useCallback(() => {
    const sch = scheduledRef.current
    if (sch) {
      sch.sources.forEach((s) => {
        try {
          s.onended = null
          s.stop()
        } catch {
          // already stopped
        }
      })
      scheduledRef.current = null
    }
    void ctxRef.current?.suspend()
    setState((s) => ({ ...s, status: "idle", position: 0, activeIndex: -1 }))
  }, [])

  // Any change to the clip list invalidates the running schedule.
  const clipsSig = clips.map(clipKey).join("|")
  useEffect(() => {
    if (statusRef.current !== "idle") stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipsSig, stop])

  useEffect(() => stop, [stop]) // unmount: kill audio

  const pause = useCallback(() => {
    if (statusRef.current !== "playing") return
    void ctxRef.current?.suspend()
    setState((s) => ({ ...s, status: "paused" }))
  }, [])

  // Position/active-clip ticker (rAF, but state updates ~10/s).
  useEffect(() => {
    if (state.status !== "playing") return
    let raf = 0
    let last = 0
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - last < 100) return
      last = now
      const ctx = ctxRef.current
      const sch = scheduledRef.current
      if (!ctx || !sch) return
      const pos = Math.max(0, ctx.currentTime - sch.t0)
      if (pos >= sch.duration) {
        stop()
        return
      }
      let active = 0
      for (let i = 0; i < sch.clipStarts.length; i++) {
        if (pos >= sch.clipStarts[i]) active = i
      }
      setState((s) =>
        s.status === "playing" ? { ...s, position: pos, activeIndex: active } : s,
      )
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state.status, stop])

  const play = useCallback(async () => {
    if (clips.length === 0) return
    // Resume from pause without rescheduling.
    if (statusRef.current === "paused" && scheduledRef.current) {
      claimPlayback(focusId)
      await ctxRef.current?.resume()
      setState((s) => ({ ...s, status: "playing" }))
      return
    }
    if (statusRef.current === "loading" || statusRef.current === "playing") return

    setState((s) => ({ ...s, status: "loading" }))
    try {
      const ctx = (ctxRef.current ??= new AudioContext())
      // Fetch + decode all clip segments (cached across runs).
      const buffers = await Promise.all(
        clips.map(async (c) => {
          const key = clipKey(c)
          const hit = buffersRef.current.get(key)
          if (hit) return hit
          const res = await fetch(clipUrl(c))
          if (!res.ok) throw new Error(`clip fetch failed (${res.status})`)
          const buf = await ctx.decodeAudioData(await res.arrayBuffer())
          buffersRef.current.set(key, buf)
          return buf
        }),
      )

      claimPlayback(focusId)
      await ctx.resume()

      const t0 = ctx.currentTime + 0.15
      const sources: AudioBufferSourceNode[] = []
      const clipStarts: number[] = []
      let cursor = 0
      for (let i = 0; i < clips.length; i++) {
        const buf = buffers[i]
        const xf = i > 0 ? Math.min(crossfadeFor(clips[i]), buf.duration / 2) : 0
        const startAt = i === 0 ? 0 : cursor - xf
        const src = ctx.createBufferSource()
        src.buffer = buf
        const gain = ctx.createGain()
        src.connect(gain).connect(ctx.destination)
        if (i > 0 && xf > 0) {
          gain.gain.setValueAtTime(0, t0 + startAt)
          gain.gain.setValueCurveAtTime(FADE_IN, t0 + startAt, xf)
        }
        // Fade out under the NEXT clip's fade-in.
        if (i < clips.length - 1) {
          const nextXf = Math.min(
            crossfadeFor(clips[i + 1]),
            buffers[i + 1].duration / 2,
            buf.duration / 2,
          )
          const outAt = startAt + buf.duration - nextXf
          if (nextXf > 0 && outAt > startAt) {
            gain.gain.setValueCurveAtTime(FADE_OUT, t0 + outAt, nextXf)
          }
        }
        src.start(t0 + startAt)
        sources.push(src)
        clipStarts.push(startAt)
        cursor = startAt + buf.duration
      }

      // The timeline includes the render's black outro tail (silence) so the
      // preview's duration and end behavior match the final output.
      const total = cursor + Math.max(0, outroS)
      const sch: Scheduled = { sources, clipStarts, duration: total, t0 }
      scheduledRef.current = sch
      setState({
        status: "playing",
        position: 0,
        duration: total,
        activeIndex: 0,
      })
    } catch (e) {
      setState((s) => ({ ...s, status: "idle" }))
      throw e
    }
  }, [clips, focusId, stop, outroS])

  const toggle = useCallback(() => {
    if (statusRef.current === "playing") pause()
    else void play().catch(() => {})
  }, [pause, play])

  /** Exact playhead (audio-clock precision) for video sync: which clip is
   *  audible and how far into it we are. Null when nothing is scheduled. */
  const getPlayhead = useCallback(() => {
    const ctx = ctxRef.current
    const sch = scheduledRef.current
    if (!ctx || !sch) return null
    const pos = Math.max(0, ctx.currentTime - sch.t0)
    let index = 0
    for (let i = 0; i < sch.clipStarts.length; i++) {
      if (pos >= sch.clipStarts[i]) index = i
    }
    return { index, offset: pos - sch.clipStarts[index] }
  }, [])

  // Participate in the app-wide exclusive-playback bus: pause when a video
  // starts, and let the global spacebar reach the preview.
  useEffect(
    () =>
      onPlaybackClaimed((activeId) => {
        if (activeId !== focusId) pause()
      }),
    [focusId, pause],
  )
  useEffect(
    () =>
      registerPlayer(focusId, () => ({
        paused: statusRef.current !== "playing",
        play: () => void play().catch(() => {}),
        pause,
      })),
    [focusId, play, pause],
  )

  return { state, play, pause, stop, toggle, getPlayhead }
}
