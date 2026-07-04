import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn(
      "relative h-1.5 w-full overflow-hidden rounded-full bg-secondary/80 ring-1 ring-inset ring-border/40",
      className
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn(
        "relative h-full w-full flex-1 rounded-full",
        "bg-primary",
        "shadow-[0_0_10px_-1px_color-mix(in_oklch,var(--primary)_70%,transparent)]",
        "transition-transform duration-500 ease-out",
        // moving sheen so active progress reads as alive, not stuck
        "after:absolute after:inset-0 after:rounded-full after:bg-gradient-to-r after:from-transparent after:via-white/30 after:to-transparent after:bg-[length:40%_100%] after:bg-no-repeat after:animate-[progress-shimmer_1.6s_ease-in-out_infinite]"
      )}
      style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
    />
  </ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
