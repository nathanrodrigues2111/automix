/** App changelog, newest first — shown in Settings → What's new. */

export interface ChangelogEntry {
  version: string
  date: string
  title: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.6.0",
    date: "2026-07-05",
    title: "Clean audio, hard cuts & self-verifying renders",
    items: [
      "Audio pipeline is float end to end: hot festival masters (peaks above full scale) no longer clip anywhere",
      "Loudness set by pure linear gain plus one final peak limiter; the pumping distortion from dynamic normalization is gone",
      "Video transitions are hard cuts on the incoming build (the natural editor cut), with titles switching on the cut",
      "Every drop in a set gets a full 8-bar body, so no more 2-second drops",
      "Kick anchors validated against the actual drop slam (fixes drops that started a beat early)",
      "Every render verifies itself: seam kick timing, loudness, true peak, and on-screen titles, with a report saved next to the export",
      "Long titles shorten smartly (never losing the track identity), then scale or wrap, always inside safe margins",
      "Raw track playback in the app auto-levels like YouTube does, so hot sources don't blow out",
      "Drop detection runs per song inside a set's tracklist, so every song gets its own candidates",
      "Track list groups each song's drops as a folder tree: confidence-ranked with main (green), alt (yellow), weakest (red) badges",
      "The main drop is always the highest-confidence candidate; alternates stay one click away, and song titles are editable in place",
    ],
  },
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
