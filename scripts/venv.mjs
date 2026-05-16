#!/usr/bin/env node
// Run a tool from the backend venv with backend/ as cwd.
// Usage: node scripts/venv.mjs <tool> [args...]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const isWin = process.platform === "win32";
const backendDir = resolve("backend");
const venvBin = isWin
  ? join(backendDir, ".venv", "Scripts")
  : join(backendDir, ".venv", "bin");

const [tool, ...args] = process.argv.slice(2);
if (!tool) {
  console.error("Usage: node scripts/venv.mjs <tool> [args...]");
  process.exit(2);
}

const exe = isWin ? join(venvBin, `${tool}.exe`) : join(venvBin, tool);
if (!existsSync(exe)) {
  console.error(`Not found: ${exe}\nRun 'npm run install:backend' first.`);
  process.exit(1);
}

const child = spawn(exe, args, { stdio: "inherit", cwd: backendDir });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
