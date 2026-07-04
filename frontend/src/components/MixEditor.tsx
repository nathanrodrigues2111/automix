import { useEffect, useMemo, useRef, useState } from "react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  ChevronDown,
  ChevronUp,
  GripVertical,
  Search,
  Layers,
  Loader2,
  Pause,
  Play,
  Square,
  Trash2,
  Wand2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import type { RenderClip, Track } from "@/api/types"
import type { LivePreview } from "@/hooks/useLivePreview"
import { autoOrderTracks } from "@/lib/camelot"
import { displayTitle, formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import { KeyChip } from "@/components/KeyChip"

export interface EditorClip extends RenderClip {
  uid: string
}

interface MixEditorProps {
  tracks: Track[]
  clips: EditorClip[]
  setClips: (clips: EditorClip[]) => void
  /** Live mix preview transport — owned by App so it can drive the main
   *  video player as the program monitor. */
  preview: LivePreview
  onRender: () => void
  onSaveProject: () => void
  onLoadProject: () => void
}

export function MixEditor({
  tracks,
  clips,
  setClips,
  preview,
  onRender,
  onSaveProject,
  onLoadProject,
}: MixEditorProps) {
  const [query, setQuery] = useState("")
  const [confirmClear, setConfirmClear] = useState(false)
  const trackById = useMemo(
    () => Object.fromEntries(tracks.map((t) => [t.id, t])),
    [tracks],
  )

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIdx = clips.findIndex((c) => c.uid === active.id)
    const newIdx = clips.findIndex((c) => c.uid === over.id)
    if (oldIdx < 0 || newIdx < 0) return
    setClips(arrayMove(clips, oldIdx, newIdx))
  }

  const autoOrder = () => {
    const expanded = clips
      .map((c) => ({ clip: c, track: trackById[c.track_id] }))
      .filter((x) => x.track)
    const ordered = autoOrderTracks(expanded.map((x) => x.track!))
    const reordered: EditorClip[] = ordered.map((t) => {
      const match = expanded.find((x) => x.track!.id === t.id)!
      return match.clip
    })
    setClips(reordered)
  }

  const removeClip = (uid: string) => {
    setClips(clips.filter((c) => c.uid !== uid))
  }

  const updateClip = (uid: string, patch: Partial<RenderClip>) => {
    setClips(clips.map((c) => (c.uid === uid ? { ...c, ...patch } : c)))
  }

  const moveClip = (uid: string, dir: -1 | 1) => {
    const idx = clips.findIndex((c) => c.uid === uid)
    if (idx < 0) return
    const next = idx + dir
    if (next < 0 || next >= clips.length) return
    setClips(arrayMove(clips, idx, next))
  }

  return (
    <Card className="flex h-full flex-col border-border/60 bg-card/40 backdrop-blur">
      <CardHeader className="space-y-3 pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex shrink-0 items-center gap-2.5 text-base font-semibold tracking-tight">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
              <Layers className="h-3.5 w-3.5 text-primary" />
            </span>
            Mix Editor
          </CardTitle>
          <div className="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onLoadProject}
              className="h-7 px-2 text-xs"
            >
              Load
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onSaveProject}
              className="h-7 px-2 text-xs"
            >
              Save
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={preview.toggle}
            disabled={clips.length === 0 || preview.state.status === "loading"}
            title="Instant in-browser preview with the real transition timing (clips play at native BPM)"
          >
            {preview.state.status === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : preview.state.status === "playing" ? (
              <Pause className="h-3.5 w-3.5 fill-current" />
            ) : (
              <Play className="h-3.5 w-3.5 fill-current" />
            )}
            Preview
          </Button>
          <Button
            size="sm"
            onClick={onRender}
            disabled={clips.length === 0}
            className="bg-primary text-primary-foreground shadow-[0_0_18px_-4px_color-mix(in_oklch,var(--primary)_60%,transparent)] hover:bg-primary/90 hover:shadow-[0_0_22px_-2px_color-mix(in_oklch,var(--primary)_70%,transparent)]"
          >
            Render
          </Button>
        </div>

        {preview.state.status !== "idle" && (
          <div className="flex items-center gap-2">
            <Progress
              value={
                preview.state.duration > 0
                  ? (preview.state.position / preview.state.duration) * 100
                  : 0
              }
              className="h-1 flex-1"
            />
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
              {formatDuration(preview.state.position)} /{" "}
              {formatDuration(preview.state.duration)}
            </span>
            <button
              type="button"
              onClick={preview.stop}
              aria-label="Stop preview"
              title="Stop preview"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          </div>
        )}
      </CardHeader>

      <CardContent className="min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden">
        <div className="flex flex-wrap items-center justify-between gap-y-1">
          <div className="shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase tracking-widest text-primary/80">
            Clips · {clips.length}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={autoOrder}
              disabled={clips.length < 2}
              className="h-7 px-2 text-xs"
              title="Reorder clips for harmonic flow (Camelot wheel)"
            >
              <Wand2 className="h-3 w-3" /> Auto-order
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={clips.length === 0}
              onClick={() => {
                if (!confirmClear) {
                  setConfirmClear(true)
                  window.setTimeout(() => setConfirmClear(false), 3000)
                  return
                }
                setConfirmClear(false)
                setClips([])
              }}
              className={cn(
                "h-7 px-2 text-xs",
                confirmClear
                  ? "bg-destructive/15 text-destructive hover:bg-destructive/25 hover:text-destructive"
                  : "text-muted-foreground",
              )}
            >
              <Trash2 className="h-3 w-3" />
              {confirmClear ? "Really clear?" : "Clear all"}
            </Button>
          </div>
        </div>

        {clips.length > 3 && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search clips"
              aria-label="Search clips"
              className="h-7 w-full rounded-md border border-border/60 bg-background/60 pl-7 pr-2 text-xs focus-visible:outline-2 focus-visible:outline-ring"
            />
          </div>
        )}

        {clips.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 bg-gradient-to-b from-card/40 to-card/10 p-8 text-center">
            <Layers className="h-6 w-6 text-muted-foreground/50" />
            <div className="text-sm font-medium text-muted-foreground">
              No clips yet
            </div>
            <div className="text-xs leading-relaxed text-muted-foreground/70">
              Add drops from the Tracks list to build your mix
            </div>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={clips.map((c) => c.uid)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="space-y-2">
                {clips
                  .map((clip, idx) => ({ clip, idx }))
                  .filter(({ clip }) => {
                    const q = query.trim().toLowerCase()
                    if (!q) return true
                    const t = trackById[clip.track_id]
                    return t
                      ? displayTitle(t).toLowerCase().includes(q) ||
                          t.filename.toLowerCase().includes(q)
                      : true
                  })
                  .map(({ clip, idx }) => {
                  const track = trackById[clip.track_id]
                  return (
                    <SortableClip
                      key={clip.uid}
                      clip={clip}
                      track={track}
                      index={idx}
                      isActive={
                        preview.state.status !== "idle" &&
                        preview.state.activeIndex === idx
                      }
                      onRemove={() => removeClip(clip.uid)}
                      onUpdate={(patch) => updateClip(clip.uid, patch)}
                      onMoveUp={() => moveClip(clip.uid, -1)}
                      onMoveDown={() => moveClip(clip.uid, 1)}
                    />
                  )
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </CardContent>
    </Card>
  )
}

interface SortableClipProps {
  clip: EditorClip
  track: Track | undefined
  index: number
  /** True while this clip is audible in the live preview. */
  isActive?: boolean
  onRemove: () => void
  onUpdate: (patch: Partial<RenderClip>) => void
  onMoveUp: () => void
  onMoveDown: () => void
}

function SortableClip({
  clip,
  track,
  index,
  isActive = false,
  onRemove,
  onUpdate,
  onMoveUp,
  onMoveDown,
}: SortableClipProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: clip.uid })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const beatSeconds = track?.analysis
    ? 60 / track.analysis.bpm
    : null
  // Prefer the explicit end_s (from a detected drop pick) — it's exact.
  // Fall back to bars × beat-seconds for manually-set clips.
  const clipDurationS =
    clip.end_s != null && clip.end_s > clip.start_s
      ? clip.end_s - clip.start_s
      : beatSeconds
        ? beatSeconds * 4 * clip.length_bars
        : null
  const dropLabel = (() => {
    const drops = track?.analysis?.drops ?? []
    const match = drops.findIndex(
      (d) => Math.abs(d.start_s - clip.start_s) < 0.5,
    )
    return match >= 0 ? `Drop ${match + 1}` : null
  })()

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex min-w-0 items-stretch gap-2 overflow-hidden rounded-lg border border-border/60 bg-card p-2.5 transition-colors hover:border-border",
        isActive && "border-primary/50 bg-primary/10 ring-1 ring-primary/30",
      )}
    >
      <button
        className="flex shrink-0 cursor-grab touch-none items-center rounded px-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center justify-between gap-1">
          <div
            className="min-w-0 flex-1 truncate text-sm font-medium leading-tight"
            title={track?.filename}
          >
            <span className="text-muted-foreground">{index + 1}.</span>{" "}
            {track ? displayTitle(track) : "(missing track)"}
          </div>
          <div className="flex shrink-0 gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="Move clip up"
              onClick={onMoveUp}
            >
              <ChevronUp className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="Move clip down"
              onClick={onMoveDown}
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label="Remove clip"
              onClick={onRemove}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
        {/* Chips span the full card width so they wrap horizontally instead of
            stacking in the narrow title column. */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {dropLabel && (
            <Badge
              variant="outline"
              className="border-amber-500/40 bg-amber-500/10 text-[11px] font-medium text-amber-700 dark:text-amber-300"
            >
              {dropLabel}
            </Badge>
          )}
          {track?.analysis && (
            <>
              <Badge
                variant="outline"
                className="border-border/60 font-mono text-[11px] tabular-nums"
              >
                {track.analysis.bpm.toFixed(0)} BPM
              </Badge>
              <KeyChip keyCamelot={track.analysis.key_camelot} />
            </>
          )}
          {clipDurationS !== null && (
            <span className="font-mono text-[11px] tabular-nums">
              {formatDuration(clip.start_s)}–
              {formatDuration(clip.end_s ?? clip.start_s + clipDurationS)}
            </span>
          )}
        </div>

        {(() => {
          const step = beatSeconds ?? 0.1
          const effectiveEnd =
            clip.end_s != null && clip.end_s > clip.start_s
              ? clip.end_s
              : clip.start_s + (clipDurationS ?? 10)
          const shiftStart = (delta: number) => {
            const newStart = Math.max(0, clip.start_s + delta)
            onUpdate({ start_s: newStart })
          }
          const shiftEnd = (delta: number) => {
            const newEnd = Math.max(clip.start_s + 0.5, effectiveEnd + delta)
            onUpdate({ end_s: newEnd })
          }
          const fmt = (s: number) => {
            const m = Math.floor(s / 60)
            const sec = (s - m * 60).toFixed(2).padStart(5, "0")
            return `${m}:${sec}`
          }
          return (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Start
                  </Label>
                  <span className="font-mono text-[11px] tabular-nums text-foreground/80">
                    {fmt(clip.start_s)}
                  </span>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 px-1.5 text-[11px]"
                    onClick={() => shiftStart(-step)}
                    title="Move start 1 beat earlier"
                  >
                    -1 beat
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 px-1.5 text-[11px]"
                    onClick={() => shiftStart(step)}
                    title="Move start 1 beat later"
                  >
                    +1 beat
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    End
                  </Label>
                  <span className="font-mono text-[11px] tabular-nums text-foreground/80">
                    {fmt(effectiveEnd)}
                  </span>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 px-1.5 text-[11px]"
                    onClick={() => shiftEnd(-step)}
                    title="Trim end 1 beat earlier"
                  >
                    -1 beat
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 px-1.5 text-[11px]"
                    onClick={() => shiftEnd(step)}
                    title="Extend end 1 beat later"
                  >
                    +1 beat
                  </Button>
                </div>
              </div>
            </div>
          )
        })()}
      </div>
    </li>
  )
}
