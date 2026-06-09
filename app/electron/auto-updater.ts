// Block G4: wire `electron-updater` into the app. Only runs in packaged
// builds; in dev (`npm run dev`) this is a no-op so the dev never sees
// "update server unreachable" toasts.
//
// The update feed URL is configured in electron-builder.yml's `publish` block.
// At build time, electron-builder bakes that URL into `app-update.yml` inside
// the .app, and `autoUpdater` reads it on launch.
//
// IPC events:
//   "update:available"   → renderer (panel)
//   "update:downloaded"  → renderer (panel)

import { app, BrowserWindow } from "electron";

let wired = false;

export function setupAutoUpdater(): void {
  if (wired) return;
  if (!app.isPackaged) {
    console.log("[auto-updater] dev build — skipping");
    return;
  }
  wired = true;

  // Lazy require so dev runs (which lack a baked app-update.yml) don't
  // explode at import time if the dep is missing in the unpacked tree.
  let autoUpdater: typeof import("electron-updater").autoUpdater;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    autoUpdater = require("electron-updater").autoUpdater;
  } catch (err) {
    console.warn("[auto-updater] electron-updater not available:", (err as Error).message);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("[auto-updater] checking for update…");
  });
  autoUpdater.on("update-available", (info) => {
    console.log("[auto-updater] update available:", info.version);
    broadcastUpdate("update:available", { version: info.version });
  });
  autoUpdater.on("update-not-available", () => {
    console.log("[auto-updater] no update available");
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log("[auto-updater] update downloaded:", info.version);
    broadcastUpdate("update:downloaded", { version: info.version });
  });
  autoUpdater.on("error", (err) => {
    console.error("[auto-updater] error:", err.message);
  });

  // Fire-and-forget; checkForUpdatesAndNotify shows the native notification
  // when an update is downloaded and ready to install.
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.error("[auto-updater] checkForUpdatesAndNotify failed:", err.message);
  });
}

/** Triggered from the tray "Check for updates" menu item. */
export function checkForUpdatesNow(): void {
  if (!app.isPackaged) {
    console.log("[auto-updater] dev build — skipping manual check");
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require("electron-updater");
    autoUpdater.checkForUpdatesAndNotify().catch((err: Error) => {
      console.error("[auto-updater] manual check failed:", err.message);
    });
  } catch (err) {
    console.warn("[auto-updater] electron-updater not available:", (err as Error).message);
  }
}

function broadcastUpdate(channel: "update:available" | "update:downloaded", payload: { version: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}
