#!/usr/bin/env node
// Cross-platform system check — verifies required CLI tools are present.
import { spawnSync } from "node:child_process";

const isWin = process.platform === "win32";
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const ok = c(32, "✓");
const bad = c(31, "✗");
const dim = (s) => c(2, s);

function detectOs() {
  if (isWin) return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") {
    if (which("apt-get")) return "debian";
    if (which("dnf")) return "fedora";
    if (which("pacman")) return "arch";
    return "linux";
  }
  if (process.platform === "freebsd") return "freebsd";
  return "unknown";
}

function which(cmd) {
  const finder = isWin ? "where" : "which";
  const res = spawnSync(finder, [cmd], { stdio: "ignore" });
  return res.status === 0;
}

function version(cmd, args = ["--version"]) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.status !== 0) return null;
  const out = (res.stdout || res.stderr || "").split(/\r?\n/)[0].trim();
  return out || null;
}

const OS = detectOs();
let missing = 0;

const HINTS = {
  debian: {
    ffmpeg: "sudo apt-get install -y ffmpeg",
    rubberband: "sudo apt-get install -y rubberband-cli",
    python: "sudo apt-get install -y python3.11 python3.11-venv python3.11-dev",
    node: "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs",
    npm: "installed alongside nodejs (see above)",
  },
  fedora: {
    ffmpeg: "sudo dnf install -y ffmpeg",
    rubberband: "sudo dnf install -y rubberband",
    python: "sudo dnf install -y python3.11",
    node: "sudo dnf install -y nodejs npm",
    npm: "sudo dnf install -y nodejs npm",
  },
  arch: {
    ffmpeg: "sudo pacman -S ffmpeg",
    rubberband: "sudo pacman -S rubberband",
    python: "sudo pacman -S python311  (or use pyenv)",
    node: "sudo pacman -S nodejs npm",
    npm: "sudo pacman -S nodejs npm",
  },
  macos: {
    ffmpeg: "brew install ffmpeg",
    rubberband: "brew install rubberband",
    python: "brew install python@3.11",
    node: "brew install node@20",
    npm: "installed alongside node (see above)",
  },
  windows: {
    ffmpeg: "winget install Gyan.FFmpeg  (or: choco install ffmpeg)",
    rubberband: "scoop install rubberband  (or download from breakfastquay.com)",
    python: "winget install Python.Python.3.11",
    node: "winget install OpenJS.NodeJS.LTS",
    npm: "installed alongside node (see above)",
  },
  freebsd: {
    ffmpeg: "sudo pkg install ffmpeg",
    rubberband: "sudo pkg install rubberband",
    python: "sudo pkg install python311",
    node: "sudo pkg install node20",
    npm: "sudo pkg install npm",
  },
};

function hint(tool) {
  // ffprobe ships inside the ffmpeg package everywhere.
  if (tool === "ffprobe") tool = "ffmpeg";
  const table = HINTS[OS];
  let base = table && table[tool] ? `  ${table[tool]}` : `  install '${tool}' via your platform's package manager`;
  // Volta is this project's preferred Node manager (cross-platform).
  if (tool === "node") base += "\n  (preferred: install Volta from https://volta.sh, then `volta install node@20`)";
  return base;
}

function pad(label, width = 14) {
  return label + " ".repeat(Math.max(0, width - label.length));
}

function check(label, cmd) {
  if (!which(cmd)) {
    console.log(`${bad} ${pad(label)} ${dim("not found")}`);
    console.log(hint(label));
    missing++;
    return;
  }
  const v = version(cmd) || "";
  console.log(`${ok} ${pad(label)} ${dim(v)}`);
}

// Optional tool: report presence but never count it as a missing requirement.
function checkOptional(label, cmd, note) {
  const mark = c(33, "○");
  if (!which(cmd)) {
    console.log(`${mark} ${pad(label)} ${dim("not found (optional)")}`);
    if (note) console.log(dim(`  ${note}`));
    return;
  }
  const v = version(cmd) || "";
  console.log(`${ok} ${pad(label)} ${dim(v)}`);
}

function checkNode() {
  if (!which("node")) {
    console.log(`${bad} ${pad("node")} ${dim("not found")}`);
    console.log(hint("node"));
    missing++;
    return;
  }
  const v = (version("node") || "").replace(/^v/, "");
  const major = parseInt(v.split(".")[0], 10) || 0;
  if (major >= 20) {
    console.log(`${ok} ${pad("node")} ${dim("v" + v)}`);
  } else {
    console.log(`${bad} ${pad("node")} ${dim("v" + v + " (need >=20)")}`);
    console.log(hint("node"));
    missing++;
  }
}

function checkPython() {
  // The backend runs from its own venv, and `uv` can create that venv with a
  // supported, managed Python even when the system Python is too new (3.13+)
  // or absent. So if uv is present, the Python requirement is satisfied.
  if (which("uv")) {
    console.log(`${ok} ${pad("python")} ${dim("provided by uv (creates the backend venv)")}`);
    return;
  }
  // No uv: fall back to a system interpreter. Backend requires >=3.10 (any).
  const candidates = isWin
    ? [["py", ["-3.14"]], ["py", ["-3.13"]], ["py", ["-3.12"]], ["py", ["-3.11"]], ["py", ["-3.10"]], ["py", ["-3"]], ["python", []]]
    : [["python3.14", []], ["python3.13", []], ["python3.12", []], ["python3.11", []], ["python3.10", []], ["python3", []]];
  for (const [bin, prefix] of candidates) {
    if (!which(bin)) continue;
    const res = spawnSync(
      bin,
      [...prefix, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
      { encoding: "utf8" }
    );
    if (res.status !== 0) continue;
    const v = res.stdout.trim();
    const [maj, min] = v.split(".").map(Number);
    if (maj === 3 && min >= 10) {
      const display = `${bin}${prefix.length ? " " + prefix.join(" ") : ""}`;
      console.log(`${ok} ${pad("python>=3.10")} ${dim(`${v} (${display})`)}`);
      return;
    }
  }
  console.log(`${bad} ${pad("python>=3.10")} ${dim("need Python 3.10+, or install uv")}`);
  console.log(hint("python"));
  missing++;
}

console.log(`automix — system check (OS: ${OS})`);
console.log("--------------------------------");
checkOptional("uv", "uv", "recommended Python manager — see scripts/setup.* or https://docs.astral.sh/uv/");
checkPython();
checkNode();
check("npm", "npm");
check("ffmpeg", "ffmpeg");
check("ffprobe", "ffprobe");
checkOptional("yt-dlp", "yt-dlp", "needed for YouTube import; bundled in the backend venv (global copy: uv tool install yt-dlp)");
checkOptional("rubberband", "rubberband", "only for BPM stretch / pitch-shift modes; default drops-only mode doesn't use it");
console.log("--------------------------------");
if (missing === 0) {
  console.log(`${ok} All required tools present.`);
  process.exit(0);
} else {
  console.log(`${bad} ${missing} required tool(s) missing — see hints above.`);
  process.exit(1);
}
