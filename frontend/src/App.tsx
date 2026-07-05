import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { MediaPlayerInstance } from "@vidstack/react"
import { toast } from "sonner"
import {
  Disc3,
  Plus,
  ListMusic,
  Monitor,
  Moon,
  MousePointerClick,
  RefreshCw,
  Repeat,
  Settings2,
  Sun,
  Waves,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { AutomixPanel } from "@/components/AutomixPanel"
import { MixesPanel } from "@/components/MixesPanel"
import { TrackList } from "@/components/TrackList"
import { Timeline } from "@/components/Timeline"
import { VideoPreview } from "@/components/VideoPreview"
import { MixEditor, type EditorClip } from "@/components/MixEditor"
import { ModelStatusBanner } from "@/components/ModelDownloadDialog"
import { ProjectManager } from "@/components/ProjectManager"
import { RenderDialog } from "@/components/RenderDialog"
import { SettingsDialog } from "@/components/SettingsDialog"
import { Tour, type TourStep } from "@/components/Tour"
import { useRefreshTitles, useTracks } from "@/api/client"
import type { Drop, Project, RenderConfig, Track } from "@/api/types"
import { useLivePreview } from "@/hooks/useLivePreview"
import { useProgressSocket } from "@/hooks/useProgressSocket"
import { toggleActivePlayback } from "@/lib/audioFocus"
import { displayTitle, formatDuration } from "@/lib/format"
import { setThemePref, useThemePref, type ThemePref } from "@/lib/theme"
import { cn } from "@/lib/utils"

export interface PlayRequest {
  trackId: string
  time: number
  endTime?: number
  key: number
}

export interface SeekRequest {
  time: number
  key: number
}

type ActiveTab = "preview" | "mix"

const TOUR_STEPS: TourStep[] = [
  {
    target: "automix",
    title: "Import from YouTube",
    text: "Paste a playlist or video URL here. Auto-Mix runs the whole pipeline in one click, Import only downloads tracks to the library, and Choose lets you hand-pick tracks from the playlist first.",
  },
  {
    target: "tracks",
    title: "Your track library",
    text: "Every imported track with its BPM, key, and detected drops. Full DJ sets work too: paste a tracklist to label every drop with its song name, search by song, and add all drops in one click. Rename, re-analyze, and batch delete live on each row.",
  },
  {
    target: "preview",
    title: "Video preview and monitor",
    text: "Plays the selected track. During a mix preview it becomes the program monitor with the EDMPAPA branding, titles, intro, and outro, exactly like the final render.",
  },
  {
    target: "timeline",
    title: "Timeline",
    text: "The selected track's waveform with its beat grid and drop bands. Drag the green and red handles to trim a cut (hold Shift to skip beat snapping), Ctrl+scroll to zoom, and use Add selection to push your custom cut into the mix.",
  },
  {
    target: "mixer",
    title: "Mix editor",
    text: "Your mix, clip by clip. Drag to reorder, Auto-order for harmonic (Camelot) flow, Preview to hear the whole mix instantly in the browser, and Render for the final MP4 (pick 480p to 4K) in videos/exports.",
  },
  {
    title: "Shortcuts",
    text: "Space plays or pauses anywhere. Ctrl+scroll zooms the timeline. Shift while dragging a handle skips snapping. Arrow keys on a focused handle nudge by 0.1s, or 1s with Shift.",
  },
]

const DEFAULT_CONFIG: Omit<RenderConfig, "clips"> = {
  target_bpm: 0, // 0 = auto (mean of the clips' BPMs)
  crossfade_bars: 2, // 2-bar blend = the clips' 2-bar vocal/riser lead-in
  loudness_lufs: -14,
  use_stem_crossfade: true, // bass-swap when stems are available
  use_eq_bass_swap: true,
  snap_to_downbeat: true,
  hard_cut: false,
  // Beat-match by default: clips stretch (pitch-preserving, ±8% max) to a
  // common grid so transitions land kick-on-kick — same as one-click
  // Auto-Mix. Native-BPM playback stays available in settings.
  no_time_stretch: false,
  brand_overlay: true, // EDMPAPA black bars + logo
  video_cut_fade: true, // quick 0.25s blend on each video cut
  show_titles: true, // per-track title overlay
  outro_s: 10, // black outro reserved for YouTube end screens
  resolution: "1080p", // final render canvas
  filename_style: "file", // exports named after the source video + date/time
  harmonic_pitch_shift_max_semitones: 0, // don't pitch-shift either
}

/** Material play_arrow (outlined) — the app logo mark. */
function PlayCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M10 8.64L15.27 12 10 15.36V8.64M8 5v14l11-7L8 5z" />
    </svg>
  )
}

function uid(): string {
  return `c_${Math.random().toString(36).slice(2, 10)}`
}

const THEME_CYCLE: Record<ThemePref, ThemePref> = {
  system: "light",
  light: "dark",
  dark: "system",
}

function ThemeToggle() {
  const pref = useThemePref()
  const next = THEME_CYCLE[pref]
  const Icon = pref === "system" ? Monitor : pref === "light" ? Sun : Moon
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Theme: ${pref} — switch to ${next}`}
      title={`Theme: ${pref} (click for ${next})`}
      onClick={() => setThemePref(next)}
      className="h-8 w-8 text-muted-foreground hover:text-foreground"
    >
      <Icon className="h-4 w-4" />
    </Button>
  )
}

function RefreshTitlesButton() {
  const refresh = useRefreshTitles()
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Refresh track titles"
      title="Re-fetch clean titles for all tracks"
      disabled={refresh.isPending}
      onClick={() =>
        refresh.mutate(undefined, {
          onSuccess: (res) =>
            toast.success(
              res.updated > 0
                ? `Updated ${res.updated} title${res.updated === 1 ? "" : "s"}`
                : "Titles already up to date",
            ),
          onError: (e) => toast.error(`Refresh failed: ${e.message}`),
        })
      }
      className="h-6 w-6 text-muted-foreground hover:text-foreground"
    >
      <RefreshCw
        className={cn("h-3.5 w-3.5", refresh.isPending && "animate-spin")}
      />
    </Button>
  )
}

// v3: outro default changed to 10s. Bumping the key drops stale persisted
// configs that would pin old defaults.
const SETTINGS_KEY = "automix.settings.v3"

interface StoredSettings {
  config?: Partial<Omit<RenderConfig, "clips">>
  loopPreviews?: boolean
}

function loadStoredSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    return raw ? (JSON.parse(raw) as StoredSettings) : {}
  } catch {
    return {}
  }
}

export default function App() {
  const tracks = useTracks()
  const progress = useProgressSocket()

  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [dropStart, setDropStart] = useState(0)
  const [dropEnd, setDropEnd] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)

  const [clips, setClips] = useState<EditorClip[]>([])
  const [config, setConfig] = useState<Omit<RenderConfig, "clips">>(() => ({
    ...DEFAULT_CONFIG,
    ...loadStoredSettings().config,
  }))
  const [loopPreviews, setLoopPreviews] = useState<boolean>(
    () => loadStoredSettings().loopPreviews ?? true,
  )

  // Persist tuning settings across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ config, loopPreviews } satisfies StoredSettings),
      )
    } catch {
      // storage unavailable — settings just won't persist
    }
  }, [config, loopPreviews])

  const [projectDialog, setProjectDialog] = useState<"save" | "load" | null>(
    null,
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tourStep, setTourStep] = useState<number | null>(null)
  const [tracksDrawerOpen, setTracksDrawerOpen] = useState(false)
  const drawerTouchRef = useRef<{ x: number; y: number } | null>(null)

  // Spacebar anywhere toggles play/pause on the active player (the one that
  // last played, or the most recent on screen) — unless the user is typing
  // in a form control or focused inside a player (Vidstack handles it there).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.isContentEditable ||
          t.closest(
            "input, textarea, select, button, [contenteditable], [role='slider'], .automix-player",
          ))
      )
        return
      if (toggleActivePlayback()) e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // The tracks drawer is a mobile-only surface; if the viewport grows past
  // the lg breakpoint while it's open, its overlay would sit on top of the
  // desktop 3-column layout — close it automatically.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)")
    const onChange = () => {
      if (mq.matches) setTracksDrawerOpen(false)
    }
    onChange()
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  // Resizable desktop columns: widths of the left (tracks) and right (mix
  // editor) panels in px, dragged via the dividers between columns.
  const COLS_KEY = "automix.columns.v1"
  const [colWidths, setColWidths] = useState<{ left: number; right: number }>(
    () => {
      try {
        const raw = localStorage.getItem(COLS_KEY)
        if (raw) {
          const p = JSON.parse(raw) as { left?: number; right?: number }
          return {
            left: Math.min(520, Math.max(200, p.left ?? 320)),
            right: Math.min(600, Math.max(280, p.right ?? 360)),
          }
        }
      } catch {
        // fall through to defaults
      }
      return { left: 320, right: 360 }
    },
  )
  useEffect(() => {
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(colWidths))
    } catch {
      // storage unavailable
    }
  }, [colWidths])

  const startColumnDrag =
    (side: "left" | "right") => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = colWidths[side]
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      const onMove = (ev: PointerEvent) => {
        const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX
        const next = Math.min(
          side === "left" ? 520 : 600,
          Math.max(side === "left" ? 200 : 280, startW + delta),
        )
        setColWidths((w) => ({ ...w, [side]: next }))
      }
      const onUp = () => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
    }

  const [renderMode, setRenderMode] = useState<"preview" | "full" | null>(null)

  // Opening the render dialog silences the app: the live mix preview stops
  // and any playing video pauses, so nothing talks over the render.
  useEffect(() => {
    if (renderMode == null) return
    livePreview.stop()
    previewPlayerRef.current?.pause()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderMode])
  const [activeTab, setActiveTab] = useState<ActiveTab>("preview")
  const [playRequest, setPlayRequest] = useState<PlayRequest | null>(null)
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null)
  const [pauseRequestKey, setPauseRequestKey] = useState<number | undefined>(
    undefined,
  )
  const [previewingKey, setPreviewingKey] = useState<string | null>(null)
  const [videoIsPlaying, setVideoIsPlaying] = useState(false)
  // Held in a ref, NOT state: the vidstack instance has getters that throw
  // when enumerated, which breaks React dev tooling if it lands in state.
  const previewPlayerRef = useRef<MediaPlayerInstance | null>(null)
  const getPreviewPlayer = useCallback(() => previewPlayerRef.current, [])

  const togglePreviewPlayback = () => {
    const p = previewPlayerRef.current
    if (!p) return
    if (p.paused) void p.play()?.catch?.(() => {})
    else p.pause()
  }

  // ---- Live mix preview: Web Audio is the master clock; the main video
  // player doubles as the program monitor (muted, video-synced). ----
  const livePreview = useLivePreview(clips, config.outro_s ?? 0)
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const monitorTrackIdRef = useRef<string | null>(null)
  monitorTrackIdRef.current = selectedTrackId
  // True while the live preview is yielding to a direct play request (drop
  // preview, trim audition): stop the mix preview but hand the player over
  // instead of pausing it.
  const monitorYieldRef = useRef(false)

  useEffect(() => {
    const status = livePreview.state.status
    const p = previewPlayerRef.current
    if (status === "idle") {
      if (p) {
        p.muted = false
        if (monitorYieldRef.current) monitorYieldRef.current = false
        else if (!p.paused) p.pause()
      }
      return
    }
    // The monitor owns the player now — clear pending drop-preview windows.
    setPlayRequest(null)
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (monitorYieldRef.current) return // a direct playback is taking over
      const ph = livePreview.getPlayhead()
      const clip = ph ? clipsRef.current[ph.index] : undefined
      if (!ph || !clip) return
      // Follow the active clip's track (switches the player's source).
      if (monitorTrackIdRef.current !== clip.track_id) {
        setSelectedTrackId(clip.track_id)
        return // wait for the new source to mount
      }
      const player = previewPlayerRef.current
      if (!player) return
      player.muted = true // sound comes from the Web Audio graph
      const target = clip.start_s + ph.offset
      const videoEl = player.el?.querySelector("video")
      const cur = videoEl ? videoEl.currentTime : player.currentTime
      if (Math.abs(cur - target) > 0.35) player.currentTime = target
      const playing = livePreview.state.status === "playing"
      if (playing && player.paused && player.state.canPlay)
        void player.play()?.catch?.(() => {})
      else if (!playing && !player.paused) player.pause()
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePreview.state.status])

  // Brand overlay for the monitor: recomputed as the preview position ticks
  // (~10 Hz). Like the burned-in render titles, the active clip's title stays
  // up for the whole clip and switches at the transition.
  const monitorPlayhead =
    livePreview.state.status !== "idle" ? livePreview.getPlayhead() : null
  const monitorClip = monitorPlayhead ? clips[monitorPlayhead.index] : null
  // Intro/outro simulation, mirroring the render: the intro animation ends
  // exactly on the first drop's kick (no title underneath it), and the mix
  // tail shows the black YouTube-end-screen outro.
  const INTRO_DUR_S = 3
  const monitorPos = livePreview.state.position
  const firstKickOut =
    clips[0]?.kick_s != null ? clips[0].kick_s - clips[0].start_s : 0
  const monitorIntro =
    !!monitorClip &&
    firstKickOut > 0 &&
    monitorPos >= Math.max(0, firstKickOut - INTRO_DUR_S) &&
    monitorPos < firstKickOut
  const monitorOutro =
    !!monitorClip &&
    (config.outro_s ?? 0) > 0 &&
    monitorPos >= livePreview.state.duration - (config.outro_s ?? 0)

  const trackById = useMemo(
    () => Object.fromEntries((tracks.data ?? []).map((t) => [t.id, t])),
    [tracks.data],
  )
  // Keyed by kick anchor when present: handleAdd normalizes start_s to the
  // 2-bar pre-kick lead-in, so the drop's own start_s never matches the
  // clip's. The kick survives both that normalization and beat nudges.
  const addedKeys = useMemo(
    () =>
      new Set(
        clips.map((c) =>
          c.kick_s != null
            ? `${c.track_id}:k${c.kick_s.toFixed(2)}`
            : `${c.track_id}:${c.start_s.toFixed(2)}`,
        ),
      ),
    [clips],
  )
  const lastClipBpm = useMemo(() => {
    const last = clips[clips.length - 1]
    if (!last) return null
    return trackById[last.track_id]?.analysis?.bpm ?? null
  }, [clips, trackById])
  const selectedTrack = selectedTrackId ? trackById[selectedTrackId] : null

  // Seed the editable drop range from the selected track's analysis. Uses the
  // "adjust state during render" pattern instead of an effect so switching
  // tracks doesn't cascade an extra render.
  const dropSeedKey = selectedTrack
    ? `${selectedTrack.id}:${selectedTrack.analysis ? "a" : "u"}`
    : null
  const [prevDropSeedKey, setPrevDropSeedKey] = useState<string | null>(null)
  if (dropSeedKey !== prevDropSeedKey) {
    setPrevDropSeedKey(dropSeedKey)
    // Seed the trim range from the best-scoring detected drop so the markers
    // land where the drop actually is; the coarse chorus range is a fallback.
    const drops = selectedTrack?.analysis?.drops ?? []
    const best = drops.length
      ? drops.reduce((a, b) => (b.score > a.score ? b : a))
      : null
    setDropStart(best?.start_s ?? selectedTrack?.analysis?.drop_start_s ?? 0)
    setDropEnd(best?.end_s ?? selectedTrack?.analysis?.drop_end_s ?? 0)
  }

  // Any direct play request while the mix preview runs: the preview yields.
  useEffect(() => {
    if (!playRequest) return
    if (livePreview.state.status !== "idle") {
      monitorYieldRef.current = true
      livePreview.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playRequest])

  const handlePreviewDrop = (t: Track, drop: Drop) => {
    setSelectedTrackId(t.id)
    // Move the trim region to the previewed drop so manual fine-tuning starts
    // from the drop the user is actually listening to. Also mark the seed key
    // as consumed so the best-drop seeding doesn't overwrite this range when
    // the selected track changes.
    setPrevDropSeedKey(`${t.id}:${t.analysis ? "a" : "u"}`)
    setDropStart(drop.start_s)
    setDropEnd(drop.end_s)
    setPreviewingKey(`${t.id}:${drop.start_s.toFixed(2)}`)
    setPlayRequest({
      trackId: t.id,
      time: drop.start_s,
      endTime: drop.end_s,
      key: Date.now(),
    })
    setActiveTab("preview")
    setTracksDrawerOpen(false) // reveal the preview so the loop starts visibly
  }

  const handlePausePreview = () => {
    setPauseRequestKey(Date.now())
  }

  const handleAdd = (t: Track, drop?: Drop) => {
    if (!t.analysis) return
    const kick_s = drop?.kick_s
    const beatSec = 60 / (t.analysis.bpm || 128)
    // Normalize to the renderer's 2-bar pre-kick lead-in NOW, so the live
    // preview plays exactly the clip the final render will cut.
    const rawStart = drop?.start_s ?? t.analysis.drop_start_s
    const start_s =
      kick_s != null ? Math.max(0, kick_s - 8 * beatSec) : rawStart
    const end_s = drop?.end_s
    const length_bars =
      drop && drop.end_s > drop.start_s
        ? Math.max(4, Math.round((drop.end_s - drop.start_s) / (beatSec * 4)))
        : 16

    // BPM-mismatch warning: if the previous clip's BPM is >5% off, transitions
    // won't beat-align in no-time-stretch mode.
    const prev = clips[clips.length - 1]
    const prevBpm = prev ? trackById[prev.track_id]?.analysis?.bpm : undefined
    if (prevBpm && t.analysis.bpm) {
      const diff = Math.abs(prevBpm - t.analysis.bpm) / prevBpm
      if (diff > 0.05) {
        toast.warning(
          `BPM mismatch: ${prevBpm.toFixed(0)} → ${t.analysis.bpm.toFixed(0)} (${(diff * 100).toFixed(0)}% off)`,
          {
            description:
              "Transition may drift. Same-BPM picks will sound tighter.",
          },
        )
      }
    }

    setClips((prev) => [
      ...prev,
      {
        title: drop?.title ?? null,
        uid: uid(),
        track_id: t.id,
        start_s,
        length_bars,
        end_s,
        kick_s,
      },
    ])
    // On mobile, adding from the tracks drawer returns you to the preview.
    setTracksDrawerOpen(false)
    setActiveTab("preview")
  }

  const renderConfig: RenderConfig = useMemo(
    () => ({
      ...config,
      clips: clips.map(({ uid: _uid, ...c }) => {
        void _uid
        return c
      }),
    }),
    [clips, config],
  )

  const clipBpms = useMemo(
    () =>
      clips
        .map((c) => trackById[c.track_id]?.analysis?.bpm)
        .filter((v): v is number => typeof v === "number"),
    [clips, trackById],
  )

  const handleLoadProject = (p: Project) => {
    // Preserve every config field the project carries; fall back to defaults
    // for anything missing (older projects may predate newer options).
    const { clips: loadedClips, ...loadedConfig } = p.config
    const defined = Object.fromEntries(
      Object.entries(loadedConfig).filter(([, v]) => v !== undefined && v !== null),
    ) as Partial<Omit<RenderConfig, "clips">>
    setConfig({ ...DEFAULT_CONFIG, ...defined })
    setClips(loadedClips.map((c) => ({ ...c, uid: uid() })))
  }

  // Shared between the desktop sidebar and the mobile slide-in drawer.
  const trackListEl = (
    <TrackList
      progress={progress}
      selectedId={selectedTrackId}
      onSelect={(t) => setSelectedTrackId(t.id)}
      onAdd={handleAdd}
      onPreviewDrop={handlePreviewDrop}
      onPausePreview={handlePausePreview}
      playingKey={videoIsPlaying ? previewingKey : null}
      addedKeys={addedKeys}
      referenceBpm={lastClipBpm}
    />
  )
  const trackCount = (tracks.data ?? []).length

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* z-40: the Auto-Mix progress dropdown must float above the main
          content (backdrop-blur makes the header its own stacking context,
          so children's z-index alone can't escape it). */}
      <header className="relative z-40 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/60 bg-gradient-to-b from-background to-background/60 px-6 py-3 backdrop-blur">
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
            <PlayCircleIcon className="h-4 w-4 text-primary" />
          </div>
          <div className="flex items-baseline gap-2">
            <h1 className="bg-gradient-to-r from-foreground to-primary bg-clip-text text-lg font-semibold tracking-tight text-transparent">
              Automix
            </h1>
          </div>
        </div>
        <div data-tour="automix" className="order-last w-full min-w-0 basis-full lg:order-none lg:w-auto lg:max-w-3xl lg:flex-1 lg:basis-auto">
          <AutomixPanel progress={progress} variant="header" />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <ThemeToggle />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open settings"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
          >
            <Settings2 className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <ModelStatusBanner progress={progress} />

      <nav
        className="grid grid-cols-3 gap-1 border-b border-border/60 bg-card/30 p-1.5 lg:hidden"
        aria-label="Sections"
      >
        {(
          [
            ["preview", "Auto-Mix"],
            ["mix", "Mix Editor"],
          ] as const
        ).map(([tab, label], i) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            aria-current={activeTab === tab ? "true" : undefined}
            className={cn(
              "rounded-md px-3 py-2 text-xs font-medium uppercase tracking-wider transition-colors focus-visible:outline-2 focus-visible:outline-ring",
              i === 1 && "order-3",
              activeTab === tab
                ? "bg-primary/10 text-primary ring-1 ring-primary/40"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => setTracksDrawerOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={tracksDrawerOpen}
          className="order-2 flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          Tracks
          <span className="rounded-md bg-secondary/60 px-1.5 py-px text-[11px] tabular-nums">
            {trackCount}
          </span>
        </button>
      </nav>

      <main
        className="flex min-h-0 w-full max-w-full min-w-0 flex-1 flex-col overflow-hidden lg:grid"
        style={{
          // Only applies when the lg: grid display kicks in; the mobile flex
          // layout ignores grid-template-columns entirely.
          gridTemplateColumns: `minmax(0,${colWidths.left}px) 5px minmax(0,1fr) 5px minmax(0,${colWidths.right}px)`,
        }}
      >
        <aside data-tour="tracks" className="hidden min-h-0 min-w-0 flex-col overflow-hidden border-r border-border/60 bg-card/20 lg:flex">
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-primary/80">
              <ListMusic className="h-3.5 w-3.5" />
              Tracks
            </div>
            <span className="rounded-md bg-secondary/50 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
              {trackCount}
            </span>
          </div>
          <Separator className="bg-border/40" />
          <div className="min-h-0 flex-1">{trackListEl}</div>
        </aside>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize tracks column"
          onPointerDown={startColumnDrag("left")}
          className="hidden cursor-col-resize touch-none bg-border/40 transition-colors hover:bg-primary/60 active:bg-primary lg:block"
        />

        <section
          className={cn(
            // *:shrink-0 — the cards use overflow-hidden, which zeroes their
            // automatic flex minimum; without it they get squashed/clipped to
            // fit the viewport instead of letting this column scroll.
            "min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overflow-x-hidden p-4 *:shrink-0 lg:flex",
            activeTab === "preview" ? "flex flex-1" : "hidden",
          )}
        >

          <Card data-tour="preview" className="overflow-hidden border-border/60 bg-card/40 backdrop-blur">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-primary/80">
                <Disc3 className="h-3.5 w-3.5" /> Preview
              </CardTitle>
              <div className="flex min-w-0 items-center gap-1.5">
                {selectedTrack && (
                  <span
                    className="min-w-0 truncate text-xs text-muted-foreground"
                    title={selectedTrack.filename}
                  >
                    {displayTitle(selectedTrack)}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-pressed={loopPreviews}
                  aria-label="Loop drop previews"
                  title={
                    loopPreviews
                      ? "Drop previews loop. Click to play through instead"
                      : "Drop previews play through. Click to loop"
                  }
                  onClick={() => setLoopPreviews((v) => !v)}
                  className={cn(
                    "h-7 w-7 shrink-0",
                    loopPreviews
                      ? "bg-primary/15 text-primary ring-1 ring-primary/30 hover:bg-primary/25 hover:text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Repeat className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {selectedTrack ? (
                <VideoPreview
                  track={selectedTrack}
                  playRequest={
                    playRequest && playRequest.trackId === selectedTrack.id
                      ? playRequest
                      : null
                  }
                  pauseRequestKey={pauseRequestKey}
                  seekRequest={seekRequest}
                  onTimeUpdate={setCurrentTime}
                  onPlayingChange={setVideoIsPlaying}
                  onPlayerRef={(p) => {
                    previewPlayerRef.current = p
                  }}
                  brandOverlay={
                    monitorClip
                      ? {
                          title:
                            monitorClip.title ??
                            (trackById[monitorClip.track_id]
                              ? displayTitle(trackById[monitorClip.track_id])
                              : null),
                          showTitle: !monitorIntro && !monitorOutro,
                          intro: monitorIntro,
                          outro: monitorOutro,
                        }
                      : null
                  }
                  loop={loopPreviews}
                />
              ) : (
                <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 bg-gradient-to-b from-card/40 to-card/10 text-center">
                  <MousePointerClick className="h-6 w-6 text-muted-foreground/60" />
                  <div className="text-sm text-muted-foreground">
                    Select a track to preview it here
                  </div>
                  <div className="max-w-xs px-4 text-xs text-muted-foreground/70">
                    Pick one from the Tracks list, or paste a YouTube playlist
                    above to get started
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card data-tour="timeline" className="border-border/60 bg-card/40 backdrop-blur">
            <CardContent className="pt-4">
              {selectedTrack ? (
                <Timeline
                  key={selectedTrack.id}
                  track={selectedTrack}
                  actions={
                    selectedTrack.analysis && dropEnd > dropStart ? (
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {formatDuration(dropStart)}–{formatDuration(dropEnd)}{" "}
                          · {(dropEnd - dropStart).toFixed(1)}s
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-6 px-2 text-xs"
                          title="Add the trimmed selection (drag the green/red markers to adjust) as a clip"
                          onClick={() => {
                            if (!selectedTrack?.analysis) return
                            const kick = (
                              selectedTrack.analysis.drops ?? []
                            ).find(
                              (d) =>
                                d.kick_s != null &&
                                d.kick_s >= dropStart &&
                                d.kick_s <= dropEnd,
                            )?.kick_s
                            handleAdd(selectedTrack, {
                              start_s: dropStart,
                              end_s: dropEnd,
                              kick_s: kick,
                              score: 0,
                            })
                          }}
                        >
                          <Plus className="h-3 w-3" /> Add selection
                        </Button>
                      </div>
                    ) : null
                  }
                  dropStart={dropStart}
                  dropEnd={dropEnd}
                  onChange={({ dropStart: s, dropEnd: e }) => {
                    // Audition the edit: start-handle moves play from the new
                    // start; end-handle moves play the last ~3s into the cut
                    // so the user hears exactly where the clip now ends.
                    if (selectedTrack) {
                      const startMoved = Math.abs(s - dropStart) > 0.01
                      setPlayRequest({
                        trackId: selectedTrack.id,
                        time: startMoved ? s : Math.max(s, e - 3),
                        endTime: e,
                        key: Date.now(),
                      })
                    }
                    setDropStart(s)
                    setDropEnd(e)
                  }}
                  externalTime={currentTime}
                  isPlaying={videoIsPlaying}
                  onTogglePlay={togglePreviewPlayback}
                  getMediaPlayer={getPreviewPlayer}
                  onSeek={(t) =>
                    setSeekRequest({ time: t, key: Date.now() })
                  }
                />
              ) : (
                <div className="flex h-32 items-center justify-center text-xs text-muted-foreground/70">
                  Beat grid will appear here
                </div>
              )}
            </CardContent>
          </Card>

          <MixesPanel progress={progress} />
        </section>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize mix editor column"
          onPointerDown={startColumnDrag("right")}
          className="hidden cursor-col-resize touch-none bg-border/40 transition-colors hover:bg-primary/60 active:bg-primary lg:block"
        />

        <aside data-tour="mixer"
          className={cn(
            "min-h-0 min-w-0 flex-col overflow-hidden border-border/60 bg-card/20 p-4 lg:flex lg:border-l",
            activeTab === "mix" ? "flex flex-1" : "hidden",
          )}
        >
          <MixEditor
            tracks={tracks.data ?? []}
            clips={clips}
            setClips={setClips}
            preview={livePreview}
            onRender={() => setRenderMode("full")}
            onSaveProject={() => setProjectDialog("save")}
            onLoadProject={() => setProjectDialog("load")}
          />
        </aside>
      </main>

      {/* Mobile: tracks browse as a slide-in drawer so the preview keeps its
          context. Desktop keeps the persistent left sidebar. */}
      <Sheet open={tracksDrawerOpen} onOpenChange={setTracksDrawerOpen}>
        <SheetContent
          side="left"
          aria-describedby={undefined}
          onTouchStart={(e) => {
            drawerTouchRef.current = {
              x: e.touches[0].clientX,
              y: e.touches[0].clientY,
            }
          }}
          onTouchEnd={(e) => {
            const start = drawerTouchRef.current
            drawerTouchRef.current = null
            if (!start) return
            const dx = e.changedTouches[0].clientX - start.x
            const dy = e.changedTouches[0].clientY - start.y
            // Swipe left to dismiss.
            if (dx < -60 && Math.abs(dx) > Math.abs(dy)) {
              setTracksDrawerOpen(false)
            }
          }}
        >
          <div className="flex items-center justify-between py-3 pl-4 pr-12">
            <SheetTitle className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-primary/80">
              <ListMusic className="h-3.5 w-3.5" />
              Tracks
            </SheetTitle>
            <span className="rounded-md bg-secondary/50 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
              {trackCount}
            </span>
          </div>
          <Separator className="bg-border/40" />
          <div className="min-h-0 flex-1">{trackListEl}</div>
        </SheetContent>
      </Sheet>

      {tourStep != null && (
        <Tour
          steps={TOUR_STEPS}
          step={tourStep}
          onStep={setTourStep}
          onClose={() => setTourStep(null)}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={config}
        setConfig={setConfig}
        loopPreviews={loopPreviews}
        onLoopPreviewsChange={setLoopPreviews}
        clipBpms={clipBpms}
        onStartTour={() => {
          setSettingsOpen(false)
          setTourStep(0)
        }}
      />
      <ProjectManager
        mode={projectDialog}
        onClose={() => setProjectDialog(null)}
        currentConfig={renderConfig}
        onLoad={handleLoadProject}
      />
      <RenderDialog
        open={renderMode !== null}
        mode={renderMode ?? "full"}
        onClose={() => setRenderMode(null)}
        config={renderConfig}
        progress={progress}
      />
    </div>
  )
}
