#!/usr/bin/env node
// Create backend/.venv with a Python 3.11+ interpreter and install backend in editable mode.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const isWin = process.platform === "win32";
const backendDir = resolve("backend");
const venvDir = join(backendDir, ".venv");

function tryRun(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: "ignore" });
  return res.status === 0;
}

function findPython() {
  // Prefer 3.11 / 3.12 / 3.13 in that order; accept any 3.11+ as a final fallback.
  const candidates = isWin
    ? [
        ["py", ["-3.11"]],
        ["py", ["-3.12"]],
        ["py", ["-3.13"]],
        ["py", ["-3"]],
        ["python", []],
      ]
    : [
        ["python3.11", []],
        ["python3.12", []],
        ["python3.13", []],
        ["python3", []],
      ];
  for (const [bin, prefix] of candidates) {
    if (!tryRun(bin, [...prefix, "--version"])) continue;
    const res = spawnSync(
      bin,
      [...prefix, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
      { encoding: "utf8" }
    );
    if (res.status !== 0) continue;
    const [maj, min] = res.stdout.trim().split(".").map(Number);
    if (maj >= 3 && min >= 11) return { bin, prefix };
  }
  return null;
}

const py = findPython();
if (!py) {
  console.error("No Python 3.11+ found on PATH. Run 'npm run check-system' for install hints.");
  process.exit(1);
}

console.log(`>>> Using Python: ${py.bin} ${py.prefix.join(" ")}`.trimEnd());

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.error) {
    console.error(`>>> Failed to spawn '${cmd}': ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const venvPython = isWin
  ? join(venvDir, "Scripts", "python.exe")
  : join(venvDir, "bin", "python");

if (!existsSync(venvDir)) {
  console.log(">>> Creating backend/.venv");
  run(py.bin, [...py.prefix, "-m", "venv", ".venv"], { cwd: backendDir });
}

// Ensure pip is present (Debian/Ubuntu venvs sometimes ship without it).
const pipCheck = spawnSync(venvPython, ["-m", "pip", "--version"], { stdio: "ignore" });
if (pipCheck.status !== 0) {
  console.log(">>> pip missing in venv — bootstrapping via ensurepip");
  run(venvPython, ["-m", "ensurepip", "--upgrade"]);
}

console.log(">>> Upgrading pip");
run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);

console.log(">>> Installing backend (editable)");
run(venvPython, ["-m", "pip", "install", "-e", "."], { cwd: backendDir });

console.log(">>> Backend install complete.");
