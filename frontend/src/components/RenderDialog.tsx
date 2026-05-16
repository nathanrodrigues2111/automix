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
  onClose: () => void
  config: RenderConfig
  progress: ProgressMap
}

export function RenderDialog({
  open,
  onClose,
  config,
  progress,
}: RenderDialogProps) {
  const render = useRender()
  const [jobId, setJobId] = useState<string | null>(null)
  const [outputPath, setOutputPath] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setJobId(null)
      setOutputPath(null)
      render.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const p = jobId ? progress[jobId] : undefined
  const done = !!p?.done

  const start = () => {
    render.mutate(config, {
      onSuccess: (res) => {
        setJobId(res.job_id)
        setOutputPath(res.output_path)
      },
      onError: (e) => toast.error(`Render failed: ${e.message}`),
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Render mix</DialogTitle>
          <DialogDescription>
            {jobId
              ? "Rendering — leave this dialog open."
              : `${config.clips.length} clip(s), target ${config.target_bpm.toFixed(1)} BPM, ${config.crossfade_bars} bar crossfade, ${config.loudness_lufs.toFixed(1)} LUFS`}
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

        {done && outputPath && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
            <div className="flex items-center gap-2 text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> Render complete
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {outputPath}
            </div>
            <Button
              asChild
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
            >
              <a href={`/${outputPath}`} target="_blank" rel="noreferrer">
                <FolderOpen className="h-3 w-3" /> Open output
              </a>
            </Button>
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
              Start render
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
