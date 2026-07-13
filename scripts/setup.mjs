#!/usr/bin/env node
// Cross-platform entry point for `npm run setup`: runs the right OS bootstrap
// script (setup.ps1 on Windows, setup.sh on Linux/macOS). Any extra args are
// forwarded, e.g. `npm run setup -- --with-ml`.
//
// Note: this needs Node already installed. On a brand-new machine with no Node,
// run the platform script directly instead — see SETUP.md.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const isWin = process.platform === "win32";

const [cmd, cmdArgs] = isWin
  ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(here, "setup.ps1"), ...args]]
  : ["bash", [resolve(here, "setup.sh"), ...args]];

const res = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
if (res.error) {
  console.error(`Failed to launch setup script: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 1);
