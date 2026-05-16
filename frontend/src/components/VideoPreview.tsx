import { useEffect, useRef } from "react"
import type { Track } from "@/api/types"
import { trackVideoUrl } from "@/api/client"

interface VideoPreviewProps {
  track: Track | null
  currentTime: number
}

export function VideoPreview({ track, currentTime }: VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (Math.abs(video.currentTime - currentTime) > 0.25) {
      try {
        video.currentTime = currentTime
      } catch {
        // ignored — video may not yet be seekable
      }
    }
  }, [currentTime])

  if (!track) {
    return (
      <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border bg-card text-sm text-muted-foreground">
        No track selected
      </div>
    )
  }

  return (
    <div className="relative w-full overflow-hidden rounded-md bg-black">
      <video
        ref={videoRef}
        src={trackVideoUrl(track.id)}
        muted
        playsInline
        className="aspect-video w-full"
      />
    </div>
  )
}
