/** Backend location resolution.
 *
 * The UI can be served two ways:
 *  - locally (vite dev server or the FastAPI process itself): API calls are
 *    same-origin relative paths, proxied in dev.
 *  - hosted (Cloudflare Pages etc.): the static page runs anywhere, but the
 *    backend is the user's own machine, so calls default to
 *    http://localhost:8000 (browsers exempt localhost from mixed-content
 *    blocking). A custom URL can be set in Settings and is persisted.
 */

const KEY = "automix.backend.v1"

function isLocalHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".local")
  )
}

export function defaultApiBase(): string {
  return isLocalHostname(window.location.hostname)
    ? "" // same origin (vite proxy in dev, FastAPI static serving otherwise)
    : "http://localhost:8000"
}

export function loadApiBase(): string {
  try {
    const v = localStorage.getItem(KEY)
    if (v != null) return v
  } catch {
    // storage unavailable
  }
  return defaultApiBase()
}

export function setApiBase(value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, value.replace(/\/+$/, ""))
  } catch {
    // storage unavailable
  }
}

/** Resolved once per page load — changing it requires a reload, which the
 *  Settings UI triggers. */
export const API_BASE = loadApiBase()

export function apiUrl(path: string): string {
  return API_BASE + path
}

export function wsUrl(path: string): string {
  if (API_BASE) return API_BASE.replace(/^http/, "ws") + path
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${proto}//${window.location.host}${path}`
}
