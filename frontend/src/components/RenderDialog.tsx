import { useEffect, useState } from "react"
import { CheckCircle2, FolderOpen, Loader2, Play } from "lucide-react"
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
import { useRender } from "@/api/client"
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
  const [jobId, setJobId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setJobId(null)
      render.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isPreview ? "Preview mix (low quality)" : "Render mix"}
          </DialogTitle>
          <DialogDescription>
            {jobId
              ? isPreview
                ? "Rendering preview — typically ~30s. No stem separation, 720p."
                : "Rendering — leave this dialog open."
              : `${config.clips.length} clip(s), target ${config.target_bpm > 0 ? config.target_bpm.toFixed(1) + " BPM" : "auto BPM"}, ${config.crossfade_bars} bar crossfade, ${config.loudness_lufs.toFixed(1)} LUFS${isPreview ? " — 720p proxy" : ""}`}
          </DialogDescription>
        </DialogHeader>

        {jobId && (
          <div className="space-y-2">
            <Progress value={p?.percent ?? 0} />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{p?.stage ?? "render"}</span>
              <span>{(p?.percent ?? 0).toFixed(0)}%</span>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {p?.message ?? "Starting"}
            </div>
          </div>
        )}

        {done && !outputPath && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <div className="font-medium">Render failed</div>
            <div className="mt-1 truncate text-xs text-destructive/80">
              {p?.message || "Unknown error"}
            </div>
          </div>
        )}

        {done && outputPath && (
          <div className="space-y-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> Render complete
              </div>
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
              >
                <a
                  href={`/${outputPath}`}
                  target="_blank"
                  rel="noreferrer"
                  download
                >
                  <FolderOpen className="h-3 w-3" /> Open file
                </a>
              </Button>
            </div>
            <div className="overflow-hidden rounded-md bg-black ring-1 ring-emerald-500/20">
              <video
                src={`/${outputPath}`}
                controls
                autoPlay
                playsInline
                className="aspect-video w-full"
              />
            </div>
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {outputPath}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {done ? "Close" : "Cancel"}
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
