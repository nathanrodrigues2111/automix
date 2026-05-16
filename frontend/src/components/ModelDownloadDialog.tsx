import { useEffect, useState } from "react"
import { Download, Loader2 } from "lucide-react"
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
import { useDownloadModels, useModelsStatus } from "@/api/client"
import type { ProgressMap } from "@/hooks/useProgressSocket"
import { formatBytes } from "@/lib/format"

const MODELS_JOB_ID = "models"

interface ModelDownloadDialogProps {
  progress: ProgressMap
}

export function ModelDownloadDialog({ progress }: ModelDownloadDialogProps) {
  const status = useModelsStatus({ refetchInterval: 5000 })
  const download = useDownloadModels()
  const [dismissed, setDismissed] = useState(false)

  const needsDownload =
    !!status.data &&
    (status.data.allin1 !== "ready" || status.data.demucs !== "ready")
  const downloading =
    !!status.data &&
    (status.data.allin1 === "downloading" ||
      status.data.demucs === "downloading")
  const open = !!status.data && needsDownload && !dismissed

  const p = progress[MODELS_JOB_ID]

  useEffect(() => {
    if (p?.done) {
      status.refetch()
    }
  }, [p?.done, status])

  if (!status.data) return null

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setDismissed(true)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Model weights required</DialogTitle>
          <DialogDescription>
            Automix needs to download <code>allin1</code> and <code>demucs</code>{" "}
            model weights before it can analyse tracks. This happens once.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <ModelRow label="allin1" state={status.data.allin1} />
          <ModelRow label="demucs" state={status.data.demucs} />

          {(downloading || p) && (
            <div className="space-y-1.5">
              <Progress value={p?.percent ?? 0} />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{p?.message ?? "Preparing"}</span>
                <span>
                  {formatBytes(status.data.downloaded_bytes)} /{" "}
                  {formatBytes(status.data.total_bytes)}
                </span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setDismissed(true)}>
            Later
          </Button>
          <Button
            disabled={downloading || download.isPending}
            onClick={() => download.mutate()}
          >
            {downloading || download.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Download now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ModelRow({
  label,
  state,
}: {
  label: string
  state: "ready" | "missing" | "downloading"
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <code className="rounded bg-muted px-2 py-0.5 text-xs">{label}</code>
      <span
        className={
          state === "ready"
            ? "text-emerald-400"
            : state === "downloading"
              ? "text-amber-400"
              : "text-muted-foreground"
        }
      >
        {state}
      </span>
    </div>
  )
}
