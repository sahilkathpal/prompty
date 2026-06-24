import { app, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from "electron";
import path from "node:path";
import { showOverlay } from "./overlay-window";
import { openMainWindow } from "./main-window";
import { getActiveSession, endActiveSession } from "./ipc-handlers";
import { getSettings } from "./settings-store";
import { isUpdateDownloaded, installUpdateNow } from "./updater";
import { openExternalSafely } from "./safe-open";
import { getRemoteConfig } from "../src/main-process/remote-config";

let tray: Tray | null = null;

function iconPath(): string {
  return path.join(__dirname, "../../../resources/tray-icon-Template.png");
}

export function createTray(): Tray {
  if (tray) return tray;
  let image = nativeImage.createFromPath(iconPath());
  if (image.isEmpty()) {
    image = nativeImage.createEmpty();
  }
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("Ruby");
  rebuildMenu();
  return tray;
}

/** True once the menu-bar tray has been created (exists from app ready, incl.
 *  onboarding). Exported for the e2e guard. */
export function hasTray(): boolean {
  return tray !== null;
}

/** The tray context-menu template. Pure (reads live settings/session state) so
 *  the e2e suite can assert the gating without driving a native menu. */
export function buildTrayMenuTemplate(): MenuItemConstructorOptions[] {
  let sessionActive = false;
  try {
    sessionActive = !!getActiveSession();
  } catch {}
  let updateReady = false;
  try {
    updateReady = isUpdateDownloaded();
  } catch {}
  return [
    // Only present once a background download has staged an update. Clicking it
    // quits and relaunches into the new version; otherwise the update applies
    // silently on the next natural quit (autoInstallOnAppQuit).
    ...(updateReady
      ? ([
          {
            label: "Restart to update",
            click: () => installUpdateNow(),
          },
          { type: "separator" },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: "Open main window",
      // The main app window isn't part of the guided onboarding flow — keep it
      // out of reach until onboarding completes so the tray can't derail it.
      enabled: getSettings().onboardingCompleted,
      click: () => openMainWindow(),
    },
    {
      label: "Show overlay",
      enabled: sessionActive,
      click: () => showOverlay(),
    },
    {
      label: "Stop Listening",
      enabled: sessionActive,
      click: () => {
        void endActiveSession();
      },
    },
    { type: "separator" },
    {
      label: "How Ruby works",
      click: () => openExternalSafely(getRemoteConfig().howItWorksUrl),
    },
    {
      label: "Quit Ruby",
      click: () => app.quit(),
    },
  ];
}

export function rebuildMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
}

// Test seam: the tray menu is native (not DOM) and the running module instance
// can't be re-required from a Playwright evaluate callback, so expose the pure
// inspectors here. Two function references — harmless in production.
(globalThis as unknown as { __prompty_tray?: unknown }).__prompty_tray = {
  hasTray,
  buildTrayMenuTemplate,
};
