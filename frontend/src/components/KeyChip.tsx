import { camelotColors } from "@/lib/camelot"
import { cn } from "@/lib/utils"

interface KeyChipProps {
  keyCamelot: string | null | undefined
  className?: string
}

export function KeyChip({ keyCamelot, className }: KeyChipProps) {
  const colors = camelotColors(keyCamelot)
  if (!colors || !keyCamelot) return null
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide tabular-nums",
        className,
      )}
      style={{
        background: colors.bg,
        color: colors.fg,
        borderColor: colors.border,
      }}
    >
      {keyCamelot.toUpperCase()}
    </span>
  )
}
