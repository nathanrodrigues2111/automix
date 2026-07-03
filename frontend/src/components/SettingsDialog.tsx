import { useState, type ReactNode } from "react"
import { Monitor, Moon, Settings2, Sun } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { setThemePref, useThemePref, type ThemePref } from "@/lib/theme"
import type { RenderConfig } from "@/api/types"

type BpmMode = "first" | "median" | "manual"

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  config: Omit<RenderConfig, "clips">
  setConfig: (config: Omit<RenderConfig, "clips">) => void
  loopPreviews: boolean
  onLoopPreviewsChange: (v: boolean) => void
  /** BPMs of the clips currently in the mix, in order — used by the
   *  "first"/"median" target-BPM modes. */
  clipBpms: number[]
}

export function SettingsDialog({
  open,
  onClose,
  config,
  setConfig,
  loopPreviews,
  onLoopPreviewsChange,
  clipBpms,
}: SettingsDialogProps) {
  const [bpmMode, setBpmMode] = useState<BpmMode>("first")
  const themePref = useThemePref()

  const recomputeTargetBpm = (mode: BpmMode) => {
    if (mode === "manual" || clipBpms.length === 0) return
    const target =
      mode === "first"
        ? clipBpms[0]
        : [...clipBpms].sort((a, b) => a - b)[Math.floor(clipBpms.length / 2)]
    setConfig({ ...config, target_bpm: target })
  }

  const nativeBpm = config.no_time_stretch ?? true

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full max-w-full gap-0 sm:w-[420px] sm:max-w-[420px]"
      >
        <div className="space-y-2 border-b border-border/60 px-6 py-5 pr-14">
          <SheetTitle className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 ring-1 ring-primary/30">
              <Settings2 className="h-4 w-4 text-primary" />
            </span>
            Settings
          </SheetTitle>
          <SheetDescription className="text-[13px] leading-relaxed text-muted-foreground">
            Saved automatically — applies to the next preview or render.
          </SheetDescription>
        </div>

        <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 py-6">
          <section className="space-y-4">
            <SectionLabel>Appearance</SectionLabel>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
              {(
                [
                  { value: "system", label: "System", icon: Monitor },
                  { value: "light", label: "Light", icon: Sun },
                  { value: "dark", label: "Dark", icon: Moon },
                ] as const
              ).map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={themePref === value}
                  onClick={() => setThemePref(value as ThemePref)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-xs font-medium transition-colors",
                    themePref === value
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
          </section>

          <Separator className="bg-border/50" />

          <section className="space-y-5">
            <SectionLabel>Mix</SectionLabel>

            <SwitchRow
              title="Keep native BPM"
              description="Drops-only style: no time-stretching, each clip plays at its own tempo"
              checked={nativeBpm}
              onChange={(v) => setConfig({ ...config, no_time_stretch: v })}
            />

            <div className={cn("space-y-2", nativeBpm && "opacity-50")}>
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Target BPM{nativeBpm ? " · off while native BPM is on" : ""}
              </Label>
              <div className="flex items-center gap-2">
                <Select
                  value={bpmMode}
                  onValueChange={(v) => {
                    const mode = v as BpmMode
                    setBpmMode(mode)
                    recomputeTargetBpm(mode)
                  }}
                  disabled={nativeBpm}
                >
                  <SelectTrigger className="h-9 flex-1">
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
                  disabled={nativeBpm || bpmMode !== "manual"}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (!Number.isFinite(v)) return
                    setConfig({ ...config, target_bpm: v })
                  }}
                  className="h-9 w-24"
                  aria-label="Target BPM"
                />
              </div>
            </div>

            <SliderRow
              label="Crossfade"
              valueText={`${config.crossfade_bars.toFixed(2)} bars`}
              value={config.crossfade_bars}
              min={0}
              max={4}
              step={0.25}
              disabled={config.hard_cut ?? false}
              onChange={(v) => setConfig({ ...config, crossfade_bars: v })}
            />

            <SliderRow
              label="Loudness"
              valueText={`${config.loudness_lufs.toFixed(1)} LUFS`}
              value={config.loudness_lufs}
              min={-23}
              max={-9}
              step={0.5}
              onChange={(v) => setConfig({ ...config, loudness_lufs: v })}
            />

            <SliderRow
              label="Max pitch shift"
              valueText={
                (config.harmonic_pitch_shift_max_semitones ?? 0) === 0
                  ? "off"
                  : `±${config.harmonic_pitch_shift_max_semitones} st`
              }
              value={config.harmonic_pitch_shift_max_semitones ?? 0}
              min={0}
              max={6}
              step={1}
              onChange={(v) =>
                setConfig({
                  ...config,
                  harmonic_pitch_shift_max_semitones: v,
                })
              }
            />

            <div className="space-y-3">
              <SwitchRow
                title="Snap to downbeat"
                description="Align manual clip edges to the beat grid"
                checked={config.snap_to_downbeat ?? true}
                onChange={(v) => setConfig({ ...config, snap_to_downbeat: v })}
              />
              <SwitchRow
                title="Hard cuts"
                description="Cut on the downbeat with no crossfade"
                checked={config.hard_cut ?? false}
                onChange={(v) => setConfig({ ...config, hard_cut: v })}
              />
              <SwitchRow
                title="Stem-aware crossfade"
                description="Fade drums/bass separately from vocals (needs the ML stack)"
                checked={config.use_stem_crossfade}
                onChange={(v) =>
                  setConfig({ ...config, use_stem_crossfade: v })
                }
              />
            </div>
          </section>

          <Separator className="bg-border/50" />

          <section className="space-y-3">
            <SectionLabel>Output</SectionLabel>
            <SwitchRow
              title="EDMPAPA branding"
              description="Letterbox bars + logo overlay on the final video"
              checked={config.brand_overlay ?? true}
              onChange={(v) => setConfig({ ...config, brand_overlay: v })}
            />
            <SwitchRow
              title="Track titles"
              description="Show each track's title during its section"
              checked={config.show_titles ?? true}
              onChange={(v) => setConfig({ ...config, show_titles: v })}
            />
          </section>

          <Separator className="bg-border/50" />

          <section className="space-y-3 pb-2">
            <SectionLabel>Playback</SectionLabel>
            <SwitchRow
              title="Loop drop previews"
              description="Repeat a previewed drop until you pause"
              checked={loopPreviews}
              onChange={onLoopPreviewsChange}
            />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-widest text-primary/80">
      {children}
    </div>
  )
}

function SliderRow({
  label,
  valueText,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string
  valueText: string
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  onChange: (v: number) => void
}) {
  return (
    <div className={cn("space-y-2.5", disabled && "opacity-50")}>
      <div className="flex items-baseline justify-between">
        <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </Label>
        <span className="font-mono text-xs tabular-nums text-foreground/80">
          {valueText}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={([v]) => onChange(v)}
        aria-label={label}
      />
    </div>
  )
}

function SwitchRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/20">
      <span className="min-w-0 space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
