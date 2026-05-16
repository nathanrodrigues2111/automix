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
import { formatDuration } from "@/lib/format"

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
    <Card className="flex h-full flex-col">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="h-4 w-4" /> Mix Editor
        </CardTitle>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onLoadProject}>
            Load
          </Button>
          <Button variant="outline" size="sm" onClick={onSaveProject}>
            Save
          </Button>
          <Button size="sm" onClick={onRender} disabled={clips.length === 0}>
            Render
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-4 overflow-y-auto">
        <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase text-muted-foreground">
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
            <Label className="text-xs uppercase text-muted-foreground">
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
            <Label className="text-xs uppercase text-muted-foreground">
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
          <div className="text-xs uppercase text-muted-foreground">
            Clips ({clips.length})
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
  const clipDurationS = beatSeconds ? beatSeconds * 4 * clip.length_bars : null

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-stretch gap-2 rounded-md border border-border bg-card p-2"
    >
      <button
        className="flex cursor-grab touch-none items-center px-1 text-muted-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <div className="flex-1 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {index + 1}. {track?.filename ?? "(missing track)"}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {track?.analysis && (
                <>
                  <Badge variant="outline" className="text-[10px]">
                    {track.analysis.bpm.toFixed(1)} BPM
                  </Badge>
                  <Badge variant="outline" className="text-[10px]">
                    {track.analysis.key_camelot}
                  </Badge>
                </>
              )}
              {clipDurationS !== null && (
                <span>{formatDuration(clipDurationS)}</span>
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

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">
              Length: {clip.length_bars} bars
            </Label>
            <Slider
              value={[clip.length_bars]}
              min={4}
              max={32}
              step={1}
              onValueChange={([v]) => onUpdate({ length_bars: v })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] uppercase text-muted-foreground">
              Trim start: {clip.start_s.toFixed(2)}s
            </Label>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  onUpdate({
                    start_s: Math.max(
                      0,
                      clip.start_s - (beatSeconds ?? 0.1),
                    ),
                  })
                }
              >
                -1 beat
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  onUpdate({
                    start_s: clip.start_s + (beatSeconds ?? 0.1),
                  })
                }
              >
                +1 beat
              </Button>
            </div>
          </div>
        </div>
      </div>
    </li>
  )
}
