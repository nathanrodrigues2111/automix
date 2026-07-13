import { useRef, useState } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  CheckCircle2,
  Clapperboard,
  Download,
  Eye,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  Square,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { Input } from "@/components/ui/input"
import { Player } from "@/components/Player"
import { ShortPreview } from "@/components/ShortPreview"
import {
  useCancelJob,
  useRender,
  useRevealFile,
  useTracks,
  mediaUrl,
} from "@/api/client"
import { apiUrl } from "@/lib/backend"
import type { RenderConfig } from "@/api/types"
import type { ProgressMap } from "@/hooks/useProgressSocket"

interface RenderDialogProps {
  open: boolean
  mode?: "preview" | "full"
  onClose: () => void
  config: RenderConfig
  progress: ProgressMap
  /** Active render job id, lifted to the parent so the dialog can be closed
   *  (minimized) while a render runs and reopened from a floating indicator. */
  jobId?: string | null
  onJobIdChange?: (id: string | null) => void
}

export function RenderDialog({
  open,
  mode = "full",
  onClose,
  config,
  progress,
  jobId: jobIdProp = null,
  onJobIdChange,
}: RenderDialogProps) {
  const isPreview = mode === "preview"
  const render = useRender()
  const cancelJob = useCancelJob()
  const reveal = useRevealFile()
  // Preview renders keep a local job id (never minimized); full renders use the
  // lifted parent job id so they survive closing the dialog.
  const [localJobId, setLocalJobId] = useState<string | null>(null)
  const jobId = isPreview ? localJobId : jobIdProp
  const setJobId = (id: string | null) =>
    isPreview ? setLocalJobId(id) : onJobIdChange?.(id)
  const [resolution, setResolution] = useState<string>(
    config.resolution ?? "1080p",
  )
  const [activeVideo, setActiveVideo] = useState<"full" | "short">("full")
  const [shortOnly, setShortOnly] = useState<boolean>(config.short_only ?? false)
  const [shortTitle, setShortTitle] = useState<string>(config.short_title ?? "")

  // Selected-track verification: play each clip's source from its start.
  const tracks = useTracks()
  const trackById = new Map((tracks.data ?? []).map((t) => [t.id, t]))
  const [playingClip, setPlayingClip] = useState<number | null>(null)
  const [playFrac, setPlayFrac] = useState(0) // 0-1 progress over the drop clip
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const playClip = (i: number, trackId: string, startS: number, endS: number) => {
    const a = audioRef.current
    if (!a || !trackById.has(trackId)) return
    if (playingClip === i) {
      a.pause()
      setPlayingClip(null)
      return
    }
    const start = Math.max(0, startS)
    const end = endS > start ? endS : start + 15
    setPlayFrac(0)
    // Same source the track section / drop previews use: a short, loudness-
    // normalized clip of JUST the drop (not the whole 5-minute track).
    a.src = apiUrl(
      `/api/tracks/${trackId}/clip?start=${start.toFixed(3)}&end=${end.toFixed(3)}`,
    )
    void a.play().catch(() => {})
    setPlayingClip(i)
  }

  const onAudioTime = () => {
    const a = audioRef.current
    if (!a || !a.duration || !isFinite(a.duration)) return
    setPlayFrac(Math.min(1, Math.max(0, a.currentTime / a.duration)))
  }

  // Reset job state when the dialog closes so reopening starts fresh.
  const handleClose = () => {
    audioRef.current?.pause()
    setPlayingClip(null)
    // A full render still in flight is MINIMIZED (keep the job so the floating
    // indicator can show it and reopen); otherwise reset.
    const jp = jobId ? progress[jobId] : undefined
    if (!isPreview && jobId && !jp?.done) {
      onClose()
      return
    }
    setJobId(null)
    setActiveVideo("full")
    render.reset()
    onClose()
  }

  const p = jobId ? progress[jobId] : undefined
  const done = !!p?.done
  // The real output path arrives in the final WS progress message — not in the
  // /api/render response (which only has the job_id).
  const outputPath = p?.output_path ?? null
  const shortPath = p?.short_path ?? null
  // Short-only render: the backend points output_path at the _short.mp4, so the
  // "Full video" tab would just play the Short. Hide it and force the short view.
  const shortOnlyResult =
    !!outputPath &&
    !!shortPath &&
    (outputPath === shortPath || outputPath.endsWith("_short.mp4"))
  const shownPath = shortOnlyResult
    ? shortPath
    : activeVideo === "short" && shortPath
      ? shortPath
      : outputPath
  const showShortView = shortOnlyResult || activeVideo === "short"

  const start = () => {
    const payload: RenderConfig = isPreview
      ? { ...config, proxy: true }
      : { ...config, resolution, short_only: shortOnly, short_title: shortTitle }
    render.mutate(payload, {
      onSuccess: (res) => {
        setJobId(res.job_id)
      },
      onError: (e) =>
        toast.error(`${isPreview ? "Preview" : "Render"} failed: ${e.message}`),
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
              {isPreview ? (
                <Eye className="h-4 w-4 text-primary" />
              ) : (
                <Clapperboard className="h-4 w-4 text-primary" />
              )}
            </span>
            {isPreview ? "Preview mix (low quality)" : "Render mix"}
          </DialogTitle>
          <DialogDescription>
            {jobId
              ? isPreview
                ? "Rendering preview, typically around 30s. No stem separation, 720p."
                : "Rendering. You can leave this dialog open."
              : `${config.clips.length} clip(s), target ${config.target_bpm > 0 ? config.target_bpm.toFixed(1) + " BPM" : "auto BPM"}, ${config.crossfade_bars} bar crossfade, ${config.loudness_lufs.toFixed(1)} LUFS${isPreview ? " (720p proxy)" : ""}`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-5 sm:flex-row">
          <div className="min-w-0 flex-1 space-y-4">
            {!jobId && !isPreview && (
              <div className="space-y-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-muted-foreground">Resolution</span>
                    <Select value={resolution} onValueChange={setResolution}>
                      <SelectTrigger className="h-8 w-40 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="480p">480p</SelectItem>
                        <SelectItem value="720p">720p (HD)</SelectItem>
                        <SelectItem value="1080p">1080p (Full HD)</SelectItem>
                        <SelectItem value="1440p">1440p (2K)</SelectItem>
                        <SelectItem value="2160p">2160p (4K)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="flex cursor-pointer items-center justify-between gap-3">
                    <span className="text-sm text-muted-foreground">
                      Only render the Short
                    </span>
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-[var(--primary)]"
                      checked={shortOnly}
                      onChange={(e) => setShortOnly(e.target.checked)}
                    />
                  </label>
                  <div className="space-y-1.5">
                    <span className="text-sm text-muted-foreground">Short title</span>
                    <Input
                      value={shortTitle}
                      onChange={(e) => setShortTitle(e.target.value)}
                      placeholder="Optional caption for the Short"
                      aria-label="Short title caption"
                      className="h-8 text-sm"
                    />
                  </div>
                </div>

                {config.clips.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-sm text-muted-foreground">
                      Selected tracks ({config.clips.length})
                    </div>
                    <div className="max-h-40 min-w-0 space-y-0.5 overflow-y-auto rounded-lg border border-border/60 p-1">
                      {config.clips.map((clip, i) => {
                        const tr = trackById.get(clip.track_id)
                        const label =
                          clip.title || tr?.title || tr?.filename || `Clip ${i + 1}`
                        const isPlaying = playingClip === i
                        return (
                          <div
                            key={i}
                            className="relative overflow-hidden rounded-md hover:bg-accent/30"
                          >
                            {isPlaying && (
                              <div
                                aria-hidden
                                className="pointer-events-none absolute inset-y-0 left-0 bg-primary/25 transition-[width] duration-200 ease-linear"
                                style={{ width: `${(playFrac * 100).toFixed(1)}%` }}
                              />
                            )}
                            <div className="relative flex min-w-0 items-center gap-2 px-1.5 py-1">
                              <button
                                type="button"
                                disabled={!tr}
                                onClick={() =>
                                  playClip(
                                    i,
                                    clip.track_id,
                                    clip.kick_s ?? clip.start_s ?? 0,
                                    clip.end_s ?? 0,
                                  )
                                }
                                title={
                                  !tr
                                    ? "Source track not found"
                                    : isPlaying
                                      ? "Pause"
                                      : "Play from the drop"
                                }
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-primary transition-colors hover:bg-primary/15 disabled:opacity-40"
                              >
                                {isPlaying ? (
                                  <Pause className="h-3.5 w-3.5 fill-current" />
                                ) : (
                                  <Play className="h-3.5 w-3.5 fill-current" />
                                )}
                              </button>
                              <span className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground/60">
                                {i + 1}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-sm" title={label}>
                                {label}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

        {jobId && (
          <div className="space-y-2">
            <Progress value={p?.percent ?? 0} />
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {p?.stage ?? "render"}
              </span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {(p?.percent ?? 0).toFixed(0)}%
              </span>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {p?.message ?? "Starting"}
            </div>
          </div>
        )}

        {done && !outputPath && p?.message === "Cancelled" && (
          <div className="rounded-lg border border-border/60 bg-muted/40 p-3 text-sm text-muted-foreground">
            Render cancelled.
          </div>
        )}

        {done && !outputPath && p?.message !== "Cancelled" && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <div className="font-medium">Render failed</div>
            <div className="mt-1 truncate text-xs text-destructive/80">
              {p?.message || "Unknown error"}
            </div>
          </div>
        )}

        {done && outputPath && shownPath && (
          <div className="min-w-0 space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" /> Render complete
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() =>
                    reveal.mutate(shownPath, {
                      onError: (e) =>
                        toast.error(`Could not open folder: ${e.message}`),
                    })
                  }
                >
                  <FolderOpen className="h-3 w-3" /> Open folder
                </Button>
                <Button asChild size="sm" className="h-7 text-xs">
                  <a
                    href={mediaUrl(shownPath)}
                    download={shownPath.split("/").pop() ?? true}
                  >
                    <Download className="h-3 w-3" /> Download
                  </a>
                </Button>
              </div>
            </div>
            {shortPath && !shortOnlyResult && (
              <div className="grid grid-cols-2 gap-1 rounded-md bg-muted/50 p-1">
                {(
                  [
                    { key: "full", label: "Full video" },
                    { key: "short", label: "Short" },
                  ] as const
                ).map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setActiveVideo(key)}
                    className={
                      "rounded px-2 py-1.5 text-xs font-medium transition-colors " +
                      (activeVideo === key
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground")
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <Player
              key={shownPath}
              src={mediaUrl(shownPath)}
              title={shownPath.split("/").pop() ?? "Rendered mix"}
              autoPlay
              className={
                showShortView
                  ? "mx-auto aspect-[9/16] h-[min(60vh,520px)] w-auto max-w-full ring-emerald-500/25"
                  : "max-w-full ring-emerald-500/25"
              }
            />
            <div className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {shownPath}
            </div>
          </div>
        )}
          </div>

          {!jobId && !isPreview && config.make_short !== false && (
            <div className="shrink-0 sm:w-[210px]">
              <ShortPreview config={{ ...config, short_title: shortTitle }} />
            </div>
          )}
        </div>
        <audio
          ref={audioRef}
          className="hidden"
          onTimeUpdate={onAudioTime}
          onEnded={() => setPlayingClip(null)}
        />

        <DialogFooter>
          {jobId && !done && (
            <Button
              variant="destructive"
              disabled={cancelJob.isPending}
              onClick={() => {
                cancelJob.mutate(jobId, {
                  onError: (e) => toast.error(`Cancel failed: ${e.message}`),
                })
              }}
            >
              {cancelJob.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Square className="h-4 w-4 fill-current" />
              )}
              Stop render
            </Button>
          )}
          <Button variant="outline" onClick={handleClose}>
            {done ? "Close" : "Close dialog"}
          </Button>
          {!jobId && (
            <Button onClick={start} disabled={render.isPending}>
              {render.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {isPreview ? "Start preview" : "Start render"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
