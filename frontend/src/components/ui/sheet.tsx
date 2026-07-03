import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Slide-over panel built on the Radix Dialog primitive — inherits its focus
 * trap, aria-modal, Esc/outside-click dismissal and body scroll lock.
 * Slide/fade animations are defined in index.css (.sheet-panel/.sheet-overlay).
 */
const Sheet = DialogPrimitive.Root

const SheetClose = DialogPrimitive.Close

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: "left" | "right"
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ side = "left", className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="sheet-overlay fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px]" />
    <DialogPrimitive.Content
      ref={ref}
      data-side={side}
      className={cn(
        "sheet-panel fixed inset-y-0 z-50 flex w-[85vw] max-w-sm flex-col border-border/60 bg-background shadow-2xl outline-none",
        side === "left" ? "left-0 border-r" : "right-0 border-l",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
SheetContent.displayName = "SheetContent"

const SheetTitle = DialogPrimitive.Title
const SheetDescription = DialogPrimitive.Description

export { Sheet, SheetClose, SheetContent, SheetTitle, SheetDescription }
