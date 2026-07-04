import { useEffect, useState } from "react"
import { Download, FlaskConical, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useDownloadModels, useModelsStatus } from "@/api/client"
import type { ProgressMap } from "@/hooks/useProgressSocket"
import { formatBytes } from "@/lib/format"

const MODELS_JOB_ID = "models"
const DISMISS_KEY = "automix.liteModeBannerDismissed"

interface ModelStatusBannerProps {
  progress: ProgressMap
}

/**
 * Non-blocking notice that the optional allin1/demucs model weights are not
 * installed. Analysis works fine via the built-in librosa fallback, so this
 * never opens modally — it is a small dismissible banner with an optional
 * "Download models" action.
 */
export function ModelStatusBanner({ progress }: ModelStatusBannerProps) {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === "1",
  )
  const status = useModelsStatus()
  const download = useDownloadModels()

  const p = progress[MODELS_JOB_ID]

  useEffect(() => {
    if (p?.done) {
      status.refetch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.done])

  const needsDownload =
    !!status.data &&
    (status.data.allin1 !== "ready" || status.data.demucs !== "ready")
  const downloading =
    (!!status.data &&
      (status.data.allin1 === "downloading" ||
        status.data.demucs === "downloading")) ||
    (!!p && !p.done)
  // "unavailable" = the [ml] python packages aren't installed at all, so a
  // weight download can't work — explain instead of offering a dead button.
  const canDownload =
    !!status.data &&
    (status.data.allin1 === "missing" || status.data.demucs === "missing")

  if (!status.data || !needsDownload || dismissed) return null

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1")
    setDismissed(true)
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/20 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-800 dark:text-amber-200"
    >
      <span className="flex shrink-0 items-center gap-1.5 font-medium uppercase tracking-wider">
        <FlaskConical className="h-3.5 w-3.5" /> Lite analysis mode
      </span>
      <span className="min-w-0 flex-1 truncate text-amber-800/80 dark:text-amber-200/70">
        {downloading
          ? `Downloading model weights — ${p?.message ?? "starting"} (${formatBytes(
              status.data.downloaded_bytes,
            )} / ${formatBytes(status.data.total_bytes)})`
          : canDownload
            ? "Built-in analysis is active. Optional allin1/demucs weights (~2 GB) improve stem separation."
            : "Built-in analysis is active. The optional neural stack (allin1/demucs, ~2-3 GB, GPU recommended) isn't installed. Enable it with: pip install -e \"backend[ml]\""}
      </span>
      {!downloading && canDownload && (
        <Button
          variant="ghost"
          size="sm"
          disabled={download.isPending}
          onClick={() => download.mutate()}
          className="h-6 shrink-0 px-2 text-[11px] text-amber-800 hover:bg-amber-500/20 hover:text-amber-900 dark:text-amber-200 dark:hover:text-amber-100"
        >
          {download.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
          Download models
        </Button>
      )}
      {downloading && (
        <span className="flex shrink-0 items-center gap-1.5 tabular-nums text-amber-800/80 dark:text-amber-200/80">
          <Loader2 className="h-3 w-3 animate-spin" />
          {(p?.percent ?? 0).toFixed(0)}%
        </span>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss lite analysis mode notice"
        className="rounded p-0.5 text-amber-800/70 transition-colors hover:bg-amber-500/20 hover:text-amber-900 focus-visible:outline-2 focus-visible:outline-amber-600 dark:text-amber-200/60 dark:hover:text-amber-100 dark:focus-visible:outline-amber-300"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
