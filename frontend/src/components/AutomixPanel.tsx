import { Fragment, useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FolderOpen,
  ListChecks,
  Loader2,
  RotateCcw,
  Wand2,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Player } from "@/components/Player"
import { Progress } from "@/components/ui/progress"
import {
  useAutomix,
  useCancelJob,
  usePlaylistEntries,
  useRevealFile,
  useYoutubeImport,
  mediaUrl,
} from "@/api/client"
import type { PlaylistEntry } from "@/api/types"
import type { ProgressMap } from "@/hooks/useProgressSocket"
import { formatDuration } from "@/lib/format"
import { loadDownloadMaxHeight } from "@/lib/downloadQuality"
import { cn } from "@/lib/utils"

type JobKind = "automix" | "import"

interface LogLine {
  time: string
  stage: string
  message: string
  isError: boolean
}

const STAGES = [
  { key: "download", label: "Download" },
  { key: "analysis", label: "Analyze" },
  { key: "render", label: "Render" },
] as const

function isYoutubeUrl(url: string): boolean {
  return url.includes("youtube.com") || url.includes("youtu.be")
}

interface AutomixPanelProps {
  progress: ProgressMap
  /** "card" renders the standalone panel; "header" renders a compact form
   *  row whose status (progress, log, result) floats in a dropdown below. */
  variant?: "card" | "header"
  /** Auto-Mix is Beta and hidden by default. When false (the default), the
   *  Auto-Mix action is hidden everywhere (header button + track chooser) and
   *  the playlist only feeds Import / Choose. Enabled in Settings → Interface. */
  automixEnabled?: boolean
}

export function AutomixPanel({
  progress,
  variant = "card",
  automixEnabled = false,
}: AutomixPanelProps) {
  const compact = variant === "header"
  const qc = useQueryClient()
  const automix = useAutomix()
  const youtubeImport = useYoutubeImport()
  const playlistEntries = usePlaylistEntries()
  const cancelJob = useCancelJob()
  const reveal = useRevealFile()

  // Playlist track chooser.
  const [chooserOpen, setChooserOpen] = useState(false)
  const [entries, setEntries] = useState<PlaylistEntry[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // When on, ignore the per-track selection and take the whole playlist.
  const [wholePlaylist, setWholePlaylist] = useState(false)

  const [url, setUrl] = useState("")
  const [maxTracks, setMaxTracks] = useState("")
  const [urlError, setUrlError] = useState<string | null>(null)
  const [job, setJob] = useState<{ id: string; kind: JobKind } | null>(null)
  const [panelHidden, setPanelHidden] = useState(false)
  const [log, setLog] = useState<LogLine[]>([])
  const [showLog, setShowLog] = useState(true)
  const logRef = useRef<HTMLDivElement>(null)
  const notifiedJobRef = useRef<string | null>(null)
  const downloadedJobRef = useRef<string | null>(null)

  const p = job ? progress[job.id] : undefined
  const done = !!p?.done
  const isError = done && !!p && p.message.toLowerCase().startsWith("error")
  const running = (!!job && !done) || automix.isPending || youtubeImport.isPending
  const outputPath =
    done && !isError && job?.kind === "automix" ? (p?.output_path ?? null) : null
  const fileName = outputPath ? (outputPath.split("/").pop() ?? outputPath) : null

  // Accumulate every distinct progress message into a job log (the socket
  // only keeps the latest message per job). Cleared when a new job starts.
  useEffect(() => {
    setLog([])
    setPanelHidden(false)
  }, [job?.id])

  useEffect(() => {
    if (!job || !p?.message) return
    const { stage, message } = p
    const isErr = !!p.done && message.toLowerCase().startsWith("error")
    setLog((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.message === message && last.stage === stage) return prev
      const time = new Date().toLocaleTimeString([], { hour12: false })
      return [...prev, { time, stage, message, isError: isErr }]
    })
  }, [job, p])

  // Keep the log pinned to the newest line.
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log.length])

  // Tracks land in the library as soon as the download stage finishes — for
  // automix jobs that's well before the render completes, so refresh early.
  useEffect(() => {
    if (!job || !p) return
    if (p.stage === "download" && !p.done) return
    if (downloadedJobRef.current === job.id) return
    downloadedJobRef.current = job.id
    qc.invalidateQueries({ queryKey: ["tracks"] })
  }, [job, p, qc])

  // On job completion: refresh the library and notify once per job.
  useEffect(() => {
    if (!job || !p?.done) return
    if (notifiedJobRef.current === job.id) return
    notifiedJobRef.current = job.id
    qc.invalidateQueries({ queryKey: ["tracks"] })
    if (p.message === "Cancelled") {
      toast.info(job.kind === "automix" ? "Auto-Mix cancelled" : "Import cancelled")
    } else if (p.message.toLowerCase().startsWith("error")) {
      toast.error(job.kind === "automix" ? "Auto-Mix failed" : "Import failed", {
        description: p.message,
      })
    } else if (job.kind === "import") {
      toast.success(p.message || "Import complete")
    } else {
      toast.success("Auto-Mix complete", {
        description: p.output_path ?? undefined,
      })
    }
  }, [job, p, qc])

  const validateUrl = (): string | null => {
    const trimmed = url.trim()
    if (!trimmed || !isYoutubeUrl(trimmed)) {
      setUrlError("Enter a YouTube video or playlist URL (youtube.com / youtu.be)")
      return null
    }
    setUrlError(null)
    return trimmed
  }

  const parsedMaxTracks = (): number | null => {
    const n = parseInt(maxTracks, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  const startAutomix = () => {
    const u = validateUrl()
    if (!u) return
    automix.mutate(
      { url: u, max_tracks: parsedMaxTracks(), max_height: loadDownloadMaxHeight() },
      {
        onSuccess: (res) => setJob({ id: res.job_id, kind: "automix" }),
        onError: (e) => toast.error(`Auto-Mix failed: ${e.message}`),
      },
    )
  }

  const startImport = () => {
    const u = validateUrl()
    if (!u) return
    youtubeImport.mutate(
      { url: u, max_tracks: parsedMaxTracks(), max_height: loadDownloadMaxHeight() },
      {
        onSuccess: (res) => setJob({ id: res.job_id, kind: "import" }),
        onError: (e) => toast.error(`Import failed: ${e.message}`),
      },
    )
  }

  const reset = () => {
    setJob(null)
    automix.reset()
    youtubeImport.reset()
  }

  const openChooser = () => {
    const u = validateUrl()
    if (!u) return
    playlistEntries.mutate(
      { url: u, max_tracks: parsedMaxTracks() },
      {
        onSuccess: (list) => {
          // Dedupe by video id — playlists can contain the same video twice,
          // which broke the select-all size comparison.
          const seen = new Set<string>()
          const unique = list.filter((e) =>
            seen.has(e.id) ? false : (seen.add(e.id), true),
          )
          setEntries(unique)
          setSelectedIds(new Set(unique.map((e) => e.id)))
          setWholePlaylist(false)
          setChooserOpen(true)
        },
        onError: (e) => toast.error(`Could not load playlist: ${e.message}`),
      },
    )
  }

  const toggleEntry = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const startWithSelection = (kind: JobKind) => {
    const u = url.trim()
    // null = no filter: the backend takes the entire playlist.
    const ids = wholePlaylist ? null : [...selectedIds]
    if (!u || (ids !== null && ids.length === 0)) return
    setChooserOpen(false)
    const body = {
      url: u,
      max_tracks: null,
      video_ids: ids,
      max_height: loadDownloadMaxHeight(),
    }
    if (kind === "automix") {
      automix.mutate(body, {
        onSuccess: (res) => setJob({ id: res.job_id, kind: "automix" }),
        onError: (e) => toast.error(`Auto-Mix failed: ${e.message}`),
      })
    } else {
      youtubeImport.mutate(body, {
        onSuccess: (res) => setJob({ id: res.job_id, kind: "import" }),
        onError: (e) => toast.error(`Import failed: ${e.message}`),
      })
    }
  }

  const visibleStages =
    job?.kind === "import" ? STAGES.slice(0, 1) : STAGES
  const stageIdx = p ? STAGES.findIndex((s) => s.key === p.stage) : -1

  const formEl = (
        <form
          className={cn(
            "flex gap-2",
            compact ? "min-w-0 flex-1 flex-row items-center" : "flex-col sm:flex-row",
          )}
          onSubmit={(e) => {
            e.preventDefault()
            // With Auto-Mix disabled, Enter must not silently kick off a full
            // render — the visible actions are Import / Choose.
            if (!automixEnabled) return
            startAutomix()
          }}
        >
          <Input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              if (urlError) setUrlError(null)
            }}
            placeholder="https://youtube.com/playlist?list=…"
            aria-label="YouTube playlist or video URL"
            aria-invalid={urlError ? true : undefined}
            disabled={running}
            className={cn(
              "min-w-0 flex-1 bg-background/60",
              compact && "h-8 text-sm",
              urlError && "border-destructive focus-visible:ring-destructive/40",
            )}
          />
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={100}
              value={maxTracks}
              onChange={(e) => setMaxTracks(e.target.value)}
              placeholder="All"
              aria-label="Max tracks"
              title="Max tracks to pull from the playlist (empty = all)"
              disabled={running}
              className={cn(
                "w-20 bg-background/60 tabular-nums",
                compact && "h-8 w-16 text-sm",
              )}
            />
            {automixEnabled && (
              <Button
                type="submit"
                disabled={running}
                size={compact ? "sm" : "default"}
                className={cn(
                  "shrink-0 bg-primary text-primary-foreground shadow-[0_0_18px_-4px_color-mix(in_oklch,var(--primary)_60%,transparent)] hover:bg-primary/90",
                  compact && "h-8",
                )}
              >
                {running && job?.kind !== "import" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Wand2 className="h-4 w-4" />
                )}
                Auto-Mix
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={running}
              onClick={startImport}
              title="Download tracks into the library without rendering, so you can hand-tune the mix"
              className={cn(
                "shrink-0 bg-background/40 text-xs",
                compact ? "h-8" : "h-9",
              )}
            >
              {running && job?.kind === "import" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Import only
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={running || playlistEntries.isPending}
              onClick={openChooser}
              title="List the playlist's tracks and choose which ones to import or mix"
              className={cn(
                "shrink-0 bg-background/40 text-xs",
                compact ? "h-8" : "h-9",
              )}
            >
              {playlistEntries.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ListChecks className="h-3.5 w-3.5" />
              )}
              Choose
            </Button>
          </div>
        </form>
  )

  const chooserEl = (
    <Dialog open={chooserOpen} onOpenChange={setChooserOpen}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-primary" />
            Choose tracks · {selectedIds.size}/{entries.length}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            className={cn(
              "flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground",
              wholePlaylist && "pointer-events-none opacity-40",
            )}
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--primary)]"
              disabled={wholePlaylist}
              checked={
                entries.length > 0 &&
                entries.every((e) => selectedIds.has(e.id))
              }
              onChange={() =>
                setSelectedIds(
                  entries.every((e) => selectedIds.has(e.id))
                    ? new Set()
                    : new Set(entries.map((e) => e.id)),
                )
              }
            />
            Select all
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[var(--primary)]"
              checked={wholePlaylist}
              onChange={(e) => setWholePlaylist(e.target.checked)}
            />
            Whole playlist
          </label>
        </div>
        <ul
          className={cn(
            "min-h-0 flex-1 divide-y divide-border/40 overflow-y-auto rounded-lg border border-border/60",
            wholePlaylist && "pointer-events-none opacity-40",
          )}
        >
          {entries.map((e, i) => (
            <li key={e.id}>
              <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors hover:bg-accent/30">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 accent-[var(--primary)]"
                  checked={selectedIds.has(e.id)}
                  onChange={() => toggleEntry(e.id)}
                />
                <span className="w-5 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground/60">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm" title={e.title}>
                  {e.title}
                </span>
                {e.duration_s != null && (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {formatDuration(e.duration_s)}
                  </span>
                )}
              </label>
            </li>
          ))}
        </ul>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!wholePlaylist && selectedIds.size === 0}
            onClick={() => startWithSelection("import")}
          >
            <Download className="h-3.5 w-3.5" /> Import{" "}
            {wholePlaylist ? "all" : selectedIds.size}
          </Button>
          {automixEnabled && (
            <Button
              size="sm"
              disabled={!wholePlaylist && selectedIds.size === 0}
              onClick={() => startWithSelection("automix")}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Wand2 className="h-3.5 w-3.5" /> Auto-Mix{" "}
              {wholePlaylist ? "all" : selectedIds.size}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  const statusEl = (
    <>
        {urlError && (
          <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {urlError}
          </p>
        )}

        {job && (
          <div
            className={cn(
              "space-y-2 rounded-lg border p-3",
              isError
                ? "border-destructive/40 bg-destructive/10"
                : "border-border/60 bg-background/40",
            )}
          >
            <div className="flex items-center gap-2">
              {visibleStages.map((s, i) => {
                const state = isError
                  ? i === stageIdx
                    ? "error"
                    : i < stageIdx
                      ? "done"
                      : "pending"
                  : done || i < stageIdx
                    ? "done"
                    : i === stageIdx
                      ? "active"
                      : "pending"
                return (
                  <Fragment key={s.key}>
                    {i > 0 && (
                      <span
                        aria-hidden
                        className={cn(
                          "h-px min-w-3 flex-1 transition-colors",
                          (done && !isError) || i <= stageIdx
                            ? "bg-emerald-500/50"
                            : "bg-border/60",
                        )}
                      />
                    )}
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span
                        className={cn(
                          "flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums",
                          state === "done" &&
                            "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                          state === "active" &&
                            "border-primary/60 bg-primary/15 text-primary",
                          state === "error" &&
                            "border-destructive/60 bg-destructive/15 text-destructive",
                          state === "pending" &&
                            "border-border/60 text-muted-foreground/60",
                        )}
                      >
                        {state === "done" ? (
                          <Check className="h-3 w-3" />
                        ) : state === "active" ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : state === "error" ? (
                          <AlertCircle className="h-3 w-3" />
                        ) : (
                          i + 1
                        )}
                      </span>
                      <span
                        className={cn(
                          "text-[11px] font-medium uppercase tracking-wider",
                          state === "active"
                            ? "text-primary"
                            : state === "done"
                              ? "text-emerald-700 dark:text-emerald-300"
                              : state === "error"
                                ? "text-destructive"
                                : "text-muted-foreground/70",
                        )}
                      >
                        {s.label}
                      </span>
                    </span>
                  </Fragment>
                )
              })}
              <span className="ml-auto shrink-0 pl-2 font-mono text-xs tabular-nums text-muted-foreground">
                {(p?.percent ?? 0).toFixed(0)}%
              </span>
              {!done && job && (
                <button
                  type="button"
                  disabled={cancelJob.isPending}
                  onClick={() =>
                    cancelJob.mutate(job.id, {
                      onError: (e) =>
                        toast.error(`Cancel failed: ${e.message}`),
                    })
                  }
                  title="Cancel this job"
                  className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Cancel
                </button>
              )}
            </div>
            <Progress value={p?.percent ?? 0} />
            <div
              className={cn(
                "truncate text-xs",
                isError ? "text-destructive" : "text-muted-foreground",
              )}
              title={p?.message}
            >
              {p?.message || "Starting…"}
            </div>
            {log.length > 0 && (
              <div className="space-y-1 border-t border-border/60 pt-2">
                <button
                  type="button"
                  onClick={() => setShowLog((v) => !v)}
                  aria-expanded={showLog}
                  className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showLog ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  Log
                  <span className="font-mono normal-case tabular-nums text-muted-foreground/60">
                    ({log.length})
                  </span>
                </button>
                {showLog && (
                  <div
                    ref={logRef}
                    className="max-h-40 overflow-y-auto rounded-md border border-border/60 bg-background/60 p-2 font-mono text-[11px] leading-relaxed"
                  >
                    {log.map((l, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="shrink-0 tabular-nums text-muted-foreground/50">
                          {l.time}
                        </span>
                        <span className="w-16 shrink-0 uppercase text-primary/70">
                          {l.stage}
                        </span>
                        <span
                          className={cn(
                            "min-w-0 break-words",
                            l.isError ? "text-destructive" : "text-muted-foreground",
                          )}
                        >
                          {l.message}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {isError && (
              <Button variant="outline" size="sm" onClick={reset} className="h-7 text-xs">
                <RotateCcw className="h-3 w-3" /> Try again
              </Button>
            )}
          </div>
        )}

        {done && p?.message === "Cancelled" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 p-3">
            <span className="text-sm text-muted-foreground">Job cancelled</span>
            <Button variant="ghost" size="sm" onClick={reset} className="h-7 text-xs">
              <RotateCcw className="h-3 w-3" /> Start over
            </Button>
          </div>
        )}

        {done && !isError && p?.message !== "Cancelled" && job?.kind === "import" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span className="truncate">{p?.message || "Import complete"}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={reset} className="h-7 text-xs">
              <RotateCcw className="h-3 w-3" /> Import more
            </Button>
          </div>
        )}

        {outputPath && (
          <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> Mix ready
            </div>
            <Player
              src={mediaUrl(outputPath)}
              title={fileName ?? "Auto-Mix"}
              className="ring-emerald-500/25"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
                title={outputPath}
              >
                {fileName}
              </span>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    outputPath &&
                    reveal.mutate(outputPath, {
                      onError: (e) =>
                        toast.error(`Could not open folder: ${e.message}`),
                    })
                  }
                >
                  <FolderOpen className="h-3.5 w-3.5" /> Open folder
                </Button>
                <Button
                  asChild
                  size="sm"
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <a href={mediaUrl(outputPath)} download={fileName ?? true}>
                    <Download className="h-3.5 w-3.5" /> Download
                  </a>
                </Button>
                <Button variant="ghost" size="sm" onClick={reset}>
                  <RotateCcw className="h-3.5 w-3.5" /> Mix another
                </Button>
              </div>
            </div>
          </div>
        )}
    </>
  )

  if (compact) {
    const hasStatus = !!urlError || !!job
    return (
      <div className="relative min-w-0 flex-1">
        {chooserEl}
        {formEl}
        {hasStatus && !panelHidden && (
          <div className="absolute inset-x-0 top-full z-50 mt-2 space-y-3 rounded-xl border border-border/60 bg-popover/95 p-3 pt-8 shadow-2xl backdrop-blur">
            <button
              type="button"
              onClick={() => setPanelHidden(true)}
              aria-label="Hide progress panel"
              title="Hide (the job keeps running)"
              className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X className="h-3.5 w-3.5" />
            </button>
            {statusEl}
          </div>
        )}
      </div>
    )
  }

  return (
    <Card className="relative overflow-hidden border-primary/25 bg-gradient-to-br from-primary/10 via-card/50 to-fuchsia-500/10 backdrop-blur">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-16 right-0 h-40 w-72 rounded-full bg-primary/15 blur-3xl"
      />
      <CardContent className="relative space-y-3 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
            <Wand2 className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight">Auto-Mix</h2>
            <p className="truncate text-xs text-muted-foreground">
              Paste a YouTube playlist to download, analyze, and render a
              seamless drop mix in one click
            </p>
          </div>
        </div>
        {chooserEl}
        {formEl}
        {statusEl}
      </CardContent>
    </Card>
  )
}
