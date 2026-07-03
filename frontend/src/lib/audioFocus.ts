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

/** Announce that the player with `id` started producing audio. */
export function claimPlayback(id: string): void {
  listeners.forEach((l) => l(id))
}

/** Subscribe to claims. Returns an unsubscribe function. */
export function onPlaybackClaimed(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
