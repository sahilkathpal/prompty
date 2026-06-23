// Over-the-air auto-update (main-process only), via electron-updater.
//
// This is the "writable now" half of the OTA plan (see RUBY_OTA_UPDATE_PLAN.md):
// the in-app updater code. It is deliberately INERT until a signed + notarized
// build is published to the feed declared in electron-builder.yml — macOS
// (Squirrel.Mac) refuses unsigned/un-notarized updates. We wire it now anyway
// because the updater must already be present in the FIRST signed build, or
// those users could never auto-update.
//
// Why it's safe to ship before the feed exists:
//   - It is a hard no-op unless `app.isPackaged` (so dev never runs it) and not
//     under E2E (PROMPTY_E2E). Tests and `npm run dev` never touch the network.
//   - In a packaged build with no reachable feed, electron-updater simply emits
//     an `error` event we log + capture; nothing crashes, nothing blocks.
//
// UX is quiet by design: silent background download, a tray "Restart to update"
// item that only appears once an update is downloaded, and auto-install on the
// next natural quit (autoInstallOnAppQuit). No modal ever interrupts a live call.
//
// Analytics is captured from the MAIN process (mirrors analytics.ts), so no
// renderer allowlist change is needed.

import { app } from "electron";
import type { AppUpdater } from "electron-updater";
import { capture } from "./analytics";

const E2E = process.env.PROMPTY_E2E === "1";
// Kill switch (audit finding #4). Lets a bad release be halted without shipping
// a code change: set PROMPTY_DISABLE_UPDATER=1 (e.g. via the launch environment)
// and the updater never wires up — no feed check, no download, no install. Fails
// safe: anything other than exactly "1" leaves auto-update on.
const DISABLED = process.env.PROMPTY_DISABLE_UPDATER === "1";

// Re-check cadence: once a few seconds after launch, then every 6h. Long-lived
// menu-bar app, so a periodic check catches releases without a relaunch.
const FIRST_CHECK_DELAY_MS = 8_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let updater: AppUpdater | null = null;
let updateDownloaded = false;
let intervalTimer: NodeJS.Timeout | null = null;

/** True once an update has finished downloading and is staged for install.
 *  The tray reads this to decide whether to show "Restart to update". */
export function isUpdateDownloaded(): boolean {
  return updateDownloaded;
}

/**
 * Wire up the auto-updater. No-op unless this is a packaged build and not E2E.
 * `onUpdateDownloaded` is invoked once a download completes so the caller can
 * refresh UI (the tray menu) to surface the "Restart to update" affordance.
 * Idempotent — calling twice does nothing the second time.
 */
export function initUpdater(opts: { onUpdateDownloaded?: () => void } = {}): void {
  if (DISABLED) console.warn("[updater] disabled via PROMPTY_DISABLE_UPDATER");
  if (!app.isPackaged || E2E || DISABLED) return; // inert in dev, tests, kill-switch
  if (updater) return; // already initialized

  let autoUpdater: AppUpdater;
  try {
    // Loaded lazily so dev/E2E never even require the module.
    ({ autoUpdater } = require("electron-updater") as typeof import("electron-updater"));
  } catch (e) {
    console.error("[updater] failed to load electron-updater:", (e as Error).message);
    return;
  }
  updater = autoUpdater;

  // Minimal logger — electron-updater writes lifecycle detail here.
  autoUpdater.logger = {
    info: (m: unknown) => console.log("[updater]", m),
    warn: (m: unknown) => console.warn("[updater]", m),
    error: (m: unknown) => console.error("[updater]", m),
    debug: () => {},
  };

  autoUpdater.autoDownload = true; // pull the update in the background
  autoUpdater.autoInstallOnAppQuit = true; // apply it on the next natural quit

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] checking for update");
  });
  autoUpdater.on("update-available", (info) => {
    console.log("[updater] update available:", info?.version);
    capture("update_available", { version: info?.version });
  });
  autoUpdater.on("update-not-available", () => {
    console.log("[updater] up to date");
  });
  autoUpdater.on("download-progress", (p) => {
    // Logged, not captured — per-chunk events would be far too noisy.
    console.log(`[updater] downloading ${Math.round(p?.percent ?? 0)}%`);
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updater] update downloaded:", info?.version);
    updateDownloaded = true;
    capture("update_downloaded", { version: info?.version });
    try {
      opts.onUpdateDownloaded?.();
    } catch (e) {
      console.error("[updater] onUpdateDownloaded callback failed:", (e as Error).message);
    }
  });
  autoUpdater.on("error", (err) => {
    // Expected before a real signed feed exists — log + capture, never crash.
    console.error("[updater] error:", err?.message ?? err);
    capture("update_error", { message: err?.message ?? String(err) });
  });

  // First check shortly after launch, then on a steady interval.
  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS);
  intervalTimer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
}

async function checkForUpdates(): Promise<void> {
  if (!updater) return;
  try {
    await updater.checkForUpdates();
  } catch (e) {
    // checkForUpdates rejects (in addition to emitting "error") when the feed is
    // unreachable; swallow so an unhandled rejection can't crash the process.
    console.error("[updater] check failed:", (e as Error).message);
  }
}

/**
 * Apply a downloaded update now: quit and relaunch into the new version. Wired
 * to the tray "Restart to update" item. No-op if nothing is staged.
 */
export function installUpdateNow(): void {
  if (!updater || !updateDownloaded) return;
  capture("update_installed");
  // isSilent:false, isForceRunAfter:true → show progress, relaunch when done.
  updater.quitAndInstall(false, true);
}

/** Stop the periodic check. Called on quit. */
export function stopUpdater(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
