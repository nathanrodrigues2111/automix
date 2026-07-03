import { Fragment, useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Download,
  Loader2,
  RotateCcw,
  Wand2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Player } from "@/components/Player"
import { Progress } from "@/components/ui/progress"
import { useAutomix, useYoutubeImport } from "@/api/client"
import type { ProgressMap } from "@/hooks/useProgressSocket"
import { cn } from "@/lib/utils"

type JobKind = "automix" | "import"

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
}

export function AutomixPanel({ progress }: AutomixPanelProps) {
  const qc = useQueryClient()
  const automix = useAutomix()
  const youtubeImport = useYoutubeImport()

  const [url, setUrl] = useState("")
  const [maxTracks, setMaxTracks] = useState("")
  const [urlError, setUrlError] = useState<string | null>(null)
  const [job, setJob] = useState<{ id: string; kind: JobKind } | null>(null)
  const notifiedJobRef = useRef<string | null>(null)
  const downloadedJobRef = useRef<string | null>(null)

  const p = job ? progress[job.id] : undefined
  const done = !!p?.done
  const isError = done && !!p && p.message.toLowerCase().startsWith("error")
  const running = (!!job && !done) || automix.isPending || youtubeImport.isPending
  const outputPath =
    done && !isError && job?.kind === "automix" ? (p?.output_path ?? null) : null
  const fileName = outputPath ? (outputPath.split("/").pop() ?? outputPath) : null

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
    if (p.message.toLowerCase().startsWith("error")) {
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
      { url: u, max_tracks: parsedMaxTracks() },
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
      { url: u, max_tracks: parsedMaxTracks() },
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

  const visibleStages =
    job?.kind === "import" ? STAGES.slice(0, 1) : STAGES
  const stageIdx = p ? STAGES.findIndex((s) => s.key === p.stage) : -1

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
              Paste a YouTube playlist — download, analyze &amp; render a
              seamless drop mix in one click
            </p>
          </div>
        </div>

        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault()
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
              className="w-20 bg-background/60 tabular-nums"
            />
            <Button
              type="submit"
              disabled={running}
              className="shrink-0 bg-gradient-to-r from-primary to-fuchsia-500 text-primary-foreground shadow-[0_0_18px_-4px_color-mix(in_oklch,var(--primary)_60%,transparent)] hover:from-primary hover:to-fuchsia-400"
            >
              {running && job?.kind !== "import" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              Auto-Mix
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={running}
              onClick={startImport}
              title="Download tracks into the library without rendering, so you can hand-tune the mix"
              className="h-9 shrink-0 bg-background/40 text-xs"
            >
              {running && job?.kind === "import" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Import only
            </Button>
          </div>
        </form>

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
            {isError && (
              <Button variant="outline" size="sm" onClick={reset} className="h-7 text-xs">
                <RotateCcw className="h-3 w-3" /> Try again
              </Button>
            )}
          </div>
        )}

        {done && !isError && job?.kind === "import" && (
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
              src={`/${outputPath}`}
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
                  asChild
                  size="sm"
                  className="bg-gradient-to-r from-primary to-fuchsia-500 text-primary-foreground hover:from-primary hover:to-fuchsia-400"
                >
                  <a href={`/${outputPath}`} download={fileName ?? true}>
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
      </CardContent>
    </Card>
  )
}
