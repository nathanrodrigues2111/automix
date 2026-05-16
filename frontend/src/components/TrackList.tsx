import { useEffect, useState } from "react"
import { Loader2, Music, Plus, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAnalyze, useTracks } from "@/api/client"
import type { Track } from "@/api/types"
import type { ProgressMap } from "@/hooks/useProgressSocket"
import { formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"

interface TrackListProps {
  progress: ProgressMap
  selectedId: string | null
  onSelect: (track: Track) => void
  onAdd: (track: Track) => void
}

export function TrackList({ progress, selectedId, onSelect, onAdd }: TrackListProps) {
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
    <ScrollArea className="h-full">
      <ul className="divide-y divide-border">
        {items.map((t) => {
          const jobId = jobByTrack[t.id]
          const p = jobId ? progress[jobId] : undefined
          const isAnalyzing = !!jobId && (!p || !p.done)
          return (
            <li
              key={t.id}
              className={cn(
                "flex flex-col gap-2 px-3 py-3 transition-colors hover:bg-accent/30",
                selectedId === t.id && "bg-accent/50",
              )}
            >
              <button
                onClick={() => onSelect(t)}
                className="flex items-start gap-2 text-left"
              >
                <Music className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {t.filename}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatDuration(t.duration_s)}
                  </div>
                </div>
              </button>

              {t.analysis && (
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="secondary">
                    {t.analysis.bpm.toFixed(1)} BPM
                  </Badge>
                  <Badge variant="secondary">{t.analysis.key_camelot}</Badge>
                  <Badge variant="secondary">
                    {t.analysis.lufs.toFixed(1)} LUFS
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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onAdd(t)}
                  >
                    <Plus className="h-3 w-3" /> Add to mix
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </ScrollArea>
  )
}
