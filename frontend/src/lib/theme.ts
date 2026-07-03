import { useSyncExternalStore } from "react"

export type ThemePref = "system" | "light" | "dark"
export type EffectiveTheme = "light" | "dark"

const STORAGE_KEY = "automix.theme"
const listeners = new Set<() => void>()
const media = window.matchMedia("(prefers-color-scheme: dark)")

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === "light" || v === "dark" ? v : "system"
  } catch {
    return "system"
  }
}

let pref: ThemePref = readPref()

export function effectiveTheme(): EffectiveTheme {
  return pref === "system" ? (media.matches ? "dark" : "light") : pref
}

/** Apply the theme by toggling `dark` on <html> so portals (dialogs, sheets,
 *  toasts) and the vidstack chrome all inherit it. */
function apply() {
  document.documentElement.classList.toggle("dark", effectiveTheme() === "dark")
}

function emit() {
  listeners.forEach((l) => l())
}

media.addEventListener("change", () => {
  if (pref === "system") {
    apply()
    emit()
  }
})

// First paint is handled by the inline script in index.html; this keeps the
// class in sync once the app module loads.
apply()

export function setThemePref(next: ThemePref) {
  pref = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // storage unavailable — theme just won't persist
  }
  apply()
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** The user's stored preference (system/light/dark). */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, () => pref)
}

/** The theme actually in effect right now (resolves "system"). */
export function useEffectiveTheme(): EffectiveTheme {
  return useSyncExternalStore(subscribe, effectiveTheme)
}
