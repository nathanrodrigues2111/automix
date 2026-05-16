import { useMemo, useState } from "react"
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
  Eye,
  GripVertical,
  Layers,
  Trash2,
  Wand2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import type { RenderClip, RenderConfig, Track } from "@/api/types"
import { autoOrderTracks } from "@/lib/camelot"
import { formatDuration, formatTrackTitle } from "@/lib/format"
import { KeyChip } from "@/components/KeyChip"

export interface EditorClip extends RenderClip {
  uid: string
}

type BpmMode = "first" | "median" | "manual"

interface MixEditorProps {
  tracks: Track[]
  clips: EditorClip[]
  setClips: (clips: EditorClip[]) => void
  config: Omit<RenderConfig, "clips">
  setConfig: (config: Omit<RenderConfig, "clips">) => void
  onPreview: () => void
  onRender: () => void
  onSaveProject: () => void
  onLoadProject: () => void
}

export function MixEditor({
  tracks,
  clips,
  setClips,
  config,
  setConfig,
  onPreview,
  onRender,
  onSaveProject,
  onLoadProject,
}: MixEditorProps) {
  const trackById = useMemo(
    () => Object.fromEntries(tracks.map((t) => [t.id, t])),
    [tracks],
  )

  const [bpmMode, setBpmMode] = useState<BpmMode>("first")

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

  const recomputeTargetBpm = (mode: BpmMode, manualValue?: number) => {
    if (clips.length === 0) return
    const bpms = clips
      .map((c) => trackById[c.track_id]?.analysis?.bpm)
      .filter((v): v is number => typeof v === "number")
    if (bpms.length === 0) return
    let target = config.target_bpm
    if (mode === "first") target = bpms[0]
    else if (mode === "median") {
      const sorted = [...bpms].sort((a, b) => a - b)
      target = sorted[Math.floor(sorted.length / 2)]
    } else if (mode === "manual" && manualValue !== undefined) {
      target = manualValue
    }
    setConfig({ ...config, target_bpm: target })
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
          <CardTitle className="flex shrink-0 items-center gap-2 text-base">
            <Layers className="h-4 w-4" /> Mix Editor
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
            onClick={onPreview}
            disabled={clips.length === 0}
            title="Low-quality 720p proxy render (~30s)"
          >
            <Eye className="h-3.5 w-3.5" /> Preview
          </Button>
          <Button
            size="sm"
            onClick={onRender}
            disabled={clips.length === 0}
            className="bg-gradient-to-r from-primary to-fuchsia-500 text-primary-foreground shadow-[0_0_18px_-4px_color-mix(in_oklch,var(--primary)_60%,transparent)] hover:from-primary hover:to-fuchsia-400 hover:shadow-[0_0_22px_-2px_color-mix(in_oklch,var(--primary)_70%,transparent)]"
          >
            Render
          </Button>
        </div>
      </CardHeader>

      <CardContent className="min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden">
        <section className="grid grid-cols-1 gap-3">
          <div className="space-y-1.5">
            <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Target BPM
            </Label>
            <div className="flex items-center gap-2">
              <Select
                value={bpmMode}
                onValueChange={(v) => {
                  const mode = v as BpmMode
                  setBpmMode(mode)
                  recomputeTargetBpm(mode)
                }}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="first">First clip</SelectItem>
                  <SelectItem value="median">Median</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="number"
                min={60}
                max={200}
                step={0.5}
                value={config.target_bpm}
                disabled={bpmMode !== "manual"}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  if (!Number.isFinite(v)) return
                  setConfig({ ...config, target_bpm: v })
                }}
                className="w-24"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Crossfade: {config.crossfade_bars.toFixed(2)} bars
            </Label>
            <Slider
              value={[config.crossfade_bars]}
              min={0}
              max={4}
              step={0.25}
              onValueChange={([v]) =>
                setConfig({ ...config, crossfade_bars: v })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Loudness: {config.loudness_lufs.toFixed(1)} LUFS
            </Label>
            <Slider
              value={[config.loudness_lufs]}
              min={-23}
              max={-9}
              step={0.5}
              onValueChange={([v]) =>
                setConfig({ ...config, loudness_lufs: v })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2">
            <div>
              <div className="text-sm font-medium">Stem-aware crossfade</div>
              <div className="text-xs text-muted-foreground">
                Stem-isolated drums/bass fade
              </div>
            </div>
            <Switch
              checked={config.use_stem_crossfade}
              onCheckedChange={(v) =>
                setConfig({ ...config, use_stem_crossfade: v })
              }
            />
          </div>
        </section>

        <Separator />

        <div className="flex items-center justify-between">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Clips · {clips.length}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={autoOrder}
            disabled={clips.length < 2}
          >
            <Wand2 className="h-3 w-3" /> Auto-order (Camelot)
          </Button>
        </div>

        {clips.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            Add analyzed tracks from the list on the left
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
                {clips.map((clip, idx) => {
                  const track = trackById[clip.track_id]
                  return (
                    <SortableClip
                      key={clip.uid}
                      clip={clip}
                      track={track}
                      index={idx}
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
  onRemove: () => void
  onUpdate: (patch: Partial<RenderClip>) => void
  onMoveUp: () => void
  onMoveDown: () => void
}

function SortableClip({
  clip,
  track,
  index,
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
      className="flex min-w-0 items-stretch gap-2 overflow-hidden rounded-md border border-border bg-card p-2"
    >
      <button
        className="flex shrink-0 cursor-grab touch-none items-center px-1 text-muted-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div
              className="truncate text-sm font-medium leading-tight"
              title={track?.filename}
            >
              <span className="text-muted-foreground">{index + 1}.</span>{" "}
              {track ? formatTrackTitle(track.filename) : "(missing track)"}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {dropLabel && (
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 text-[10px] font-medium text-amber-300"
                >
                  {dropLabel}
                </Badge>
              )}
              {track?.analysis && (
                <>
                  <Badge variant="outline" className="font-mono text-[10px] tabular-nums">
                    {track.analysis.bpm.toFixed(0)} BPM
                  </Badge>
                  <KeyChip keyCamelot={track.analysis.key_camelot} />
                </>
              )}
              {clipDurationS !== null && (
                <span className="font-mono tabular-nums">
                  {formatDuration(clip.start_s)}–
                  {formatDuration(
                    clip.end_s ?? clip.start_s + clipDurationS,
                  )}
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" onClick={onMoveUp}>
              <ChevronUp className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" onClick={onMoveDown}>
              <ChevronDown className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" onClick={onRemove}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
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
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Start · {fmt(clip.start_s)}
                </Label>
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 px-1.5 text-[10px]"
                    onClick={() => shiftStart(-step)}
                    title="Move start 1 beat earlier"
                  >
                    -1 beat
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 px-1.5 text-[10px]"
                    onClick={() => shiftStart(step)}
                    title="Move start 1 beat later"
                  >
                    +1 beat
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  End · {fmt(effectiveEnd)}
                </Label>
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 px-1.5 text-[10px]"
                    onClick={() => shiftEnd(-step)}
                    title="Trim end 1 beat earlier"
                  >
                    -1 beat
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 px-1.5 text-[10px]"
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
