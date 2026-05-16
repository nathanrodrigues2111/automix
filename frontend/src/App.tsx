import { useEffect, useMemo, useState } from "react"
import { ListMusic, Sliders } from "lucide-react"
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
import type { Project, RenderConfig, Track } from "@/api/types"
import { useProgressSocket } from "@/hooks/useProgressSocket"

const DEFAULT_CONFIG: Omit<RenderConfig, "clips"> = {
  target_bpm: 128,
  crossfade_bars: 1,
  loudness_lufs: -14,
  use_stem_crossfade: true,
  harmonic_pitch_shift_max_semitones: 2,
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
  const [renderOpen, setRenderOpen] = useState(false)

  const trackById = useMemo(
    () => Object.fromEntries((tracks.data ?? []).map((t) => [t.id, t])),
    [tracks.data],
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

  const handleAdd = (t: Track) => {
    if (!t.analysis) return
    setClips((prev) => [
      ...prev,
      {
        uid: uid(),
        track_id: t.id,
        start_s: t.analysis!.drop_start_s,
        length_bars: 16,
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
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          <Sliders className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Automix</h1>
          <span className="text-xs text-muted-foreground">
            EDM drop stitcher
          </span>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-[320px_1fr_420px]">
        <aside className="flex min-h-0 flex-col border-r border-border">
          <div className="flex items-center gap-2 px-4 py-3">
            <ListMusic className="h-4 w-4" />
            <span className="text-sm font-medium">Tracks</span>
          </div>
          <Separator />
          <div className="min-h-0 flex-1">
            <TrackList
              progress={progress}
              selectedId={selectedTrackId}
              onSelect={(t) => setSelectedTrackId(t.id)}
              onAdd={handleAdd}
            />
          </div>
        </aside>

        <section className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Preview</CardTitle>
            </CardHeader>
            <CardContent>
              <VideoPreview track={selectedTrack} currentTime={currentTime} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {selectedTrack
                  ? selectedTrack.filename
                  : "Select a track to edit"}
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
                  onTimeUpdate={setCurrentTime}
                />
              ) : (
                <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
                  Pick a track from the left panel
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <aside className="flex min-h-0 flex-col border-l border-border p-4">
          <MixEditor
            tracks={tracks.data ?? []}
            clips={clips}
            setClips={setClips}
            config={config}
            setConfig={setConfig}
            onRender={() => setRenderOpen(true)}
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
        open={renderOpen}
        onClose={() => setRenderOpen(false)}
        config={renderConfig}
        progress={progress}
      />
    </div>
  )
}
