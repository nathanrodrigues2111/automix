import { useEffect, useState } from "react"
import { Check, ChevronDown, Loader2, Music, Play, Plus, Sparkles, Zap } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { useAnalyze, useTracks } from "@/api/client"
import type { Drop, Track } from "@/api/types"
import type { ProgressMap } from "@/hooks/useProgressSocket"
import { formatDuration, formatTrackTitle } from "@/lib/format"
import { cn } from "@/lib/utils"
import { KeyChip } from "@/components/KeyChip"

interface TrackListProps {
  progress: ProgressMap
  selectedId: string | null
  onSelect: (track: Track) => void
  onAdd: (track: Track, drop?: Drop) => void
  onPreviewDrop?: (track: Track, drop: Drop) => void
  /** Set of "trackId:startS" keys for drops already in the mix. */
  addedKeys?: Set<string>
}

export function TrackList({
  progress,
  selectedId,
  onSelect,
  onAdd,
  onPreviewDrop,
  addedKeys,
}: TrackListProps) {
  const tracks = useTracks()
  const analyze = useAnalyze()
  const [jobByTrack, setJobByTrack] = useState<Record<string, string>>({})
  const [openDrops, setOpenDrops] = useState<string | null>(null)

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

  const items = tracks.data ?? []
  if (items.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No MP4s found in <code>videos/</code>
      </div>
    )
  }

  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden">
      <ul className="min-w-0 divide-y divide-border/40">
        {items.map((t) => {
          const jobId = jobByTrack[t.id]
          const p = jobId ? progress[jobId] : undefined
          const isAnalyzing = !!jobId && (!p || !p.done)
          return (
            <li
              key={t.id}
              className={cn(
                "group relative flex flex-col gap-1.5 border-l-2 border-transparent px-3 py-2 transition-colors hover:bg-accent/20",
                selectedId === t.id &&
                  "border-l-primary bg-primary/5",
              )}
            >
              <button
                onClick={() => onSelect(t)}
                className="flex min-w-0 items-start gap-2 text-left"
              >
                <Music className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <div
                    className="line-clamp-2 break-words text-sm font-medium leading-snug"
                    title={t.filename}
                  >
                    {formatTrackTitle(t.filename)}
                  </div>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {formatDuration(t.duration_s)}
                  </span>
                </div>
              </button>

              {t.analysis && (
                <div className="flex flex-wrap items-center gap-1">
                  <Badge variant="secondary" className="font-mono text-[10px] tabular-nums">
                    {t.analysis.bpm.toFixed(0)}
                  </Badge>
                  <KeyChip keyCamelot={t.analysis.key_camelot} />
                  <Badge variant="outline" className="text-[10px] tabular-nums text-muted-foreground">
                    {t.analysis.lufs.toFixed(1)} LU
                  </Badge>
                </div>
              )}

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
                    const drops = t.analysis?.drops ?? []
                    const isOpen = openDrops === t.id
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
                      <div className="flex w-full min-w-0 flex-col gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full justify-between gap-2 px-2"
                          onClick={() => setOpenDrops(isOpen ? null : t.id)}
                        >
                          <span className="flex items-center gap-1.5">
                            <Plus className="h-3 w-3" />
                            Pick a drop ({drops.length})
                          </span>
                          <ChevronDown
                            className={cn(
                              "h-3 w-3 shrink-0 text-muted-foreground transition-transform",
                              isOpen && "rotate-180",
                            )}
                          />
                        </Button>
                        {isOpen && (
                          <ul className="space-y-0.5 rounded-md border border-border/60 bg-background/60 p-1">
                            {drops.map((d, i) => {
                              const isAdded = !!addedKeys?.has(
                                `${t.id}:${d.start_s.toFixed(2)}`,
                              )
                              return (
                              <li key={i} className="flex items-center gap-1">
                                <button
                                  type="button"
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-primary hover:bg-primary/10"
                                  onClick={() => onPreviewDrop?.(t, d)}
                                  title="Preview this drop"
                                  aria-label={`Preview drop ${i + 1}`}
                                >
                                  <Play className="h-3 w-3 fill-current" />
                                </button>
                                <button
                                  type="button"
                                  className={cn(
                                    "flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/40",
                                    isAdded &&
                                      "bg-emerald-500/10 ring-1 ring-emerald-500/30",
                                  )}
                                  onClick={() => {
                                    onAdd(t, d)
                                    setOpenDrops(null)
                                    toast.success(
                                      `Added Drop ${i + 1} · ${formatDuration(
                                        d.start_s,
                                      )}–${formatDuration(d.end_s)}`,
                                      {
                                        description: formatTrackTitle(
                                          t.filename,
                                        ),
                                      },
                                    )
                                  }}
                                  title={`Add Drop ${i + 1} to the mix`}
                                >
                                  <span className="flex shrink-0 items-center gap-1.5 font-medium">
                                    {isAdded ? (
                                      <Check className="h-3 w-3 text-emerald-400" />
                                    ) : (
                                      <Zap className="h-3 w-3 text-amber-400" />
                                    )}
                                    Drop {i + 1}
                                  </span>
                                  <span className="truncate font-mono tabular-nums text-muted-foreground">
                                    {formatDuration(d.start_s)}–
                                    {formatDuration(d.end_s)}
                                  </span>
                                </button>
                              </li>
                            )})}
                          </ul>
                        )}
                      </div>
                    )
                  })()
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
