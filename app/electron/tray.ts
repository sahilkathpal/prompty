import { app, Menu, Tray, nativeImage } from "electron";
import path from "node:path";
import { showOverlay } from "./overlay-window";
import { openMainWindow } from "./main-window";
import { getActiveSession, endActiveSession } from "./ipc-handlers";

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

export function rebuildMenu(): void {
  if (!tray) return;
  let sessionActive = false;
  try {
    sessionActive = !!getActiveSession();
  } catch {}
  const menu = Menu.buildFromTemplate([
    {
      label: "Open main window",
      click: () => openMainWindow(),
    },
    {
      label: "Show overlay",
      enabled: sessionActive,
      click: () => showOverlay(),
    },
    {
      label: "End session",
      enabled: sessionActive,
      click: () => {
        void endActiveSession();
      },
    },
    { type: "separator" },
    {
      label: "Quit Ruby",
      click: () => app.quit(),
    },
  ]);
  tray.setContextMenu(menu);
}
