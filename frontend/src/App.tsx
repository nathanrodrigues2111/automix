import { useEffect, useMemo, useState } from "react"
import { Disc3, ListMusic, MousePointerClick, Sliders, Waves } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { TrackList } from "@/components/TrackList"
import { Timeline } from "@/components/Timeline"
import { VideoPreview } from "@/components/VideoPreview"
import { MixEditor, type EditorClip } from "@/components/MixEditor"
import { ModelDownloadDialog } from "@/components/ModelDownloadDialog"
import { ProjectManager } from "@/components/ProjectManager"
import { RenderDialog } from "@/components/RenderDialog"
import { useTracks } from "@/api/client"
import type { Drop, Project, RenderConfig, Track } from "@/api/types"
import { useProgressSocket } from "@/hooks/useProgressSocket"
import { formatTrackTitle } from "@/lib/format"
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

type ActiveTab = "tracks" | "preview" | "mix"

const DEFAULT_CONFIG: Omit<RenderConfig, "clips"> = {
  target_bpm: 0, // ignored when no_time_stretch is true
  crossfade_bars: 2, // mix between clips
  loudness_lufs: -14,
  use_stem_crossfade: true, // bass-swap when stems are available
  use_eq_bass_swap: true,
  snap_to_downbeat: true,
  hard_cut: false,
  no_time_stretch: true, // EDM-Papa style: each clip at its native BPM
  harmonic_pitch_shift_max_semitones: 0, // don't pitch-shift either
}

function uid(): string {
  return `c_${Math.random().toString(36).slice(2, 10)}`
}

export default function App() {
  const tracks = useTracks()
  const progress = useProgressSocket()

  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null)
  const [dropStart, setDropStart] = useState(0)
  const [dropEnd, setDropEnd] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)

  const [clips, setClips] = useState<EditorClip[]>([])
  const [config, setConfig] =
    useState<Omit<RenderConfig, "clips">>(DEFAULT_CONFIG)

  const [projectDialog, setProjectDialog] = useState<"save" | "load" | null>(
    null,
  )
  const [renderMode, setRenderMode] = useState<"preview" | "full" | null>(null)
  const [activeTab, setActiveTab] = useState<ActiveTab>("tracks")
  const [playRequest, setPlayRequest] = useState<PlayRequest | null>(null)
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null)

  const trackById = useMemo(
    () => Object.fromEntries((tracks.data ?? []).map((t) => [t.id, t])),
    [tracks.data],
  )
  const addedKeys = useMemo(
    () => new Set(clips.map((c) => `${c.track_id}:${c.start_s.toFixed(2)}`)),
    [clips],
  )
  const selectedTrack = selectedTrackId ? trackById[selectedTrackId] : null

  useEffect(() => {
    if (!selectedTrack?.analysis) {
      setDropStart(0)
      setDropEnd(0)
      return
    }
    setDropStart(selectedTrack.analysis.drop_start_s)
    setDropEnd(selectedTrack.analysis.drop_end_s)
  }, [selectedTrack?.id, selectedTrack?.analysis])

  const handlePreviewDrop = (t: Track, drop: Drop) => {
    setSelectedTrackId(t.id)
    setPlayRequest({
      trackId: t.id,
      time: drop.start_s,
      endTime: drop.end_s,
      key: Date.now(),
    })
    setActiveTab("preview")
  }

  const handleAdd = (t: Track, drop?: Drop) => {
    if (!t.analysis) return
    const start_s = drop?.start_s ?? t.analysis.drop_start_s
    const end_s = drop?.end_s
    // length_bars is the fallback when no explicit end is supplied; in concat
    // mode the render honours end_s exactly when present.
    const beatSec = 60 / (t.analysis.bpm || 128)
    const length_bars =
      drop && drop.end_s > drop.start_s
        ? Math.max(4, Math.round((drop.end_s - drop.start_s) / (beatSec * 4)))
        : 16
    setClips((prev) => [
      ...prev,
      {
        uid: uid(),
        track_id: t.id,
        start_s,
        length_bars,
        end_s,
      },
    ])
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

  const handleLoadProject = (p: Project) => {
    const next = p.config
    setConfig({
      target_bpm: next.target_bpm,
      crossfade_bars: next.crossfade_bars,
      loudness_lufs: next.loudness_lufs,
      use_stem_crossfade: next.use_stem_crossfade,
      harmonic_pitch_shift_max_semitones:
        next.harmonic_pitch_shift_max_semitones,
    })
    setClips(next.clips.map((c) => ({ ...c, uid: uid() })))
  }

  return (
    <div className="dark flex h-full flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border/60 bg-gradient-to-b from-background to-background/60 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
            <Sliders className="h-4 w-4 text-primary" />
          </div>
          <div className="flex items-baseline gap-2">
            <h1 className="bg-gradient-to-r from-foreground to-primary bg-clip-text text-lg font-semibold tracking-tight text-transparent">
              Automix
            </h1>
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              EDM drop stitcher
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_currentColor]" />
            local
          </span>
        </div>
      </header>

      <nav className="grid grid-cols-3 gap-1 border-b border-border/60 bg-card/30 p-1.5 lg:hidden">
        {(["tracks", "preview", "mix"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium uppercase tracking-wider transition-colors",
              activeTab === tab
                ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
            )}
          >
            {tab === "mix" ? "Mix Editor" : tab}
          </button>
        ))}
      </nav>

      <main className="flex min-h-0 w-full max-w-full min-w-0 flex-1 flex-col overflow-hidden lg:grid lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)_minmax(0,360px)]">
        <aside
          className={cn(
            "min-h-0 min-w-0 flex-col overflow-hidden border-border/60 bg-card/20 lg:flex lg:border-r",
            activeTab === "tracks" ? "flex flex-1" : "hidden",
          )}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              <ListMusic className="h-3.5 w-3.5" />
              Tracks
            </div>
            <span className="rounded-md bg-secondary/50 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {(tracks.data ?? []).length}
            </span>
          </div>
          <Separator className="bg-border/40" />
          <div className="min-h-0 flex-1">
            <TrackList
              progress={progress}
              selectedId={selectedTrackId}
              onSelect={(t) => setSelectedTrackId(t.id)}
              onAdd={handleAdd}
              onPreviewDrop={handlePreviewDrop}
              addedKeys={addedKeys}
            />
          </div>
        </aside>

        <section
          className={cn(
            "min-h-0 min-w-0 flex-col gap-3 overflow-y-auto overflow-x-hidden p-4 lg:flex",
            activeTab === "preview" ? "flex flex-1" : "hidden",
          )}
        >
          <Card className="overflow-hidden border-border/60 bg-card/40 backdrop-blur">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Disc3 className="h-3.5 w-3.5" /> Preview
              </CardTitle>
              {selectedTrack && (
                <span
                  className="truncate text-xs text-muted-foreground"
                  title={selectedTrack.filename}
                >
                  {formatTrackTitle(selectedTrack.filename)}
                </span>
              )}
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
                  seekRequest={seekRequest}
                  onTimeUpdate={setCurrentTime}
                />
              ) : (
                <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 bg-gradient-to-b from-card/40 to-card/10 text-center">
                  <MousePointerClick className="h-6 w-6 text-muted-foreground/60" />
                  <div className="text-sm text-muted-foreground">
                    Select a track from the left panel
                  </div>
                  <div className="text-xs text-muted-foreground/70">
                    Then mark its drop and add it to the mix
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/60 bg-card/40 backdrop-blur">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Waves className="h-3.5 w-3.5" /> Timeline
              </CardTitle>
            </CardHeader>
            <CardContent>
              {selectedTrack ? (
                <Timeline
                  key={selectedTrack.id}
                  track={selectedTrack}
                  dropStart={dropStart}
                  dropEnd={dropEnd}
                  onChange={({ dropStart: s, dropEnd: e }) => {
                    setDropStart(s)
                    setDropEnd(e)
                  }}
                  externalTime={currentTime}
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
        </section>

        <aside
          className={cn(
            "min-h-0 min-w-0 flex-col overflow-hidden border-border/60 bg-card/20 p-4 lg:flex lg:border-l",
            activeTab === "mix" ? "flex flex-1" : "hidden",
          )}
        >
          <MixEditor
            tracks={tracks.data ?? []}
            clips={clips}
            setClips={setClips}
            config={config}
            setConfig={setConfig}
            onPreview={() => setRenderMode("preview")}
            onRender={() => setRenderMode("full")}
            onSaveProject={() => setProjectDialog("save")}
            onLoadProject={() => setProjectDialog("load")}
          />
        </aside>
      </main>

      <ModelDownloadDialog progress={progress} />
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
