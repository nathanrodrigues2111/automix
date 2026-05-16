import { useEffect, useRef } from "react"
import {
  MediaController,
  MediaControlBar,
  MediaPlayButton,
  MediaSeekBackwardButton,
  MediaSeekForwardButton,
  MediaTimeRange,
  MediaTimeDisplay,
  MediaMuteButton,
  MediaVolumeRange,
  MediaFullscreenButton,
} from "media-chrome/react"
import type { Track } from "@/api/types"
import { trackVideoUrl } from "@/api/client"

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
}

export function VideoPreview({
  track,
  playRequest,
  pauseRequestKey,
  seekRequest,
  onTimeUpdate,
  onPlayingChange,
}: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  // Bubble play/pause state up so other UI (drop picker) can show ▶/⏸.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !onPlayingChange) return
    const onPlay = () => onPlayingChange(true)
    const onPause = () => onPlayingChange(false)
    video.addEventListener("play", onPlay)
    video.addEventListener("playing", onPlay)
    video.addEventListener("pause", onPause)
    video.addEventListener("ended", onPause)
    return () => {
      video.removeEventListener("play", onPlay)
      video.removeEventListener("playing", onPlay)
      video.removeEventListener("pause", onPause)
      video.removeEventListener("ended", onPause)
    }
  }, [onPlayingChange])

  // External pause request (drop picker toggling off).
  useEffect(() => {
    if (pauseRequestKey === undefined) return
    videoRef.current?.pause()
  }, [pauseRequestKey])

  // Push the video's playhead up to the parent so the waveform can follow.
  // Throttled to ~5fps: native `timeupdate` fires too often and causes the
  // whole App tree to re-render every ~50ms which makes playback feel laggy.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !onTimeUpdate) return
    let last = 0
    const minIntervalMs = 200
    const handler = () => {
      const now = performance.now()
      if (now - last < minIntervalMs) return
      last = now
      onTimeUpdate(video.currentTime)
    }
    const seekedHandler = () => onTimeUpdate(video.currentTime) // always emit on user seek
    video.addEventListener("timeupdate", handler)
    video.addEventListener("seeked", seekedHandler)
    return () => {
      video.removeEventListener("timeupdate", handler)
      video.removeEventListener("seeked", seekedHandler)
    }
  }, [onTimeUpdate])

  // Seek only (waveform scrub) — don't change play state.
  useEffect(() => {
    if (!seekRequest) return
    const video = videoRef.current
    if (!video) return
    const doSeek = () => {
      try {
        video.currentTime = seekRequest.time
      } catch {
        /* not seekable yet */
      }
    }
    if (video.readyState >= 1) doSeek()
    else video.addEventListener("loadedmetadata", doSeek, { once: true })
  }, [seekRequest?.key])

  // Seek + autoplay (preview-drop click). If endTime is set, auto-pause
  // when playback reaches it so the preview stops at the drop boundary.
  useEffect(() => {
    if (!playRequest) return
    const video = videoRef.current
    if (!video) return
    const endTime = playRequest.endTime
    const seekAndPlay = () => {
      try {
        video.currentTime = playRequest.time
      } catch {
        /* not seekable yet */
      }
      video.play().catch(() => {
        /* autoplay blocked */
      })
    }
    if (video.readyState >= 1) seekAndPlay()
    else video.addEventListener("loadedmetadata", seekAndPlay, { once: true })

    if (endTime === undefined) return
    const watchdog = () => {
      if (video.currentTime >= endTime) {
        video.pause()
      }
    }
    video.addEventListener("timeupdate", watchdog)
    return () => {
      video.removeEventListener("timeupdate", watchdog)
    }
  }, [playRequest?.key])

  if (!track) return null

  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-white/5 shadow-[0_8px_30px_-12px_color-mix(in_oklch,var(--primary)_40%,transparent)]">
      <MediaController
        className="block w-full"
        style={
          {
            "--media-primary-color": "rgb(168 85 247)",
            "--media-secondary-color": "rgba(255,255,255,0.1)",
            "--media-text-color": "rgb(245 245 245)",
            "--media-control-hover-background": "rgba(168,85,247,0.2)",
            "--media-range-thumb-background": "rgb(168 85 247)",
            "--media-range-bar-color": "rgb(168 85 247)",
          } as React.CSSProperties
        }
      >
        <video
          ref={videoRef}
          slot="media"
          src={trackVideoUrl(track.id)}
          playsInline
          className="block aspect-video max-h-[55vh] w-full bg-black"
        />
        <MediaControlBar>
          <MediaPlayButton />
          <MediaSeekBackwardButton seekOffset={5} />
          <MediaSeekForwardButton seekOffset={5} />
          <MediaTimeRange />
          <MediaTimeDisplay showDuration />
          <MediaMuteButton />
          <MediaVolumeRange />
          <MediaFullscreenButton />
        </MediaControlBar>
      </MediaController>
    </div>
  )
}
