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

import { app, powerMonitor } from "electron";
import type { AppUpdater } from "electron-updater";
import { capture } from "./analytics";
import { shouldAutoApply, IDLE_THRESHOLD_SECONDS } from "./updater-policy";

export { shouldAutoApply, type AutoApplyState } from "./updater-policy";

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

// Opt-in silent auto-apply: once an update is staged, re-evaluate the gate on
// this cadence and apply the moment the user is idle and off any call. Only
// active when the user has turned autoInstallUpdates on. The idle threshold and
// the decision itself live in updater-policy.ts (pure, unit-tested).
const AUTO_APPLY_POLL_MS = 60_000;

let updater: AppUpdater | null = null;
let updateDownloaded = false;
let intervalTimer: NodeJS.Timeout | null = null;
let autoApplyTimer: NodeJS.Timeout | null = null;

// Injected at initUpdater() so this module never imports ipc-handlers/settings
// (avoids a cycle). isCallActive → a call is live; autoApplyEnabled → the user
// opted into silent auto-apply. onDownloadedCb refreshes the tray; notifyReadyCb
// surfaces the default "update ready" prompt. Stored regardless of environment so
// the E2E simulate seam can drive the same download-handling path.
let isCallActive: () => boolean = () => false;
let autoApplyEnabled: () => boolean = () => false;
let onDownloadedCb: () => void = () => {};
let notifyReadyCb: (version?: string) => void = () => {};

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
export function initUpdater(
  opts: {
    onUpdateDownloaded?: () => void;
    /** Whether a call is currently live — a hard gate on silent auto-apply. */
    isCallActive?: () => boolean;
    /** Whether the user opted into fully-silent auto-apply (a settings read). */
    autoApplyEnabled?: () => boolean;
    /** Surface the default "update ready" prompt (a notification) once staged. */
    notifyUpdateReady?: (version?: string) => void;
  } = {},
): void {
  // Store injected deps first — even in dev/E2E/kill-switch — so the E2E simulate
  // seam (and the tray) see the real predicates without wiring the network path.
  if (opts.isCallActive) isCallActive = opts.isCallActive;
  if (opts.autoApplyEnabled) autoApplyEnabled = opts.autoApplyEnabled;
  if (opts.onUpdateDownloaded) onDownloadedCb = opts.onUpdateDownloaded;
  if (opts.notifyUpdateReady) notifyReadyCb = opts.notifyUpdateReady;

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
  autoUpdater.on("update-downloaded", (info) => handleUpdateDownloaded(info?.version));
  autoUpdater.on("error", (err) => {
    // Expected before a real signed feed exists — log + capture, never crash.
    console.error("[updater] error:", err?.message ?? err);
    capture("update_error", { message: err?.message ?? String(err) });
  });

  // First check shortly after launch, then on a steady interval.
  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS);
  intervalTimer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
}

/**
 * Handle a freshly-staged update: mark it downloaded, refresh the tray (badge +
 * "Restart to update"), surface the default "update ready" prompt (unless a call
 * is live), and begin the opt-in silent auto-apply poll. Shared by the real
 * electron-updater event and the E2E simulate seam.
 */
function handleUpdateDownloaded(version?: string): void {
  console.log("[updater] update downloaded:", version);
  updateDownloaded = true;
  capture("update_downloaded", { version });
  try {
    onDownloadedCb(); // refresh the tray (badge + "Restart to update")
  } catch (e) {
    console.error("[updater] onUpdateDownloaded callback failed:", (e as Error).message);
  }
  // Default (always-on) surface: a discoverable "update ready" prompt, so the
  // staged update isn't hidden behind the tray menu. Skipped mid-call — it'd be
  // noise, and the tray badge already carries the signal until the call ends.
  if (!isCallActive()) {
    try {
      notifyReadyCb(version);
    } catch (e) {
      console.error("[updater] notifyUpdateReady callback failed:", (e as Error).message);
    }
  }
  // Opt-in silent auto-apply: start re-evaluating the idle/no-call gate.
  startAutoApplyPolling();
}

/**
 * E2E-only seam: drive the download-handling path (tray badge, "update ready"
 * prompt, auto-apply poll) without a packaged build or a real feed. Inert unless
 * PROMPTY_E2E is set, so it can never fire in a shipped app.
 */
export function __simulateUpdateDownloadedForTests(version?: string): void {
  if (!E2E) return;
  handleUpdateDownloaded(version);
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
 * to the tray "Restart to update" item. No-op if nothing is staged. `trigger`
 * distinguishes a user click ("manual") from the silent idle path ("auto").
 */
export function installUpdateNow(trigger: "manual" | "auto" = "manual"): void {
  if (!updater || !updateDownloaded) return;
  // Never restart out from under a live call — even on an explicit click (a
  // notification made before a call can be clicked during one). The tray item is
  // already disabled mid-call; this is the belt-and-suspenders backstop for every
  // caller. It re-applies on the next click/quit once the call ends.
  if (isCallActive()) {
    console.log("[updater] install deferred — a call is active");
    return;
  }
  capture("update_installed", { trigger });
  // isSilent:false, isForceRunAfter:true → show progress, relaunch when done.
  updater.quitAndInstall(false, true);
}

/**
 * Begin polling the silent auto-apply gate once an update is staged. Each tick
 * re-checks the pure shouldAutoApply() decision; when it passes we apply and stop.
 * Only meaningful for opted-in users — for everyone else every tick is a no-op
 * (enabled=false) and the update just waits for the manual restart or next quit.
 */
function startAutoApplyPolling(): void {
  if (autoApplyTimer) return; // already polling
  const tick = () => {
    if (!updateDownloaded) return;
    const idleSeconds = safeIdleSeconds();
    if (
      shouldAutoApply({
        downloaded: updateDownloaded,
        enabled: autoApplyEnabled(),
        callActive: isCallActive(),
        idleSeconds,
        idleThresholdSeconds: IDLE_THRESHOLD_SECONDS,
      })
    ) {
      console.log("[updater] auto-applying staged update (idle, no call)");
      if (autoApplyTimer) {
        clearInterval(autoApplyTimer);
        autoApplyTimer = null;
      }
      installUpdateNow("auto");
    }
  };
  autoApplyTimer = setInterval(tick, AUTO_APPLY_POLL_MS);
}

/** powerMonitor is unavailable before app-ready and can throw; fail closed (0 =
 *  "just active", so no auto-apply) rather than crash the poll. */
function safeIdleSeconds(): number {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch {
    return 0;
  }
}

/** Stop the periodic check + auto-apply poll. Called on quit. */
export function stopUpdater(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (autoApplyTimer) {
    clearInterval(autoApplyTimer);
    autoApplyTimer = null;
  }
}
