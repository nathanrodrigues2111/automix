import { useEffect, useState } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface TourStep {
  /** data-tour attribute of the element to spotlight; omit for a centered card. */
  target?: string
  title: string
  text: string
}

interface TourProps {
  steps: TourStep[]
  step: number
  onStep: (next: number) => void
  onClose: () => void
}

/** Guided overlay: dims the app, spotlights the current step's element, and
 *  anchors an explainer card next to it. */
export function Tour({ steps, step, onStep, onClose }: TourProps) {
  const s = steps[step]
  const [rect, setRect] = useState<DOMRect | null>(null)

  useEffect(() => {
    if (!s?.target) {
      setRect(null)
      return
    }
    const el = document.querySelector(`[data-tour='${s.target}']`)
    if (!el) {
      setRect(null)
      return
    }
    el.scrollIntoView({ block: "nearest", behavior: "smooth" })
    const update = () => setRect(el.getBoundingClientRect())
    update()
    const settle = setTimeout(update, 400) // after the smooth scroll settles
    window.addEventListener("resize", update)
    return () => {
      clearTimeout(settle)
      window.removeEventListener("resize", update)
    }
  }, [s])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
      else if (e.key === "ArrowRight" && step < steps.length - 1) onStep(step + 1)
      else if (e.key === "ArrowLeft" && step > 0) onStep(step - 1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [step, steps.length, onStep, onClose])

  if (!s) return null

  const pad = 8
  const vw = window.innerWidth
  const vh = window.innerHeight
  // Card placement: below the target when there's room, else above, else
  // beside it (full-height targets leave no room either way); centered when
  // the step has no target. Every branch clamps to the viewport and caps
  // the card height so long step texts scroll instead of spilling off
  // screen.
  const cardW = Math.min(380, vw - 24)
  const gap = pad + 8
  const estH = 240 // safe estimate; maxHeight + scroll covers the rest
  let cardStyle: React.CSSProperties
  if (rect) {
    const left = Math.max(12, Math.min(rect.left, vw - cardW - 12))
    const spaceBelow = vh - rect.bottom - gap - 12
    const spaceAbove = rect.top - gap - 12
    const spaceRight = vw - rect.right - gap - 12
    if (spaceBelow >= estH) {
      cardStyle = {
        top: rect.bottom + gap,
        left,
        width: cardW,
        maxHeight: spaceBelow,
        overflowY: "auto",
      }
    } else if (spaceAbove >= estH) {
      cardStyle = {
        bottom: vh - rect.top + gap,
        left,
        width: cardW,
        maxHeight: spaceAbove,
        overflowY: "auto",
      }
    } else if (spaceRight >= cardW) {
      cardStyle = {
        top: Math.max(12, Math.min(rect.top, vh - estH - 12)),
        left: rect.right + gap,
        width: cardW,
        maxHeight: vh - 24,
        overflowY: "auto",
      }
    } else {
      cardStyle = {
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: cardW,
        maxHeight: vh - 24,
        overflowY: "auto",
      }
    }
  } else {
    cardStyle = {
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: cardW,
      maxHeight: vh - 24,
      overflowY: "auto",
    }
  }

  return (
    <div className="fixed inset-0 z-[120]" role="dialog" aria-label="App guide">
      {/* Spotlight: the cutout div's giant shadow dims everything else. */}
      {rect ? (
        <div
          className="pointer-events-none absolute rounded-xl ring-2 ring-primary/80 transition-all duration-300"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.65)",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/65" />
      )}
      {/* Click-through blocker so the app underneath isn't interactive. */}
      <div className="absolute inset-0" onClick={onClose} />

      <div
        className="absolute rounded-xl border border-border/70 bg-popover p-4 shadow-2xl"
        style={cardStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="text-sm font-semibold">{s.title}</div>
          <button
            type="button"
            aria-label="Close guide"
            onClick={onClose}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          {s.text}
        </p>
        <div className="mt-3 flex items-center justify-between">
          <div className="flex items-center gap-1">
            {steps.map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  i === step ? "bg-primary" : "bg-muted-foreground/30",
                )}
              />
            ))}
          </div>
          <div className="flex gap-1.5">
            {step > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onStep(step - 1)}
              >
                Back
              </Button>
            )}
            {step < steps.length - 1 ? (
              <Button size="sm" className="h-7 text-xs" onClick={() => onStep(step + 1)}>
                Next
              </Button>
            ) : (
              <Button size="sm" className="h-7 text-xs" onClick={onClose}>
                Done
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
