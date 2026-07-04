import { useEffect, useRef } from "react"
import type { MediaPlayerInstance } from "@vidstack/react"
import type { Track } from "@/api/types"
import { trackVideoUrl } from "@/api/client"
import { Player } from "@/components/Player"
import { displayTitle } from "@/lib/format"

interface PlayRequest {
  trackId: string
  time: number
  endTime?: number
  key: number
}

interface SeekRequest {
  time: number
  key: number
}

interface VideoPreviewProps {
  track: Track | null
  playRequest?: PlayRequest | null
  pauseRequestKey?: number
  seekRequest?: SeekRequest | null
  onTimeUpdate?: (time: number) => void
  onPlayingChange?: (playing: boolean) => void
  /** Exposes the underlying player instance (for external transport controls). */
  onPlayerRef?: (player: MediaPlayerInstance | null) => void
  /** When true (default), drop previews loop back to the drop start on
   *  reaching the drop end instead of pausing. */
  loop?: boolean
}

/** Run `fn` once the player can play (immediately if it already can).
 *  Returns a dispose function to cancel a still-pending callback. */
function onceCanPlay(player: MediaPlayerInstance, fn: () => void): () => void {
  let fired = false
  const dispose = player.subscribe(({ canPlay }) => {
    if (canPlay && !fired) {
      fired = true
      fn()
    }
  })
  if (fired) dispose()
  return dispose
}

export function VideoPreview({
  track,
  playRequest,
  pauseRequestKey,
  seekRequest,
  onTimeUpdate,
  onPlayingChange,
  onPlayerRef,
  loop = true,
}: VideoPreviewProps) {
  const playerRef = useRef<MediaPlayerInstance>(null)
  // Playhead updates are throttled to ~5fps: emitting on every time-update
  // re-renders the whole App tree and makes playback feel laggy.
  const lastEmitRef = useRef(0)
  // Active drop window for the current preview request. Playback loops back
  // to `start` (or pauses, when looping is off) upon reaching `end`.
  const dropWindowRef = useRef<{ start: number; end: number } | null>(null)

  // External pause request (drop picker toggling off).
  useEffect(() => {
    if (pauseRequestKey === undefined) return
    playerRef.current?.pause()
  }, [pauseRequestKey])

  // Seek only (waveform scrub) — don't change play state.
  useEffect(() => {
    if (!seekRequest) return
    const player = playerRef.current
    if (!player) return
    return onceCanPlay(player, () => {
      player.currentTime = seekRequest.time
    })
  }, [seekRequest])

  // Seek + autoplay (preview-drop click). Sets the drop window so playback
  // loops (or stops) at the drop boundary. Switching drops/tracks replaces
  // the window via this effect's cleanup + re-run.
  useEffect(() => {
    if (!playRequest) {
      dropWindowRef.current = null
      return
    }
    const player = playerRef.current
    if (!player) return
    dropWindowRef.current =
      playRequest.endTime !== undefined && playRequest.endTime > playRequest.time
        ? { start: playRequest.time, end: playRequest.endTime }
        : null
    const dispose = onceCanPlay(player, () => {
      player.currentTime = playRequest.time
      player.play().catch(() => {
        /* autoplay blocked */
      })
    })
    return () => {
      dispose()
      dropWindowRef.current = null
    }
  }, [playRequest])

  if (!track) return null

  return (
    <Player
      ref={(node) => {
        playerRef.current = node
        onPlayerRef?.(node)
      }}
      src={trackVideoUrl(track.id)}
      title={displayTitle(track)}
      onPlay={() => onPlayingChange?.(true)}
      onPlaying={() => onPlayingChange?.(true)}
      onPause={() => onPlayingChange?.(false)}
      onEnded={() => onPlayingChange?.(false)}
      onSeeked={() => {
        // Always emit on seek so the waveform playhead snaps immediately.
        const t = playerRef.current?.currentTime
        if (t != null) onTimeUpdate?.(t)
      }}
      onTimeUpdate={({ currentTime }) => {
        const player = playerRef.current
        const w = dropWindowRef.current
        if (player && w && !player.state.seeking && currentTime >= w.end) {
          if (loop) {
            // Loop the drop: jump back to its start and keep playing.
            player.currentTime = w.start
          } else {
            player.pause()
          }
        }
        const now = performance.now()
        if (now - lastEmitRef.current < 200) return
        lastEmitRef.current = now
        onTimeUpdate?.(currentTime)
      }}
    />
  )
}
