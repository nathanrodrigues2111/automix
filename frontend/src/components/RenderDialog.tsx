import { useState } from "react"
import {
  CheckCircle2,
  Clapperboard,
  Download,
  Eye,
  FolderOpen,
  Loader2,
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
import { Player } from "@/components/Player"
import { useCancelJob, useRender, mediaUrl } from "@/api/client"
import type { RenderConfig } from "@/api/types"
import type { ProgressMap } from "@/hooks/useProgressSocket"

interface RenderDialogProps {
  open: boolean
  mode?: "preview" | "full"
  onClose: () => void
  config: RenderConfig
  progress: ProgressMap
}

export function RenderDialog({
  open,
  mode = "full",
  onClose,
  config,
  progress,
}: RenderDialogProps) {
  const isPreview = mode === "preview"
  const render = useRender()
  const cancelJob = useCancelJob()
  const [jobId, setJobId] = useState<string | null>(null)

  // Reset job state when the dialog closes so reopening starts fresh.
  const handleClose = () => {
    setJobId(null)
    render.reset()
    onClose()
  }

  const p = jobId ? progress[jobId] : undefined
  const done = !!p?.done
  // The real output path arrives in the final WS progress message — not in the
  // /api/render response (which only has the job_id).
  const outputPath = p?.output_path ?? null

  const start = () => {
    const payload: RenderConfig = isPreview
      ? { ...config, proxy: true }
      : config
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
      <DialogContent>
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

        {done && outputPath && (
          <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> Render complete
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button
                  asChild
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                >
                  <a href={mediaUrl(outputPath)} target="_blank" rel="noreferrer">
                    <FolderOpen className="h-3 w-3" /> Open file
                  </a>
                </Button>
                <Button asChild size="sm" className="h-7 text-xs">
                  <a
                    href={mediaUrl(outputPath)}
                    download={outputPath.split("/").pop() ?? true}
                  >
                    <Download className="h-3 w-3" /> Download
                  </a>
                </Button>
              </div>
            </div>
            <Player
              src={mediaUrl(outputPath)}
              title={outputPath.split("/").pop() ?? "Rendered mix"}
              autoPlay
              className="ring-emerald-500/25"
            />
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {outputPath}
            </div>
          </div>
        )}

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
