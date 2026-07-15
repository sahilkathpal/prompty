#!/usr/bin/env node
// Block G2: build the Swift audio sidecar in release mode as a UNIVERSAL
// (arm64 + x86_64) binary, codesign it with the Developer ID Application
// identity if available, then stage the binary at app/resources/audio-sidecar
// so electron-builder's `extraResources` can pick it up.
//
// Why universal: electron-builder copies this one binary into BOTH the arm64
// and x64 app bundles. A host-arch-only sidecar means an Intel user's x64 build
// ships an arm64 sidecar it can't exec (there is no reverse-Rosetta) → the
// sidecar dies with "Bad CPU type" and audio capture is silently dead. Building
// a fat binary makes the same sidecar run on either arch.
//
// Why two builds + lipo (not `swift build --arch arm64 --arch x86_64`): the
// single-invocation multi-arch path routes through xcbuild, which isn't present
// in a Command-Line-Tools-only toolchain (it errors out). Two single-arch builds
// + `lipo -create` works everywhere.
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
// Per-arch build outputs (SwiftPM uses an arch-triple subdir when `--arch` is
// given, not the plain `.build/release` symlink) and our lipo'd universal result.
const archTargets = ["arm64", "x86_64"];
const archBinaries = {
  arm64: resolve(sidecarDir, ".build/arm64-apple-macosx/release/AudioSidecar"),
  x86_64: resolve(sidecarDir, ".build/x86_64-apple-macosx/release/AudioSidecar"),
};
const releaseBinary = resolve(sidecarDir, ".build/universal/AudioSidecar");
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
  // Build each arch slice separately (see header for why not a single
  // multi-arch invocation).
  for (const arch of archTargets) {
    log(`swift build -c release --arch ${arch}  (cwd=${sidecarDir})`);
    const r = spawnSync("swift", ["build", "-c", "release", "--arch", arch], {
      cwd: sidecarDir,
      stdio: "inherit",
    });
    if (r.status !== 0) {
      warn(`swift build (${arch}) failed with exit code ${r.status} — sidecar will not be embedded`);
      return false;
    }
    if (!existsSync(archBinaries[arch])) {
      warn(`expected ${arch} binary missing at ${archBinaries[arch]}`);
      return false;
    }
  }

  // Fuse the slices into one universal binary at releaseBinary.
  mkdirSync(dirname(releaseBinary), { recursive: true });
  const inputs = archTargets.map((a) => archBinaries[a]);
  log(`lipo -create ${archTargets.join("+")} → ${releaseBinary}`);
  const l = spawnSync("lipo", ["-create", ...inputs, "-output", releaseBinary], {
    stdio: "inherit",
  });
  if (l.status !== 0) {
    warn(`lipo failed with exit code ${l.status} — sidecar will not be embedded`);
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
