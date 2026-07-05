import { useEffect, useRef, useState } from "react"
import {
  Check,
  Copy,
  Globe,
  Loader2,
  ListMusic,
  RefreshCw,
  Search,
  Music,
  Pause,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react"
import { toast } from "sonner"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  useAnalyze,
  useAnalyzeAll,
  useSetCues,
  useCancelJob,
  useDeleteTrack,
  useRefreshTitles,
  useRenameTrack,
  useTracks,
} from "@/api/client"
import type { Drop, Track } from "@/api/types"
import type { ProgressMap } from "@/hooks/useProgressSocket"
import { displayTitle, formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import { apiUrl } from "@/lib/backend"
import { KeyChip } from "@/components/KeyChip"

interface TrackListProps {
  progress: ProgressMap
  selectedId: string | null
  onSelect: (track: Track) => void
  onAdd: (track: Track, drop?: Drop) => void
  onPreviewDrop?: (track: Track, drop: Drop) => void
  onPausePreview?: () => void
  /** "trackId:startS" of the drop currently playing (null if paused/idle). */
  playingKey?: string | null
  /** Set of "trackId:startS" keys for drops already in the mix. */
  addedKeys?: Set<string>
  /** BPM of the last clip in the mix — used to highlight compatible tracks. */
  referenceBpm?: number | null
}

export function TrackList({
  progress,
  selectedId,
  onSelect,
  onAdd,
  onPreviewDrop,
  onPausePreview,
  playingKey,
  addedKeys,
  referenceBpm,
}: TrackListProps) {
  const qc = useQueryClient()
  const tracks = useTracks()
  const analyze = useAnalyze()
  const deleteTrack = useDeleteTrack()
  const renameTrack = useRenameTrack()
  const analyzeAll = useAnalyzeAll()
  const cancelJob = useCancelJob()
  const [jobByTrack, setJobByTrack] = useState<Record<string, string>>({})

  // "Analyze all" runs as one sequential backend job.
  const [allJobId, setAllJobId] = useState<string | null>(null)
  const allP = allJobId ? progress[allJobId] : undefined
  const allRunning = !!allJobId && !allP?.done
  const allNotifiedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!allJobId || !allP?.done) return
    if (allNotifiedRef.current === allJobId) return
    allNotifiedRef.current = allJobId
    tracks.refetch()
    if (allP.message === "Cancelled") toast.info("Analysis cancelled")
    else if (allP.message.toLowerCase().startsWith("error"))
      toast.error(`Analyze all failed: ${allP.message}`)
    else toast.success(allP.message || "Analysis complete")
    setAllJobId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allJobId, allP])

  const startAnalyzeAll = () => {
    analyzeAll.mutate(undefined, {
      onSuccess: (res) => setAllJobId(res.job_id),
      onError: (e) => toast.error(`Analyze all failed: ${e.message}`),
    })
  }

  // Search filter.
  const [query, setQuery] = useState("")

  // Inline title editing.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")

  const startEdit = (t: Track) => {
    setEditingId(t.id)
    setEditValue(displayTitle(t))
  }

  const commitEdit = (t: Track) => {
    const title = editValue.trim()
    setEditingId(null)
    if (!title || title === displayTitle(t)) return
    renameTrack.mutate(
      { trackId: t.id, title },
      {
        onSuccess: () => toast.success("Track renamed", { description: title }),
        onError: (e) => toast.error(`Rename failed: ${e.message}`),
      },
    )
  }

  // Bulk rename modal: edit every title in one place.
  const refreshTitles = useRefreshTitles()
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkEdits, setBulkEdits] = useState<Record<string, string>>({})
  const [bulkSaving, setBulkSaving] = useState(false)

  const openBulkRename = () => {
    const map: Record<string, string> = {}
    for (const t of tracks.data ?? []) map[t.id] = displayTitle(t)
    setBulkEdits(map)
    setBulkOpen(true)
  }

  const saveBulkRename = async () => {
    const list = tracks.data ?? []
    const changed = list.filter(
      (t) =>
        bulkEdits[t.id] != null &&
        bulkEdits[t.id].trim() &&
        bulkEdits[t.id].trim() !== displayTitle(t),
    )
    if (changed.length === 0) {
      setBulkOpen(false)
      return
    }
    setBulkSaving(true)
    const results = await Promise.allSettled(
      changed.map((t) =>
        renameTrack.mutateAsync({ trackId: t.id, title: bulkEdits[t.id].trim() }),
      ),
    )
    setBulkSaving(false)
    const ok = results.filter((r) => r.status === "fulfilled").length
    const failed = results.length - ok
    if (failed === 0) toast.success(`Renamed ${ok} track${ok === 1 ? "" : "s"}`)
    else toast.error(`Renamed ${ok}, failed ${failed}`)
    setBulkOpen(false)
    qc.invalidateQueries({ queryKey: ["tracks"] })
  }

  const fetchTitlesOnline = () => {
    refreshTitles.mutate(undefined, {
      onSuccess: async (res) => {
        toast.success(
          res.updated > 0
            ? `Fetched ${res.updated} title${res.updated === 1 ? "" : "s"} from catalog`
            : "Titles already match the online catalog",
        )
        const fresh = await tracks.refetch()
        const map: Record<string, string> = {}
        for (const t of fresh.data ?? []) map[t.id] = displayTitle(t)
        setBulkEdits(map)
      },
      onError: (e) => toast.error(`Fetch failed: ${e.message}`),
    })
  }

  // Tracklist cues (full DJ sets): paste "0:00 - Artist - Title" lines.
  const setCues = useSetCues()
  const [cuesTrack, setCuesTrack] = useState<Track | null>(null)
  const [cuesText, setCuesText] = useState("")

  const saveCues = () => {
    if (!cuesTrack || !cuesText.trim()) return
    setCues.mutate(
      { trackId: cuesTrack.id, text: cuesText },
      {
        onSuccess: (res) => {
          toast.success(`${res.cues} cues saved, ${res.labeled} drops labeled`)
          setCuesTrack(null)
          setCuesText("")
        },
        onError: (e) => toast.error(`Tracklist failed: ${e.message}`),
      },
    )
  }

  const copyTitle = async (t: Track) => {
    try {
      await navigator.clipboard.writeText(displayTitle(t))
      toast.success("Title copied", { description: displayTitle(t) })
    } catch {
      toast.error("Could not access the clipboard")
    }
  }

  // Single-row delete: first click arms the confirm, second click deletes.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const confirmTimerRef = useRef<number | null>(null)

  // Batch selection mode.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmBatch, setConfirmBatch] = useState(false)
  const batchTimerRef = useRef<number | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)

  const handleDeleteClick = (t: Track) => {
    if (confirmDeleteId !== t.id) {
      setConfirmDeleteId(t.id)
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = window.setTimeout(
        () => setConfirmDeleteId(null),
        3000,
      )
      return
    }
    if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current)
    setConfirmDeleteId(null)
    deleteTrack.mutate(t.id, {
      onSuccess: () => toast.success("Track deleted", { description: displayTitle(t) }),
      onError: (e) => toast.error(`Delete failed: ${e.message}`),
    })
  }

  const toggleSelectMode = () => {
    setSelectMode((s) => !s)
    setSelectedIds(new Set())
    setConfirmBatch(false)
  }

  const toggleSelected = (id: string) => {
    setConfirmBatch(false)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
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
    const ids = [...selectedIds]
    const results = await Promise.allSettled(
      ids.map((id) => deleteTrack.mutateAsync(id)),
    )
    setBatchBusy(false)
    const ok = results.filter((r) => r.status === "fulfilled").length
    const failed = results.length - ok
    if (failed === 0) {
      toast.success(`Deleted ${ok} track${ok === 1 ? "" : "s"}`)
    } else {
      toast.error(`Deleted ${ok}, failed ${failed}`, {
        description: "Some tracks could not be removed. The list has been refreshed.",
      })
    }
    setSelectedIds(new Set())
    setSelectMode(false)
    qc.invalidateQueries({ queryKey: ["tracks"] })
  }

  useEffect(() => {
    Object.entries(jobByTrack).forEach(([trackId, jobId]) => {
      const p = progress[jobId]
      if (p?.done) {
        setJobByTrack((prev) => {
          const next = { ...prev }
          delete next[trackId]
          return next
        })
        tracks.refetch()
      }
    })
  }, [progress, jobByTrack, tracks])

  if (tracks.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading tracks
      </div>
    )
  }

  if (tracks.isError) {
    return (
      <div className="p-4 text-sm text-destructive">
        Cannot connect to backend
      </div>
    )
  }

  // Sort by BPM ascending so same-tempo tracks cluster together (tracks that
  // beat-match each other end up adjacent). Unanalyzed tracks go last.
  const items = [...(tracks.data ?? [])].sort((a, b) => {
    const ba = a.analysis?.bpm
    const bb = b.analysis?.bpm
    if (ba == null && bb == null) return 0
    if (ba == null) return 1
    if (bb == null) return -1
    return ba - bb
  })
  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Music className="h-6 w-6 text-muted-foreground/50" />
        <div className="text-sm font-medium text-muted-foreground">
          No tracks yet
        </div>
        <div className="text-xs leading-relaxed text-muted-foreground/70">
          Paste a YouTube playlist in the Auto-Mix panel to get started, or
          drop MP4s into <code className="rounded bg-muted px-1">videos/</code>
        </div>
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const visibleItems = q
    ? items.filter(
        (t) =>
          displayTitle(t).toLowerCase().includes(q) ||
          t.filename.toLowerCase().includes(q) ||
          (t.analysis?.drops ?? []).some((d) =>
            (d.title ?? "").toLowerCase().includes(q),
          ),
      )
    : items
  const allSelected = items.length > 0 && selectedIds.size === items.length
  const unanalyzedCount = items.filter((t) => !t.analyzed).length

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2 border-b border-border/40 px-2 py-1">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleSelectMode}
            className="h-6 px-2 text-xs"
          >
            {selectMode ? "Done" : "Select"}
          </Button>
          {!selectMode && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectMode(true)
                setSelectedIds(new Set(items.map((t) => t.id)))
              }}
              title="Select every track (then Delete selected)"
              className="h-6 px-2 text-xs text-muted-foreground"
            >
              Select all
            </Button>
          )}
          {!selectMode && (
            <Button
              variant="ghost"
              size="sm"
              onClick={openBulkRename}
              title="Rename all tracks in one place"
              className="h-6 px-2 text-xs text-muted-foreground"
            >
              Rename
            </Button>
          )}
          {!selectMode && unanalyzedCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={allRunning || analyzeAll.isPending}
              onClick={startAnalyzeAll}
              title="Analyze every track that hasn't been analyzed yet"
              className="h-6 px-2 text-xs text-muted-foreground"
            >
              {allRunning || analyzeAll.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3" />
              )}
              Analyze all ({unanalyzedCount})
            </Button>
          )}
          {selectMode && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-[var(--primary)]"
                checked={allSelected}
                onChange={() =>
                  setSelectedIds(
                    allSelected
                      ? new Set()
                      : new Set(items.map((t) => t.id)),
                  )
                }
              />
              Select all
            </label>
          )}
        </div>
        {selectMode && selectedIds.size > 0 && (
          <Button
            variant="destructive"
            size="sm"
            disabled={batchBusy}
            onClick={handleBatchDelete}
            className="h-6 px-2 text-xs"
          >
            {batchBusy ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            {confirmBatch
              ? `Really delete ${selectedIds.size}?`
              : `Delete selected (${selectedIds.size})`}
          </Button>
        )}
      </div>

      <div className="border-b border-border/40 px-2 py-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tracks"
            aria-label="Search tracks"
            className="h-7 w-full rounded-md border border-border/60 bg-background/60 pl-7 pr-2 text-xs focus-visible:outline-2 focus-visible:outline-ring"
          />
        </div>
      </div>

      {allRunning && (
        <div className="space-y-1 border-b border-border/40 px-3 py-2">
          <div className="flex items-center gap-2">
            <Progress value={allP?.percent ?? 0} className="h-1 flex-1" />
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
              {(allP?.percent ?? 0).toFixed(0)}%
            </span>
            <button
              type="button"
              disabled={cancelJob.isPending}
              onClick={() =>
                allJobId &&
                cancelJob.mutate(allJobId, {
                  onError: (e) => toast.error(`Cancel failed: ${e.message}`),
                })
              }
              title="Cancel analysis"
              className="shrink-0 rounded border border-destructive/40 bg-destructive/10 px-1.5 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          <div className="truncate text-[11px] text-muted-foreground" title={allP?.message}>
            {allP?.message || "Starting…"}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      {q && visibleItems.length === 0 && (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          No tracks match "{query.trim()}"
        </div>
      )}
      <ul className="min-w-0 divide-y divide-border/40">
        {visibleItems.map((t) => {
          const jobId = jobByTrack[t.id]
          const p = jobId ? progress[jobId] : undefined
          const isAnalyzing = !!jobId && (!p || !p.done)
          const isConfirmingDelete = confirmDeleteId === t.id
          const isChecked = selectedIds.has(t.id)
          return (
            <li
              key={t.id}
              className={cn(
                "group relative flex flex-col gap-2 border-l-2 border-transparent px-3.5 py-2.5 transition-colors hover:bg-accent/20",
                !selectMode &&
                  selectedId === t.id &&
                  "border-l-primary bg-primary/10",
                selectMode && isChecked && "border-l-primary bg-primary/10",
              )}
            >
              <div className="flex min-w-0 items-start gap-2">
                {selectMode && (
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)]"
                    checked={isChecked}
                    onChange={() => toggleSelected(t.id)}
                    aria-label={`Select ${displayTitle(t)}`}
                    tabIndex={-1}
                  />
                )}
                {editingId === t.id ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Music className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit(t)
                        else if (e.key === "Escape") setEditingId(null)
                      }}
                      onBlur={() => commitEdit(t)}
                      aria-label="Track title"
                      className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                    />
                  </div>
                ) : (
                <button
                  onClick={() =>
                    selectMode ? toggleSelected(t.id) : onSelect(t)
                  }
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {!selectMode && (
                    <Music className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div
                      className="line-clamp-2 break-words text-sm font-medium leading-snug"
                      title={t.filename}
                    >
                      {displayTitle(t)}
                    </div>
                    {!t.analysis && (
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {formatDuration(t.duration_s)}
                      </span>
                    )}
                  </div>
                </button>
                )}
                {!selectMode && editingId !== t.id && (
                  <>
                    <button
                      type="button"
                      onClick={() => copyTitle(t)}
                      aria-label={`Copy title of ${displayTitle(t)}`}
                      title="Copy title"
                      className="-mr-1 flex h-6 shrink-0 items-center rounded-md px-1 text-muted-foreground/60 opacity-0 transition-all hover:bg-accent/60 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    {t.analyzed && (
                      <button
                        type="button"
                        disabled={isAnalyzing}
                        onClick={() =>
                          analyze.mutate(
                            { track_id: t.id },
                            {
                              onSuccess: (res) =>
                                setJobByTrack((prev) => ({
                                  ...prev,
                                  [t.id]: res.job_id,
                                })),
                              onError: (e) =>
                                toast.error(`Re-analyze failed: ${e.message}`),
                            },
                          )
                        }
                        aria-label={`Re-analyze ${displayTitle(t)}`}
                        title="Re-analyze this track (keeps its tracklist cues)"
                        className="-mr-1 flex h-6 shrink-0 items-center rounded-md px-1 text-muted-foreground/60 opacity-0 transition-all hover:bg-accent/60 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100 disabled:opacity-40"
                      >
                        <RefreshCw
                          className={cn("h-3.5 w-3.5", isAnalyzing && "animate-spin")}
                        />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setCuesTrack(t)
                        setCuesText("")
                      }}
                      aria-label={`Paste tracklist for ${displayTitle(t)}`}
                      title="Paste a tracklist (for full DJ sets) to label the drops"
                      className="-mr-1 flex h-6 shrink-0 items-center rounded-md px-1 text-muted-foreground/60 opacity-0 transition-all hover:bg-accent/60 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100"
                    >
                      <ListMusic className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(t)}
                      aria-label={`Rename ${displayTitle(t)}`}
                      title="Rename track"
                      className="-mr-1 flex h-6 shrink-0 items-center rounded-md px-1 text-muted-foreground/60 opacity-0 transition-all hover:bg-accent/60 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover:opacity-100"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
                {!selectMode && (
                  <button
                    type="button"
                    onClick={() => handleDeleteClick(t)}
                    aria-label={
                      isConfirmingDelete
                        ? "Confirm delete"
                        : `Delete ${displayTitle(t)}`
                    }
                    title={
                      isConfirmingDelete
                        ? "Click again to delete"
                        : "Delete track"
                    }
                    className={cn(
                      "-mr-1 flex h-6 shrink-0 items-center gap-1 rounded-md px-1 text-[11px] font-medium transition-all focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring",
                      isConfirmingDelete
                        ? "bg-destructive/15 text-destructive opacity-100 ring-1 ring-destructive/40"
                        : "text-muted-foreground/60 opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100",
                    )}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {isConfirmingDelete && "Delete?"}
                  </button>
                )}
              </div>

              {t.analysis && (() => {
                const bpm = t.analysis.bpm
                const bpmDiff = referenceBpm
                  ? Math.abs(referenceBpm - bpm) / referenceBpm
                  : 0
                const bpmCompat = !referenceBpm
                  ? "neutral"
                  : bpmDiff <= 0.05
                    ? "good"
                    : bpmDiff <= 0.1
                      ? "warn"
                      : "bad"
                return (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge
                      variant="secondary"
                      className={cn(
                        "font-mono text-[11px] tabular-nums",
                        bpmCompat === "good" &&
                          "bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/40 dark:bg-emerald-500/20 dark:text-emerald-300",
                        bpmCompat === "warn" &&
                          "bg-amber-500/15 text-amber-700 ring-1 ring-amber-500/40 dark:bg-amber-500/20 dark:text-amber-300",
                        bpmCompat === "bad" &&
                          "bg-rose-500/15 text-rose-700 ring-1 ring-rose-500/40 dark:bg-rose-500/20 dark:text-rose-300",
                      )}
                      title={
                        referenceBpm
                          ? `Last clip: ${referenceBpm.toFixed(0)} BPM (${(bpmDiff * 100).toFixed(0)}% off)`
                          : `${bpm.toFixed(1)} BPM`
                      }
                    >
                      {bpm.toFixed(0)}
                    </Badge>
                    <KeyChip keyCamelot={t.analysis.key_camelot} />
                    <Badge
                      variant="outline"
                      className="border-border/60 font-mono text-[11px] tabular-nums text-muted-foreground"
                    >
                      {formatDuration(t.duration_s)}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="border-border/60 text-[11px] tabular-nums text-muted-foreground"
                    >
                      {t.analysis.lufs.toFixed(1)} LU
                    </Badge>
                  </div>
                )
              })()}

              {isAnalyzing && (
                <div className="space-y-1">
                  <Progress value={p?.percent ?? 0} />
                  <div className="truncate text-xs text-muted-foreground">
                    {p?.stage ?? "analyzing"}: {p?.message ?? "starting"}
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                {!t.analyzed ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isAnalyzing}
                    onClick={() => {
                      analyze.mutate(
                        { track_id: t.id },
                        {
                          onSuccess: (res) => {
                            setJobByTrack((prev) => ({
                              ...prev,
                              [t.id]: res.job_id,
                            }))
                          },
                          onError: (e) => {
                            toast.error(`Analyze failed: ${e.message}`)
                          },
                        },
                      )
                    }}
                  >
                    {isAnalyzing ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                    Analyze
                  </Button>
                ) : (
                  (() => {
                    const allDrops = t.analysis?.drops ?? []
                    const trackNameMatch =
                      !q ||
                      displayTitle(t).toLowerCase().includes(q) ||
                      t.filename.toLowerCase().includes(q)
                    const dropPairs = allDrops
                      .map((d, i) => ({ d, i }))
                      .filter(
                        ({ d }) =>
                          trackNameMatch ||
                          (d.title ?? "").toLowerCase().includes(q),
                      )
                    const drops = dropPairs.map((p) => p.d)
                    if (drops.length === 0) {
                      return (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full justify-start gap-1.5 px-2"
                          onClick={() => onAdd(t)}
                        >
                          <Plus className="h-3 w-3" /> Add to mix
                        </Button>
                      )
                    }
                    return (
                      <ul className="flex w-full min-w-0 flex-col gap-1.5">
                        {t.duration_s > 600 && (
                          <li>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 w-full justify-center gap-1.5 text-xs"
                              title="Paste or fetch this set's tracklist to label the drops with song names"
                              onClick={() => {
                                setCuesTrack(t)
                                setCuesText("")
                              }}
                            >
                              <ListMusic className="h-3 w-3" /> Tracklist
                            </Button>
                          </li>
                        )}
                        {drops.length > 1 && (
                          <li>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 w-full justify-center gap-1.5 text-xs"
                              onClick={() => {
                                // Alternates (primary=false) are for manual
                                // swapping; bulk-add takes one per song.
                                const picks = drops.filter(
                                  (d) => d.primary !== false,
                                )
                                picks.forEach((d) => onAdd(t, d))
                                toast.success(
                                  `Added ${picks.length} drops to the mix`,
                                  { description: displayTitle(t) },
                                )
                              }}
                            >
                              <Plus className="h-3 w-3" /> Add all{" "}
                              {drops.filter((d) => d.primary !== false).length}{" "}
                              drops
                            </Button>
                          </li>
                        )}
                        {(() => {
                          // Folder tree: one node per song, its drop
                          // candidates (main + alts) nested underneath.
                          const groups: {
                            title: string | null
                            items: typeof dropPairs
                          }[] = []
                          for (const p of dropPairs) {
                            const g = groups[groups.length - 1]
                            const ttl = p.d.title ?? null
                            if (g && g.title !== null && g.title === ttl)
                              g.items.push(p)
                            else groups.push({ title: ttl, items: [p] })
                          }
                          const retitle = async (oldTitle: string) => {
                            const next = window.prompt(
                              "Song title for this drop group",
                              oldTitle,
                            )
                            if (!next || next.trim() === oldTitle) return
                            try {
                              const res = await fetch(
                                apiUrl(`/api/tracks/${t.id}/drops/retitle`),
                                {
                                  method: "POST",
                                  headers: {
                                    "Content-Type": "application/json",
                                  },
                                  body: JSON.stringify({
                                    old_title: oldTitle,
                                    new_title: next.trim(),
                                  }),
                                },
                              )
                              if (!res.ok) throw new Error(await res.text())
                              toast.success("Title updated")
                              qc.invalidateQueries({ queryKey: ["tracks"] })
                            } catch {
                              toast.error("Could not update the title")
                            }
                          }
                          const renderRow = (
                            { d, i }: (typeof dropPairs)[number],
                            showTitle: boolean,
                            role?: "main" | "alt" | "weak",
                          ) => {
                          const badgeRole =
                            role ?? (d.primary ? "main" : "alt")
                          const dropKey = `${t.id}:${d.start_s.toFixed(2)}`
                          const isAdded = !!addedKeys?.has(dropKey)
                          const isPlayingThis = playingKey === dropKey
                          return (
                            <li
                              key={i}
                              className={cn(
                                "flex h-9 items-stretch overflow-hidden rounded-lg border transition-colors",
                                isAdded
                                  ? "border-emerald-500/40 bg-emerald-500/10"
                                  : "border-border/60 bg-background hover:border-border hover:bg-accent/30",
                              )}
                            >
                              <button
                                type="button"
                                className={cn(
                                  "flex w-9 shrink-0 items-center justify-center border-r text-primary transition-colors hover:bg-primary/15 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                                  isAdded
                                    ? "border-emerald-500/30"
                                    : "border-border/60",
                                )}
                                onClick={() => {
                                  if (isPlayingThis) onPausePreview?.()
                                  else onPreviewDrop?.(t, d)
                                }}
                                title={
                                  isPlayingThis
                                    ? "Pause preview"
                                    : "Preview this drop"
                                }
                                aria-label={
                                  isPlayingThis
                                    ? "Pause"
                                    : `Preview drop ${i + 1}`
                                }
                              >
                                {isPlayingThis ? (
                                  <Pause className="h-3.5 w-3.5 fill-current" />
                                ) : (
                                  <Play className="h-3.5 w-3.5 fill-current" />
                                )}
                              </button>
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 text-left text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                                onClick={() => {
                                  onAdd(t, d)
                                  toast.success(
                                    `Added Drop ${i + 1} · ${formatDuration(
                                      d.start_s,
                                    )}–${formatDuration(d.end_s)}`,
                                    {
                                      description: displayTitle(t),
                                    },
                                  )
                                }}
                                title={`Add Drop ${i + 1} to the mix`}
                              >
                                <span className="flex min-w-0 items-center gap-1.5 font-medium">
                                  {isAdded ? (
                                    <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                  ) : (
                                    <Zap className="h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" />
                                  )}
                                  {showTitle && (
                                    <span className="truncate" title={d.title ?? undefined}>
                                      {d.title ?? `Drop ${i + 1}`}
                                    </span>
                                  )}
                                  {d.primary !== undefined && (
                                    <span
                                      className={
                                        "shrink-0 rounded px-1 text-[10px] uppercase " +
                                        (badgeRole === "main"
                                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                                          : badgeRole === "alt"
                                            ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                            : "bg-red-500/15 text-red-600 dark:text-red-400")
                                      }
                                      title="Confidence this is the song's main drop"
                                    >
                                      {d.primary ? "main" : "alt"}
                                      {d.confidence != null &&
                                        ` ${Math.round(d.confidence * 100)}%`}
                                    </span>
                                  )}
                                </span>
                                <span className="truncate font-mono text-[11px] tabular-nums text-muted-foreground">
                                  {formatDuration(d.start_s)}–
                                  {formatDuration(d.end_s)}
                                </span>
                              </button>
                            </li>
                          )
                          }
                          return groups.map((g) =>
                            g.title !== null && g.items.length > 1 ? (
                              <li
                                key={`g-${g.items[0].i}`}
                                className="flex flex-col gap-1"
                              >
                                <div className="group/gt flex items-center gap-1.5 px-1 text-[11px] font-medium">
                                  <ListMusic className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  <span className="truncate" title={g.title}>
                                    {g.title}
                                  </span>
                                  <button
                                    type="button"
                                    className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/gt:opacity-100"
                                    title="Edit this song's title"
                                    onClick={() => retitle(g.title!)}
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </button>
                                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                                    {g.items.length} drops
                                  </span>
                                </div>
                                <ul className="ml-1.5 flex flex-col gap-1 border-l border-border/60 pl-2">
                                  {(() => {
                                    // Most confident on top: main first,
                                    // then alts by confidence; the weakest
                                    // alt gets the red badge.
                                    const sorted = [...g.items].sort(
                                      (a, b) =>
                                        (b.d.primary ? 1 : 0) -
                                          (a.d.primary ? 1 : 0) ||
                                        (b.d.confidence ?? 0) -
                                          (a.d.confidence ?? 0),
                                    )
                                    const altCount = sorted.filter(
                                      (p) => !p.d.primary,
                                    ).length
                                    return sorted.map((p, idx) =>
                                      renderRow(
                                        p,
                                        false,
                                        p.d.primary
                                          ? "main"
                                          : idx === sorted.length - 1 &&
                                              altCount > 1
                                            ? "weak"
                                            : "alt",
                                      ),
                                    )
                                  })()}
                                </ul>
                              </li>
                            ) : (
                              g.items.map((p) => renderRow(p, true))
                            ),
                          )
                        })()}
                      </ul>
                    )
                  })()
                )}
              </div>
            </li>
          )
        })}
      </ul>
      </div>

      <Dialog open={!!cuesTrack} onOpenChange={(o) => !o && setCuesTrack(null)}>
        <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ListMusic className="h-4 w-4 text-primary" />
              Tracklist for {cuesTrack ? displayTitle(cuesTrack) : ""}
            </DialogTitle>
          </DialogHeader>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Paste one track per line, like "1:37 - Artist - Title". Timestamps
            map each detected drop to its song; a list without timestamps
            labels the drops in order.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={setCues.isPending}
            className="self-start text-xs"
            onClick={() => {
              if (!cuesTrack) return
              setCues.mutate(
                { trackId: cuesTrack.id, auto: true },
                {
                  onSuccess: (res) => {
                    toast.success(
                      `Fetched ${res.cues} cues from YouTube, ${res.labeled} drops labeled`,
                    )
                    setCuesTrack(null)
                  },
                  onError: (e) => toast.error(`Fetch failed: ${e.message}`),
                },
              )
            }}
          >
            {setCues.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Globe className="h-3.5 w-3.5" />
            )}
            Fetch from YouTube (chapters/description)
          </Button>
          <textarea
            value={cuesText}
            onChange={(e) => setCuesText(e.target.value)}
            placeholder={"0:00 - Intro\n1:37 - Artist - Title\n..."}
            spellCheck={false}
            className="min-h-48 w-full flex-1 resize-y rounded-md border border-border bg-background p-2 font-mono text-xs focus-visible:outline-2 focus-visible:outline-ring"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCuesTrack(null)}>
              Cancel
            </Button>
            <Button size="sm" disabled={setCues.isPending || !cuesText.trim()} onClick={saveCues}>
              {setCues.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save tracklist
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Rename tracks</DialogTitle>
          </DialogHeader>
          <Button
            variant="outline"
            size="sm"
            disabled={refreshTitles.isPending}
            onClick={fetchTitlesOnline}
            title="Look up canonical titles on Deezer/iTunes and fill them in"
            className="self-start text-xs"
          >
            {refreshTitles.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Globe className="h-3.5 w-3.5" />
            )}
            Fetch proper titles online
          </Button>
          <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {(tracks.data ?? []).map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <span
                  className="w-28 shrink-0 truncate text-[11px] text-muted-foreground"
                  title={t.filename}
                >
                  {t.filename}
                </span>
                <input
                  value={bulkEdits[t.id] ?? ""}
                  onChange={(e) =>
                    setBulkEdits((prev) => ({ ...prev, [t.id]: e.target.value }))
                  }
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={`Title for ${t.filename}`}
                />
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={bulkSaving} onClick={saveBulkRename}>
              {bulkSaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
