import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { getSettings, setPanelPosition } from "./settings-store";

const DEFAULT_W = 240;
const DEFAULT_H = 420;

let overlay: BrowserWindow | null = null;
let devUrlCached: string | undefined;

function defaultPosition(): { x: number; y: number } {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  return {
    x: workArea.x + workArea.width - DEFAULT_W - 16,
    y: workArea.y + 16,
  };
}

export function configureOverlayWindow(devUrl: string | undefined): void {
  devUrlCached = devUrl;
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlay;
}

export function createOverlayWindow(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) {
    return overlay;
  }

  const settings = getSettings();
  const pos = settings.panelPosition ?? defaultPosition();

  overlay = new BrowserWindow({
    width: DEFAULT_W,
    height: DEFAULT_H,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    type: "panel",
    vibrancy: "under-window",
    visualEffectState: "active",
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  overlay.setAlwaysOnTop(true, "floating");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep the overlay out of screen-shares and recordings: it's visible locally
  // but excluded from captured/shared output, so private goal/checklist/nudges
  // never leak to the people on the call.
  overlay.setContentProtection(true);

  if (devUrlCached) {
    overlay.loadURL(`${devUrlCached}/overlay/index.html`);
  } else {
    overlay.loadFile(
      path.join(__dirname, "../../renderer/overlay/index.html"),
    );
  }

  overlay.on("move", () => {
    if (!overlay || overlay.isDestroyed()) return;
    const [x, y] = overlay.getPosition();
    setPanelPosition({ x, y });
  });

  overlay.on("closed", () => {
    overlay = null;
  });

  return overlay;
}

export function showOverlay(): void {
  if (!overlay || overlay.isDestroyed()) {
    createOverlayWindow();
  }
  overlay?.showInactive();
}

export function hideOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.hide();
}
