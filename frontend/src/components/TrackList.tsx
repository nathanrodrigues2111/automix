import { useEffect, useState } from "react"
import { Check, Loader2, Music, Pause, Play, Plus, Sparkles, Zap } from "lucide-react"
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
  onPausePreview?: () => void
  /** "trackId:startS" of the drop currently playing (null if paused/idle). */
  playingKey?: string | null
  /** Set of "trackId:startS" keys for drops already in the mix. */
  addedKeys?: Set<string>
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
}: TrackListProps) {
  const tracks = useTracks()
  const analyze = useAnalyze()
  const [jobByTrack, setJobByTrack] = useState<Record<string, string>>({})

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
                        {drops.map((d, i) => {
                          const dropKey = `${t.id}:${d.start_s.toFixed(2)}`
                          const isAdded = !!addedKeys?.has(dropKey)
                          const isPlayingThis = playingKey === dropKey
                          return (
                            <li
                              key={i}
                              className={cn(
                                "flex h-9 items-stretch overflow-hidden rounded-md border border-input bg-background shadow-xs transition-colors",
                                isAdded
                                  ? "border-emerald-500/40 bg-emerald-500/10"
                                  : "hover:bg-accent/40",
                              )}
                            >
                              <button
                                type="button"
                                className="flex w-9 shrink-0 items-center justify-center border-r border-input text-primary hover:bg-primary/15"
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
                                className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 text-left text-xs"
                                onClick={() => {
                                  onAdd(t, d)
                                  toast.success(
                                    `Added Drop ${i + 1} · ${formatDuration(
                                      d.start_s,
                                    )}–${formatDuration(d.end_s)}`,
                                    {
                                      description: formatTrackTitle(t.filename),
                                    },
                                  )
                                }}
                                title={`Add Drop ${i + 1} to the mix`}
                              >
                                <span className="flex shrink-0 items-center gap-1.5 font-medium">
                                  {isAdded ? (
                                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                                  ) : (
                                    <Zap className="h-3.5 w-3.5 text-amber-400" />
                                  )}
                                  Drop {i + 1}
                                </span>
                                <span className="truncate font-mono tabular-nums text-muted-foreground">
                                  {formatDuration(d.start_s)}–
                                  {formatDuration(d.end_s)}
                                </span>
                              </button>
                            </li>
                          )
                        })}
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
  )
}
