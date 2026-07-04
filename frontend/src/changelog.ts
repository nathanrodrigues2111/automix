/** App changelog, newest first — shown in Settings → What's new. */

export interface ChangelogEntry {
  version: string
  date: string
  title: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.5.0",
    date: "2026-07-04",
    title: "Full DJ sets & faster renders",
    items: [
      "Hour-long sets detect every drop (cap scales with duration)",
      "Paste or auto-fetch a tracklist to label drops with song names; one drop per song",
      "Search matches drop titles and filters a set down to the hit",
      "Add all drops in one click; re-analyze button on any track",
      "Renders run clips in parallel with fused encodes (much faster), plus a resolution picker (480p to 4K)",
      "Hosted app on GitHub Pages talks to your local backend; accent colors, credits, and privacy notes in Settings",
    ],
  },
  {
    version: "0.4.0",
    date: "2026-07-04",
    title: "Intro, outro & job control",
    items: [
      "Intro animation blended over the first buildup, ending exactly on the first drop (title hidden underneath)",
      "20s black outro reserved for YouTube end screens",
      "Cancel button for imports, Auto-Mix jobs, and renders",
      "Bulk rename modal with online title lookup (Deezer/iTunes)",
      "Select-all delete in the track list",
      "Live preview simulates the intro, branding, titles, and outro",
    ],
  },
  {
    version: "0.3.0",
    date: "2026-07-04",
    title: "Ear-tight transitions",
    items: [
      "Per-seam kick alignment measured from the actual audio, so drops land on the grid",
      "True local tempo per drop (fixes ~1% BPM-estimate drift across blends)",
      "2-bar vocal lead-in on every transition, with the outgoing track ducking fast so the incoming vocal is clear",
      "Titles switch exactly on each drop; video fades locked to the audio timeline",
      "Playlist track chooser with whole-playlist option",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-07-04",
    title: "Live preview & layout",
    items: [
      "Instant in-browser mix preview with the main player as a branded video monitor",
      "Auto-Mix bar moved into the header so the video and timeline fit above the fold",
      "Library split into videos/imports and videos/exports",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-07-04",
    title: "Detection & editing",
    items: [
      "Bass-gated drop detection, so vocal and intro sections are no longer picked as drops",
      "Drop starts land on the track's real pre-kick breath (per-track, not a fixed offset)",
      "Timeline zoom (Ctrl+scroll), smooth playhead follow, play/pause transport",
      "Track rename/copy, per-job progress logs, spacebar play/pause",
    ],
  },
]

/** Current app version = the newest changelog entry. */
export const APP_VERSION = CHANGELOG[0]?.version ?? "0.0.0"
