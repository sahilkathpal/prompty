#!/usr/bin/env node
// Block G2: build the Swift audio sidecar in release mode, codesign it with
// the Developer ID Application identity if available, then stage the binary at
// app/resources/audio-sidecar so electron-builder's `extraResources` can pick
// it up.
//
// Graceful no-op for local dev: if `swift` is missing we warn and exit 0; if
// APPLE_DEVELOPER_ID is unset we skip codesigning. `npm run build` must always
// succeed without Apple credentials.

import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, "..");
const repoRoot = resolve(appDir, "..");
const sidecarDir = resolve(repoRoot, "audio-sidecar");
const releaseBinary = resolve(sidecarDir, ".build/release/AudioSidecar");
const destPath = resolve(appDir, "resources/audio-sidecar");

function log(msg) {
  console.log(`[prebuild-sidecar] ${msg}`);
}
function warn(msg) {
  console.warn(`[prebuild-sidecar] ${msg}`);
}

function which(bin) {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function buildSidecar() {
  if (!existsSync(sidecarDir)) {
    warn(`audio-sidecar/ not found at ${sidecarDir} — skipping build`);
    return false;
  }
  if (!which("swift")) {
    warn("`swift` not found on PATH — skipping sidecar build (dev machines without Xcode are OK)");
    return false;
  }
  log(`swift build -c release  (cwd=${sidecarDir})`);
  const r = spawnSync("swift", ["build", "-c", "release"], {
    cwd: sidecarDir,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    warn(`swift build failed with exit code ${r.status} — sidecar will not be embedded`);
    return false;
  }
  if (!existsSync(releaseBinary)) {
    warn(`expected binary missing at ${releaseBinary}`);
    return false;
  }
  return true;
}

function codesignSidecar() {
  const identity = process.env.APPLE_DEVELOPER_ID;
  if (!identity) {
    warn("skipping codesign (APPLE_DEVELOPER_ID unset)");
    return;
  }
  log(`codesign --force --options runtime --sign "${identity}" ${releaseBinary}`);
  const r = spawnSync(
    "codesign",
    [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--sign",
      identity,
      releaseBinary,
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) {
    throw new Error(`codesign failed with exit code ${r.status}`);
  }
}

function stageBinary() {
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(releaseBinary, destPath);
  chmodSync(destPath, 0o755);
  log(`staged sidecar → ${destPath}`);
}

function main() {
  const ok = buildSidecar();
  if (!ok) {
    log("sidecar not built — leaving existing resources/audio-sidecar placeholder in place");
    return;
  }
  codesignSidecar();
  stageBinary();
}

main();
