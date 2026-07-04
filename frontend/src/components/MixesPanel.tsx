import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  ChevronDown,
  Clapperboard,
  Download,
  Loader2,
  Play,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Player } from "@/components/Player"
import { useDeleteMix, useMixes, mediaUrl } from "@/api/client"
import type { MixRecord } from "@/api/types"
import type { ProgressMap } from "@/hooks/useProgressSocket"
import { formatBytes } from "@/lib/format"
import { cn } from "@/lib/utils"

interface MixesPanelProps {
  progress: ProgressMap
}

function mixDateLabel(m: MixRecord): string {
  const d = new Date(m.created_at)
  if (Number.isNaN(d.getTime())) return m.filename
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** Collapsible library of all rendered automix videos: play inline,
 *  download, delete (single two-click confirm, or batch via select mode). */
export function MixesPanel({ progress }: MixesPanelProps) {
  const qc = useQueryClient()
  const mixes = useMixes()
  const deleteMix = useDeleteMix()

  const [open, setOpen] = useState(true)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [confirmFile, setConfirmFile] = useState<string | null>(null)
  const confirmTimerRef = useRef<number | null>(null)

  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmBatch, setConfirmBatch] = useState(false)
  const batchTimerRef = useRef<number | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)

  // A finished render/automix job (done + output_path) means a new file in
  // videos/ — refresh the list once per job id.
  const seenJobsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const [jobId, entry] of Object.entries(progress)) {
      if (entry.done && entry.output_path && !seenJobsRef.current.has(jobId)) {
        seenJobsRef.current.add(jobId)
        qc.invalidateQueries({ queryKey: ["mixes"] })
      }
    }
  }, [progress, qc])

  const items = mixes.data ?? []
  const allSelected = items.length > 0 && selected.size === items.length

  const handleSingleDelete = (m: MixRecord) => {
    if (confirmFile !== m.filename) {
      setConfirmFile(m.filename)
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = window.setTimeout(
        () => setConfirmFile(null),
        3000,
      )
      return
    }
    if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current)
    setConfirmFile(null)
    deleteMix.mutate(m.filename, {
      onSuccess: () => {
        toast.success("Mix deleted", { description: m.filename })
        setActiveFile((f) => (f === m.filename ? null : f))
      },
      onError: (e) => toast.error(`Delete failed: ${e.message}`),
    })
  }

  const toggleSelectMode = () => {
    setSelectMode((s) => !s)
    setSelected(new Set())
    setConfirmBatch(false)
  }

  const toggleSelected = (filename: string) => {
    setConfirmBatch(false)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }

  const handleBatchDelete = async () => {
    if (!confirmBatch) {
      setConfirmBatch(true)
      if (batchTimerRef.current) window.clearTimeout(batchTimerRef.current)
      batchTimerRef.current = window.setTimeout(
        () => setConfirmBatch(false),
        4000,
      )
      return
    }
    if (batchTimerRef.current) window.clearTimeout(batchTimerRef.current)
    setConfirmBatch(false)
    setBatchBusy(true)
    const files = [...selected]
    const results = await Promise.allSettled(
      files.map((f) => deleteMix.mutateAsync(f)),
    )
    setBatchBusy(false)
    const ok = results.filter((r) => r.status === "fulfilled").length
    const failed = results.length - ok
    if (failed === 0) {
      toast.success(`Deleted ${ok} mix${ok === 1 ? "" : "es"}`)
    } else {
      toast.error(`Deleted ${ok}, failed ${failed}`, {
        description: "Some files could not be removed. The list has been refreshed.",
      })
    }
    setSelected(new Set())
    setSelectMode(false)
    setActiveFile((f) => (f && files.includes(f) ? null : f))
    qc.invalidateQueries({ queryKey: ["mixes"] })
  }

  return (
    <Card className="border-border/60 bg-card/40 backdrop-blur">
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-ring"
        >
          <CardTitle className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-primary/80">
            <Clapperboard className="h-3.5 w-3.5" /> Mixes
            <span className="rounded-md bg-secondary/50 px-1.5 py-0.5 text-[11px] font-medium normal-case tracking-normal tabular-nums text-muted-foreground">
              {items.length}
            </span>
          </CardTitle>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </CardHeader>

      {open && (
        <CardContent className="space-y-2">
          {items.length > 0 && (
            <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={toggleSelectMode}
                  className="h-7 text-xs"
                >
                  {selectMode ? "Done" : "Select"}
                </Button>
                {selectMode && (
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 accent-[var(--primary)]"
                      checked={allSelected}
                      onChange={() =>
                        setSelected(
                          allSelected
                            ? new Set()
                            : new Set(items.map((m) => m.filename)),
                        )
                      }
                    />
                    Select all
                  </label>
                )}
              </div>
              {selectMode && selected.size > 0 && (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={batchBusy}
                  onClick={handleBatchDelete}
                  className="h-7 text-xs"
                >
                  {batchBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                  {confirmBatch
                    ? `Really delete ${selected.size}?`
                    : `Delete selected (${selected.size})`}
                </Button>
              )}
            </div>
          )}

          {mixes.isLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading mixes
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 bg-gradient-to-b from-card/40 to-card/10 p-8 text-center">
              <Clapperboard className="h-6 w-6 text-muted-foreground/50" />
              <div className="text-sm font-medium text-muted-foreground">
                No mixes yet
              </div>
              <div className="text-xs leading-relaxed text-muted-foreground/70">
                Rendered automix videos will show up here
              </div>
            </div>
          ) : (
            <ul className="space-y-2">
              {items.map((m) => {
                const isActive = activeFile === m.filename
                const isConfirming = confirmFile === m.filename
                const isSelected = selected.has(m.filename)
                return (
                  <li
                    key={m.filename}
                    className={cn(
                      "overflow-hidden rounded-lg border transition-colors",
                      isSelected
                        ? "border-primary/50 bg-primary/10"
                        : "border-border/60 bg-card hover:border-border",
                    )}
                  >
                    {selectMode ? (
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 accent-[var(--primary)]"
                          checked={isSelected}
                          onChange={() => toggleSelected(m.filename)}
                          aria-label={`Select ${m.filename}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {mixDateLabel(m)}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">
                            {m.filename} · {formatBytes(m.size_bytes)}
                          </span>
                        </span>
                      </label>
                    ) : (
                      <div className="flex items-center gap-2 px-3 py-2">
                        <button
                          type="button"
                          aria-pressed={isActive}
                          aria-label={
                            isActive ? "Hide player" : `Play ${m.filename}`
                          }
                          title={isActive ? "Hide player" : "Play inline"}
                          onClick={() =>
                            setActiveFile(isActive ? null : m.filename)
                          }
                          className={cn(
                            "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                            isActive
                              ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                              : "text-primary hover:bg-primary/15",
                          )}
                        >
                          <Play className="h-3.5 w-3.5 fill-current" />
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">
                            {mixDateLabel(m)}
                          </div>
                          <div className="truncate font-mono text-[11px] text-muted-foreground">
                            {m.filename} · {formatBytes(m.size_bytes)}
                          </div>
                        </div>
                        <Button
                          asChild
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                        >
                          <a
                            href={mediaUrl(m.path)}
                            download={m.filename}
                            title="Download"
                            aria-label={`Download ${m.filename}`}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>
                        </Button>
                        <button
                          type="button"
                          onClick={() => handleSingleDelete(m)}
                          aria-label={
                            isConfirming
                              ? "Confirm delete"
                              : `Delete ${m.filename}`
                          }
                          title={
                            isConfirming ? "Click again to delete" : "Delete"
                          }
                          className={cn(
                            "flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                            isConfirming
                              ? "bg-destructive/15 text-destructive ring-1 ring-destructive/40"
                              : "text-muted-foreground/70 hover:bg-destructive/10 hover:text-destructive",
                          )}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {isConfirming && "Delete?"}
                        </button>
                      </div>
                    )}

                    {isActive && !selectMode && (
                      <div className="border-t border-border/60 p-2">
                        <Player
                          src={mediaUrl(m.path)}
                          title={m.filename}
                          autoPlay
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  )
}
