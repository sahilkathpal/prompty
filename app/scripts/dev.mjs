// Dev orchestrator: start Vite, build main process, then launch Electron with VITE_DEV_SERVER_URL set.
// Keeps everything in one terminal; restarts Electron's main process on TS rebuilds is out of scope (manual restart is fine).

import { spawn } from "node:child_process";
import { existsSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import waitOn from "wait-on";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const VITE_URL = "http://localhost:5173";

function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  p.on("exit", (code) => {
    if (code && code !== 0 && !opts.allowFail) {
      process.exit(code);
    }
  });
  return p;
}

const electronBin = resolve(root, "node_modules/.bin/electron");
const viteBin = resolve(root, "node_modules/.bin/vite");
const tscBin = resolve(root, "node_modules/.bin/tsc");

if (!existsSync(electronBin)) {
  console.error("electron not installed. Run `npm install` in app/ first.");
  process.exit(1);
}

console.log("[dev] starting vite…");
const vite = run(viteBin, []);

console.log("[dev] building main process (one-shot)…");
const build = spawn(tscBin, ["-p", "tsconfig.electron.json"], {
  stdio: "inherit",
  cwd: root,
});
await new Promise((res) => build.on("exit", res));

// Copy non-TS assets (the prompt markdown) into dist so __dirname-relative
// lookups in compiled main-process code can find them. Mirrors the copy step in
// `build:main` — without base.md, loadBase() throws "no base.md prompt found".
const promptsSrc = resolve(root, "src/main-process/prompts");
const promptsDst = resolve(root, "dist/electron/src/main-process/prompts");
const skillsSrc = resolve(promptsSrc, "skills");
if (existsSync(skillsSrc)) {
  cpSync(skillsSrc, resolve(promptsDst, "skills"), { recursive: true });
  console.log("[dev] copied skills/ -> dist");
}
const baseSrc = resolve(promptsSrc, "base.md");
if (existsSync(baseSrc)) {
  cpSync(baseSrc, resolve(promptsDst, "base.md"));
  console.log("[dev] copied base.md -> dist");
}

console.log("[dev] waiting for vite…");
await waitOn({
  resources: [`http-get://localhost:5173`],
  timeout: 30_000,
  validateStatus: () => true,
});

console.log("[dev] launching electron…");
const electron = run(electronBin, ["."], {
  env: { ...process.env, VITE_DEV_SERVER_URL: VITE_URL },
});

const shutdown = () => {
  try { vite.kill(); } catch {}
  try { electron.kill(); } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
electron.on("exit", shutdown);
