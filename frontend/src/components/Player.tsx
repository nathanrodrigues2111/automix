import "@vidstack/react/player/styles/default/theme.css"
import "@vidstack/react/player/styles/default/layouts/video.css"
import {
  useEffect,
  useId,
  useRef,
  type ComponentPropsWithoutRef,
  type Ref,
} from "react"
import {
  MediaPlayer,
  MediaProvider,
  type MediaPlayerInstance,
} from "@vidstack/react"
import {
  DefaultVideoLayout,
  defaultLayoutIcons,
} from "@vidstack/react/player/layouts/default"
import { claimPlayback, onPlaybackClaimed } from "@/lib/audioFocus"
import { useEffectiveTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

type MediaPlayerProps = ComponentPropsWithoutRef<typeof MediaPlayer>

export interface PlayerProps
  extends Omit<MediaPlayerProps, "src" | "children"> {
  /** Plain video URL (played as video/mp4). */
  src: string
  /** Imperative handle to the Vidstack player instance. */
  ref?: Ref<MediaPlayerInstance>
}

/**
 * App-wide video player: Vidstack Default Layout (dark) with the app's
 * primary accent wired into the player chrome (see `.automix-player` in
 * index.css). Accepts every MediaPlayer prop (title, autoPlay, event
 * callbacks, ...) plus a ref to the player instance for imperative control.
 *
 * Every Player participates in the exclusive-playback bus: when one starts
 * playing it claims audio focus and all other Player instances pause, so
 * two videos never talk over each other.
 */
export function Player({ src, className, ref, onPlay, ...rest }: PlayerProps) {
  const theme = useEffectiveTheme()
  const focusId = useId()
  const innerRef = useRef<MediaPlayerInstance | null>(null)

  // Yield: pause whenever another player claims audio focus. A plain pause —
  // no seeking — so a looping drop preview simply stops where it is.
  useEffect(
    () =>
      onPlaybackClaimed((activeId) => {
        if (activeId !== focusId) innerRef.current?.pause()
      }),
    [focusId],
  )

  const setRefs = (node: MediaPlayerInstance | null) => {
    innerRef.current = node
    if (typeof ref === "function") ref(node)
    else if (ref) {
      ;(ref as { current: MediaPlayerInstance | null }).current = node
    }
  }

  const handlePlay: PlayerProps["onPlay"] = (...args) => {
    claimPlayback(focusId)
    onPlay?.(...args)
  }

  return (
    <MediaPlayer
      ref={setRefs}
      src={{ src, type: "video/mp4" }}
      playsInline
      onPlay={handlePlay}
      className={cn(
        "automix-player aspect-video w-full overflow-hidden rounded-lg bg-black ring-1 ring-border",
        "shadow-[0_8px_30px_-12px_color-mix(in_oklch,var(--primary)_45%,transparent)]",
        className,
      )}
      {...rest}
    >
      <MediaProvider />
      <DefaultVideoLayout icons={defaultLayoutIcons} colorScheme={theme} />
    </MediaPlayer>
  )
}
