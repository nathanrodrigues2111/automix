import { useCallback, useEffect, useRef, useState } from "react"

/** A custom right-click menu (Cut / Copy / Paste / Select All). The packaged
 *  desktop app (pywebview) has no reliable native context menu, so clipboard
 *  actions would otherwise be unreachable by mouse there. Enabled everywhere
 *  (including the dev browser) so behaviour is consistent across platforms. */

type Target = HTMLInputElement | HTMLTextAreaElement | HTMLElement

interface MenuState {
  x: number
  y: number
  target: Target
  editable: boolean
  hasSelection: boolean
}

function isTextField(el: Target | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false
  const tag = el.tagName
  if (tag === "TEXTAREA") return true
  if (tag !== "INPUT") return false
  const type = (el as HTMLInputElement).type
  // Types that hold selectable/insertable text.
  return !["checkbox", "radio", "range", "color", "button", "submit", "file"].includes(type)
}

// Update a React-controlled input without React's value tracker swallowing the
// change: call the native value setter, then dispatch a real input event.
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    return ""
  }
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      return document.execCommand("copy")
    } catch {
      return false
    }
  }
}

export function DesktopContextMenu() {
  const [enabled, setEnabled] = useState<boolean>(
    () => typeof window !== "undefined" && !!(window as unknown as { pywebview?: unknown }).pywebview,
  )
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // pywebview injects window.pywebview asynchronously and fires this event.
  useEffect(() => {
    if (enabled) return
    const on = () => setEnabled(true)
    window.addEventListener("pywebviewready", on)
    return () => window.removeEventListener("pywebviewready", on)
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    const onCtx = (e: MouseEvent) => {
      const target = e.target as Target | null
      if (!target) return
      e.preventDefault()
      const editable = isTextField(target) || (target as HTMLElement).isContentEditable
      const sel = window.getSelection()?.toString() ?? ""
      const fieldSel = isTextField(target)
        ? (target.selectionStart ?? 0) !== (target.selectionEnd ?? 0)
        : false
      setMenu({
        x: e.clientX,
        y: e.clientY,
        target,
        editable,
        hasSelection: !!sel || fieldSel,
      })
    }
    document.addEventListener("contextmenu", onCtx)
    return () => document.removeEventListener("contextmenu", onCtx)
  }, [enabled])

  // Dismiss on any outside interaction.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null)
    window.addEventListener("pointerdown", close, true)
    window.addEventListener("blur", close)
    window.addEventListener("resize", close)
    window.addEventListener("scroll", close, true)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("pointerdown", close, true)
      window.removeEventListener("blur", close)
      window.removeEventListener("resize", close)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("keydown", onKey)
    }
  }, [menu])

  const run = useCallback(
    async (action: "cut" | "copy" | "paste" | "selectAll") => {
      if (!menu) return
      const el = menu.target
      const field = isTextField(el) ? el : null
      // Restore focus/selection to the field the menu was opened on.
      if (field) field.focus()

      if (action === "selectAll") {
        if (field) field.select()
        else document.execCommand("selectAll")
      } else if (action === "copy") {
        const text = field
          ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)
          : window.getSelection()?.toString() ?? ""
        if (text) await writeClipboard(text)
      } else if (action === "cut") {
        if (field) {
          const s = field.selectionStart ?? 0
          const e = field.selectionEnd ?? 0
          if (s !== e) {
            await writeClipboard(field.value.slice(s, e))
            setNativeValue(field, field.value.slice(0, s) + field.value.slice(e))
            field.setSelectionRange(s, s)
          }
        } else {
          const text = window.getSelection()?.toString() ?? ""
          if (text && (await writeClipboard(text))) document.execCommand("delete")
        }
      } else if (action === "paste") {
        const text = await readClipboard()
        if (text && field) {
          const s = field.selectionStart ?? field.value.length
          const e = field.selectionEnd ?? field.value.length
          setNativeValue(field, field.value.slice(0, s) + text + field.value.slice(e))
          const caret = s + text.length
          field.setSelectionRange(caret, caret)
        } else if (text) {
          document.execCommand("insertText", false, text)
        }
      }
      setMenu(null)
    },
    [menu],
  )

  if (!menu) return null

  // Keep the menu inside the viewport.
  const MENU_W = 176
  const MENU_H = 168
  const left = Math.min(menu.x, window.innerWidth - MENU_W - 8)
  const top = Math.min(menu.y, window.innerHeight - MENU_H - 8)

  const items: Array<{
    label: string
    action: "cut" | "copy" | "paste" | "selectAll"
    enabled: boolean
    hint: string
  }> = [
    { label: "Cut", action: "cut", enabled: menu.editable && menu.hasSelection, hint: "Ctrl+X" },
    { label: "Copy", action: "copy", enabled: menu.hasSelection, hint: "Ctrl+C" },
    { label: "Paste", action: "paste", enabled: menu.editable, hint: "Ctrl+V" },
    { label: "Select all", action: "selectAll", enabled: menu.editable, hint: "Ctrl+A" },
  ]

  return (
    <div
      ref={menuRef}
      role="menu"
      style={{ left, top }}
      // Stop the outside-close handler from firing for clicks on the menu.
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-[100] min-w-44 overflow-hidden rounded-lg border border-border/70 bg-popover/95 p-1 shadow-2xl backdrop-blur"
    >
      {items.map((it) => (
        <button
          key={it.action}
          type="button"
          role="menuitem"
          disabled={!it.enabled}
          onClick={() => void run(it.action)}
          className="flex w-full items-center justify-between gap-6 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent/60 disabled:pointer-events-none disabled:opacity-40"
        >
          <span>{it.label}</span>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {it.hint}
          </span>
        </button>
      ))}
    </div>
  )
}
