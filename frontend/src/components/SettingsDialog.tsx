import { useEffect, useRef, useState, type ReactNode } from "react"
import { Monitor, Moon, Settings2, Sun, Upload } from "lucide-react"
import { toast } from "sonner"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { ACCENTS, isPresetAccent, loadAccent, setAccent } from "@/lib/accent"
import {
  DOWNLOAD_QUALITIES,
  loadDownloadMaxHeight,
  setDownloadMaxHeight,
} from "@/lib/downloadQuality"
import { defaultApiBase, loadApiBase, setApiBase } from "@/lib/backend"
import { ensureFontLoaded } from "@/lib/fonts"
import { useFonts, useUploadFont } from "@/api/client"
import { APP_VERSION, CHANGELOG } from "@/changelog"
import type { RenderConfig } from "@/api/types"

type BpmMode = "first" | "median" | "manual"

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  config: Omit<RenderConfig, "clips">
  setConfig: (config: Omit<RenderConfig, "clips">) => void
  loopPreviews: boolean
  onLoopPreviewsChange: (v: boolean) => void
  automixEnabled: boolean
  onAutomixEnabledChange: (v: boolean) => void
  /** BPMs of the clips currently in the mix, in order — used by the
   *  "first"/"median" target-BPM modes. */
  clipBpms: number[]
  onReset?: () => void
  onStartTour?: () => void
}

export function SettingsDialog({
  open,
  onClose,
  config,
  setConfig,
  loopPreviews,
  onLoopPreviewsChange,
  automixEnabled,
  onAutomixEnabledChange,
  clipBpms,
  onReset,
  onStartTour,
}: SettingsDialogProps) {
  const [bpmMode, setBpmMode] = useState<BpmMode>("first")
  const themePref = useThemePref()
  const [confirmReset, setConfirmReset] = useState(false)
  const resetTimer = useRef<number | null>(null)

  const handleReset = () => {
    if (!confirmReset) {
      setConfirmReset(true)
      if (resetTimer.current) window.clearTimeout(resetTimer.current)
      resetTimer.current = window.setTimeout(() => setConfirmReset(false), 3000)
      return
    }
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    setConfirmReset(false)
    onReset?.()
    toast.success("Settings reset to defaults")
  }

  const openDevTools = () => {
    // pywebview may expose an API to open the inspector; otherwise F12 works in
    // the packaged app (debug build) and natively in the browser.
    const pw = (window as unknown as { pywebview?: { api?: Record<string, unknown> } }).pywebview
    const fn = pw?.api?.open_devtools
    if (typeof fn === "function") {
      try {
        ;(fn as () => void)()
        return
      } catch {
        // fall through to the hint
      }
    }
    toast.info("Press F12 to open the developer console")
  }

  const recomputeTargetBpm = (mode: BpmMode) => {
    if (mode === "manual" || clipBpms.length === 0) return
    const target =
      mode === "first"
        ? clipBpms[0]
        : [...clipBpms].sort((a, b) => a - b)[Math.floor(clipBpms.length / 2)]
    setConfig({ ...config, target_bpm: target })
  }

  const nativeBpm = config.no_time_stretch ?? true
  const [accent, setAccentState] = useState<string | null>(() => loadAccent())
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [apiBase, setApiBaseState] = useState<string>(() => loadApiBase())
  const [downloadHeight, setDownloadHeight] = useState<number | null>(() =>
    loadDownloadMaxHeight(),
  )
  const [legalOpen, setLegalOpen] = useState(false)

  // Title fonts: load every available font into the document so the
  // dropdown can preview each one in its own face.
  const fonts = useFonts()
  const uploadFont = useUploadFont()
  const fontInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    for (const f of fonts.data?.fonts ?? []) {
      void ensureFontLoaded(f).catch(() => {})
    }
  }, [fonts.data])

  const onFontFile = (file: File | null) => {
    if (!file) return
    uploadFont.mutate(file, {
      onSuccess: (font) => {
        setConfig({ ...config, title_font: font.id })
        toast.success(`Font added: ${font.family}`)
      },
      onError: (e) => toast.error(`Font upload failed: ${e.message}`),
    })
  }

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
            Saved automatically. Applies to the next preview or render.
          </SheetDescription>
        </div>

        <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 py-6">
          <section className="space-y-5">
            <SectionLabel>Appearance</SectionLabel>
            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Theme
              </Label>
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
            </div>

            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Accent color
              </Label>
              <div
                className="flex flex-wrap items-center gap-3 pt-1"
                role="radiogroup"
                aria-label="Accent color"
              >
                {ACCENTS.map((a) => {
                  const selected =
                    accent === a.value || (!accent && a.name === "Blue")
                  return (
                    <button
                      key={a.name}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      title={a.name}
                      onClick={() => {
                        const v = a.name === "Blue" ? null : a.value
                        setAccent(v)
                        setAccentState(v)
                      }}
                      className={cn(
                        "h-8 w-8 rounded-full ring-offset-2 ring-offset-background transition-shadow",
                        selected
                          ? "ring-2 ring-foreground/70"
                          : "ring-1 ring-border hover:ring-foreground/40",
                      )}
                      style={{ backgroundColor: a.value }}
                    />
                  )
                })}
                {/* Custom color: native picker behind a rainbow swatch. */}
                <label
                  title="Custom color"
                  className={cn(
                    "relative h-8 w-8 cursor-pointer rounded-full ring-offset-2 ring-offset-background transition-shadow",
                    !isPresetAccent(accent)
                      ? "ring-2 ring-foreground/70"
                      : "ring-1 ring-border hover:ring-foreground/40",
                  )}
                  style={{
                    background: !isPresetAccent(accent)
                      ? (accent ?? undefined)
                      : "conic-gradient(from 0deg, #f43f5e, #f59e0b, #84cc16, #06b6d4, #6366f1, #d946ef, #f43f5e)",
                  }}
                >
                  <input
                    type="color"
                    aria-label="Custom accent color"
                    value={
                      !isPresetAccent(accent) && accent?.startsWith("#")
                        ? accent
                        : "#8b5cf6"
                    }
                    onChange={(e) => {
                      setAccent(e.target.value)
                      setAccentState(e.target.value)
                    }}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                </label>
              </div>
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

            <div className={cn("space-y-3", nativeBpm && "opacity-50")}>
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
                  <SelectTrigger className="flex-1">
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
                  className="w-24"
                  aria-label="Target BPM"
                />
              </div>
            </div>

            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Full video drop length
              </Label>
              <Select
                value={String(config.drop_bars ?? 0)}
                onValueChange={(v) =>
                  setConfig({ ...config, drop_bars: parseInt(v, 10) })
                }
              >
                <SelectTrigger className="bg-background/60 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Auto (detected drop body)</SelectItem>
                  <SelectItem value="4">4 bars</SelectItem>
                  <SelectItem value="8">8 bars</SelectItem>
                  <SelectItem value="12">12 bars</SelectItem>
                  <SelectItem value="16">16 bars</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                How long each drop plays from its kick. Applies to drops you
                add next and to Auto-Mix.
              </p>
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
                title="Video cut blend"
                description="Soften each video cut with a quick 0.25s transition"
                checked={config.video_cut_fade ?? true}
                onChange={(v) => setConfig({ ...config, video_cut_fade: v })}
              />
              {(config.video_cut_fade ?? true) && (
                <div className="space-y-3 pl-1">
                  <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Transition style
                  </Label>
                  <Select
                    value={config.video_transition ?? "fade"}
                    onValueChange={(v) =>
                      setConfig({ ...config, video_transition: v })
                    }
                  >
                    <SelectTrigger className="bg-background/60 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fade">Blend</SelectItem>
                      <SelectItem value="variety">Variety (cycles styles)</SelectItem>
                      <SelectItem value="fadeblack">Dip to black</SelectItem>
                      <SelectItem value="fadewhite">Flash to white</SelectItem>
                      <SelectItem value="circleopen">Circle open</SelectItem>
                      <SelectItem value="pixelize">Pixelize</SelectItem>
                      <SelectItem value="radial">Radial sweep</SelectItem>
                      <SelectItem value="wipeleft">Wipe left</SelectItem>
                      <SelectItem value="slideup">Slide up</SelectItem>
                      <SelectItem value="hblur">Blur through</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
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
            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Resolution
              </Label>
              <Select
                value={config.resolution ?? "1080p"}
                onValueChange={(v) => setConfig({ ...config, resolution: v })}
              >
                <SelectTrigger className="bg-background/60 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="480p">480p</SelectItem>
                  <SelectItem value="720p">720p (HD)</SelectItem>
                  <SelectItem value="1080p">1080p (Full HD)</SelectItem>
                  <SelectItem value="1440p">1440p (2K)</SelectItem>
                  <SelectItem value="2160p">2160p (4K)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                File name
              </Label>
              <Select
                value={
                  (config.filename_style ?? "file") === "timestamp"
                    ? "timestamp"
                    : "file"
                }
                onValueChange={(v) =>
                  setConfig({ ...config, filename_style: v })
                }
              >
                <SelectTrigger className="bg-background/60 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="file">
                    Video name + date (automix_Video_Name_20260705_1731.mp4)
                  </SelectItem>
                  <SelectItem value="timestamp">
                    Date and time only (automix_20260705T104356Z.mp4)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Title font
              </Label>
              <div className="flex items-center gap-2">
                <Select
                  value={config.title_font ?? fonts.data?.default ?? "BebasNeue-Regular"}
                  onValueChange={(v) => setConfig({ ...config, title_font: v })}
                >
                  <SelectTrigger className="flex-1 bg-background/60 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(fonts.data?.fonts ?? []).map((f) => (
                      <SelectItem
                        key={f.id}
                        value={f.id}
                        style={{ fontFamily: `'${f.family}', sans-serif` }}
                      >
                        {f.family}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0 gap-1.5 text-xs"
                  disabled={uploadFont.isPending}
                  onClick={() => fontInputRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" />
                  {uploadFont.isPending ? "Uploading" : "Upload"}
                </Button>
                <input
                  ref={fontInputRef}
                  type="file"
                  accept=".ttf,.otf"
                  className="hidden"
                  onChange={(e) => {
                    onFontFile(e.target.files?.[0] ?? null)
                    e.target.value = ""
                  }}
                />
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Used for the track titles burned into the video and the Short.
                Upload any TTF or OTF file to add it to the list.
              </p>
            </div>

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

            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Video encoder
              </Label>
              <Select
                value={config.hw_accel ?? "auto"}
                onValueChange={(v) => setConfig({ ...config, hw_accel: v })}
              >
                <SelectTrigger className="bg-background/60 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto (GPU if available)</SelectItem>
                  <SelectItem value="cpu">CPU (libx264)</SelectItem>
                  <SelectItem value="nvenc">NVIDIA GPU (NVENC)</SelectItem>
                  <SelectItem value="qsv">Intel GPU (QSV)</SelectItem>
                  <SelectItem value="amf">AMD GPU (AMF)</SelectItem>
                  <SelectItem value="videotoolbox">Apple (VideoToolbox)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Auto uses your GPU when a working hardware encoder is found and
                falls back to CPU otherwise. A specific choice that is not
                available on this machine also falls back to CPU.
              </p>
            </div>
          </section>

          <Separator className="bg-border/50" />

          <section className="space-y-3">
            <SectionLabel>Shorts</SectionLabel>
            <SwitchRow
              title="Make a Short"
              description="Also render a vertical YouTube Short alongside the full video"
              checked={config.make_short ?? true}
              onChange={(v) => setConfig({ ...config, make_short: v })}
            />
            <SwitchRow
              title="Only render the Short"
              description="Skip the full video and produce just the vertical Short (much faster)"
              checked={config.short_only ?? false}
              onChange={(v) => setConfig({ ...config, short_only: v })}
            />
            <SwitchRow
              title="Short end card"
              description="Show a 'watch the full video' card at the end of the Short"
              checked={config.short_end_card ?? false}
              onChange={(v) => setConfig({ ...config, short_end_card: v })}
            />
            <SwitchRow
              title="Show artist name"
              description="Show the artist above the track name on the Short. Off shows just the track (full titles run long)"
              checked={config.short_show_artist ?? false}
              onChange={(v) => setConfig({ ...config, short_show_artist: v })}
            />
            <SwitchRow
              title="EDMPAPA overlay"
              description="Show the EDMPAPA template on the Short. Off makes a clean full-width Short with just the titles"
              checked={config.short_overlay ?? true}
              onChange={(v) => setConfig({ ...config, short_overlay: v })}
            />

            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Short title
              </Label>
              <Input
                value={config.short_title ?? ""}
                onChange={(e) =>
                  setConfig({ ...config, short_title: e.target.value })
                }
                placeholder="e.g. When the entire arena sings your tune"
                aria-label="Short title caption"
                className="bg-background/60 text-sm"
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                A caption burned near the top of the Short in a bold boxed
                style. Leave empty for none.
              </p>
            </div>

            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Short length
              </Label>
              <Select
                value={String(config.short_max_s ?? 0)}
                onValueChange={(v) =>
                  setConfig({ ...config, short_max_s: parseInt(v, 10) })
                }
              >
                <SelectTrigger className="bg-background/60 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">5 seconds</SelectItem>
                  <SelectItem value="8">8 seconds</SelectItem>
                  <SelectItem value="10">10 seconds</SelectItem>
                  <SelectItem value="15">15 seconds</SelectItem>
                  <SelectItem value="0">Full (up to 1 minute)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                How much of the mix the Short teases before the end card.
              </p>
            </div>

            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Short drop length
              </Label>
              <Select
                value={String(config.short_drop_bars ?? 0)}
                onValueChange={(v) =>
                  setConfig({ ...config, short_drop_bars: parseInt(v, 10) })
                }
              >
                <SelectTrigger className="bg-background/60 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">Same as full video</SelectItem>
                  <SelectItem value="2">2 bars</SelectItem>
                  <SelectItem value="4">4 bars</SelectItem>
                  <SelectItem value="8">8 bars</SelectItem>
                  <SelectItem value="12">12 bars</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                When it differs from the full video, a separate shorter Short is
                rendered (adds render time). Same keeps one render for both.
              </p>
            </div>

            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Short font
              </Label>
              <Select
                value={config.short_font ?? "same"}
                onValueChange={(v) =>
                  setConfig({ ...config, short_font: v === "same" ? null : v })
                }
              >
                <SelectTrigger className="bg-background/60 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="same">Same as video title font</SelectItem>
                  {(fonts.data?.fonts ?? []).map((f) => (
                    <SelectItem
                      key={f.id}
                      value={f.id}
                      style={{ fontFamily: `'${f.family}', sans-serif` }}
                    >
                      {f.family}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Font for the Short's title and captions. Defaults to Cubano so
                Shorts can look different from the full video.
              </p>
            </div>
          </section>

          <Separator className="bg-border/50" />

          <section className="space-y-3">
            <SectionLabel>Downloads</SectionLabel>
            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                YouTube import quality
              </Label>
              <Select
                value={downloadHeight === null ? "best" : String(downloadHeight)}
                onValueChange={(v) => {
                  const h = v === "best" ? null : parseInt(v, 10)
                  setDownloadHeight(h)
                  setDownloadMaxHeight(h)
                }}
              >
                <SelectTrigger className="bg-background/60 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOWNLOAD_QUALITIES.map((q) => (
                    <SelectItem
                      key={q.label}
                      value={q.height === null ? "best" : String(q.height)}
                    >
                      {q.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Highest video and audio streams are downloaded separately and
                merged. Applies to the next import.
              </p>
            </div>
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
          <Separator className="bg-border/50" />

          <section className="space-y-3 pb-2">
            <SectionLabel>Interface</SectionLabel>
            <SwitchRow
              title="Enable Auto-Mix button"
              description="Show the Auto-Mix button on the playlist bar. Off keeps it hidden so a playlist only feeds Import and Choose"
              checked={automixEnabled}
              onChange={onAutomixEnabledChange}
              badge="Beta"
            />
          </section>
          <Separator className="bg-border/50" />

          <section className="space-y-3">
            <SectionLabel>Connection</SectionLabel>
            <div className="space-y-3">
              <Label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Backend URL
              </Label>
              <Input
                value={apiBase}
                onChange={(e) => setApiBaseState(e.target.value)}
                onBlur={() => {
                  const v = apiBase.trim().replace(/\/+$/, "")
                  if (v === loadApiBase()) return
                  setApiBase(v || null)
                  window.location.reload()
                }}
                placeholder={defaultApiBase() || "same origin"}
                spellCheck={false}
                className="bg-background/60 font-mono text-xs"
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground/80">
                Where the Automix backend runs. Leave as http://localhost:8000
                when using the hosted UI with the backend on this computer.
                Changing it reloads the app.
              </p>
            </div>
          </section>

          <Separator className="bg-border/50" />

          <section className="space-y-3">
            <SectionLabel>Help</SectionLabel>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-muted-foreground">
                New here? Take the guided tour of the app.
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 text-xs"
                onClick={() => onStartTour?.()}
              >
                Start tour
              </Button>
            </div>
          </section>

          <Separator className="bg-border/50" />

          <section className="space-y-3">
            <SectionLabel>What&apos;s new</SectionLabel>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {CHANGELOG[0]?.title}
                </div>
                <div className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
                  v{APP_VERSION} · {CHANGELOG[0]?.date}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 text-xs"
                onClick={() => setChangelogOpen(true)}
              >
                View changelog
              </Button>
            </div>
          </section>

          <Separator className="bg-border/50" />

          <section className="space-y-3">
            <SectionLabel>Debug</SectionLabel>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">Developer console</div>
                <div className="text-[11px] leading-relaxed text-muted-foreground">
                  Open the console to see logs and errors. F12 works too.
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 text-xs"
                onClick={openDevTools}
              >
                Open console
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">Reset settings</div>
                <div className="text-[11px] leading-relaxed text-muted-foreground">
                  Restore every setting on this page to its default.
                </div>
              </div>
              <Button
                variant={confirmReset ? "destructive" : "outline"}
                size="sm"
                className="h-7 shrink-0 text-xs"
                onClick={handleReset}
              >
                {confirmReset ? "Click to confirm" : "Reset to defaults"}
              </Button>
            </div>
          </section>

          <Separator className="bg-border/50" />

          <section className="space-y-3">
            <SectionLabel>Credits</SectionLabel>
            <div className="space-y-1.5 text-[12px] leading-relaxed text-muted-foreground">
              <div>
                <span className="font-medium text-foreground">Automix</span>{" "}
                v{APP_VERSION}, built for{" "}
                <span className="font-medium text-foreground">EDMPAPA</span> by
                Nathan Rodrigues.
              </div>
              <div className="text-muted-foreground/80">
                Powered by yt-dlp, FFmpeg, librosa, FastAPI, React, WaveSurfer
                &amp; Vidstack.
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-muted-foreground">
                A local-only tool. See the privacy notes &amp; disclaimer.
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 text-xs"
                onClick={() => setLegalOpen(true)}
              >
                Privacy &amp; disclaimer
              </Button>
            </div>
          </section>

          <Dialog open={legalOpen} onOpenChange={setLegalOpen}>
            <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Privacy &amp; disclaimer</DialogTitle>
              </DialogHeader>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Privacy
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    Everything runs on this machine. Downloads, analysis, and
                    renders never leave your computer, and there are no
                    analytics. Network requests only go out to YouTube
                    (downloads) and Deezer/iTunes (title lookups) when you use
                    those features.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-amber-600 dark:text-amber-400">
                    Warning
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    Downloading YouTube content may breach YouTube&apos;s Terms
                    of Service, and the music is copyrighted. Keep mixes for
                    personal use unless you have the rights to the tracks.
                    You are responsible for anything you publish. Not
                    affiliated with YouTube or any label.
                  </p>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          <Dialog open={changelogOpen} onOpenChange={setChangelogOpen}>
            <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Changelog</DialogTitle>
              </DialogHeader>
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
                {CHANGELOG.map((entry, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">
                        <span className="mr-2 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-primary">
                          v{entry.version}
                        </span>
                        {entry.title}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
                        {entry.date}
                      </span>
                    </div>
                    <ul className="space-y-1 text-[12px] leading-relaxed text-muted-foreground">
                      {entry.items.map((it, j) => (
                        <li key={j} className="flex gap-1.5">
                          <span className="text-primary/70">•</span>
                          <span>{it}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </DialogContent>
          </Dialog>

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
  badge,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
  /** Optional small pill after the title, e.g. "Beta". */
  badge?: string
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent/20">
      <span className="min-w-0 space-y-0.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {title}
          {badge && (
            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-primary">
              {badge}
            </span>
          )}
        </span>
        <span className="block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}
