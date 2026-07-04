/**
 * Exclusive-playback bus: only one player should produce audio at a time.
 *
 * Every player claims focus with its own id when it starts playing; all
 * other subscribed players pause themselves when they see a claim that
 * isn't theirs. Wired inside Player.tsx, so every use site (drop preview,
 * Auto-Mix result, render result) participates automatically.
 */

type Listener = (activeId: string) => void

const listeners = new Set<Listener>()

interface PlayerHandle {
  paused: boolean
  play(): unknown
  pause(): unknown
}

// Registry of mounted players (insertion order = mount order), so global
// keyboard shortcuts can reach "the" player without prop drilling.
const players = new Map<string, () => PlayerHandle | null>()
let activeId: string | null = null

/** Announce that the player with `id` started producing audio. */
export function claimPlayback(id: string): void {
  activeId = id
  listeners.forEach((l) => l(id))
}

/** Register a mounted player. Returns an unregister function. */
export function registerPlayer(
  id: string,
  get: () => PlayerHandle | null,
): () => void {
  players.set(id, get)
  return () => {
    players.delete(id)
    if (activeId === id) activeId = null
  }
}

/**
 * Play/pause the active player — the one that last claimed audio focus, or
 * failing that the most recently mounted one. Returns true when a player
 * handled the toggle (so the caller can preventDefault).
 */
export function toggleActivePlayback(): boolean {
  const get =
    (activeId ? players.get(activeId) : undefined) ??
    [...players.values()].pop()
  const p = get?.()
  if (!p) return false
  if (p.paused) void p.play()
  else void p.pause()
  return true
}

/** Subscribe to claims. Returns an unsubscribe function. */
export function onPlaybackClaimed(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
