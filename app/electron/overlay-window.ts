import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { getSettings, setPanelPosition, setPanelSize } from "./settings-store";

// Roomier default so the goal + full checklist + nudges are glanceable without
// scrolling. The user can resize from any edge; the chosen size is persisted.
const DEFAULT_W = 320;
const DEFAULT_H = 560;
const MIN_W = 260;
const MIN_H = 360;
// Cap the width: past this a glanceable coaching panel just looks like a wide
// empty slab and the sticky-note lines get too long to scan. Height is left
// unbounded (it auto-fits content up to the work area).
const MAX_W = 520;

let overlay: BrowserWindow | null = null;
let devUrlCached: string | undefined;

function defaultPosition(width: number): { x: number; y: number } {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  return {
    x: workArea.x + workArea.width - width - 16,
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
  const size = settings.panelSize ?? { width: DEFAULT_W, height: DEFAULT_H };
  const pos = settings.panelPosition ?? defaultPosition(size.width);

  overlay = new BrowserWindow({
    width: Math.min(size.width, MAX_W),
    height: size.height,
    minWidth: MIN_W,
    minHeight: MIN_H,
    maxWidth: MAX_W,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: true,
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

  overlay.on("resize", () => {
    if (!overlay || overlay.isDestroyed()) return;
    const [width, height] = overlay.getSize();
    setPanelSize({ width, height });
  });

  overlay.on("closed", () => {
    overlay = null;
  });

  return overlay;
}

// Fit the overlay's height to its content. Width is never changed — it stays
// under manual control. "grow" only ever increases the height (so it reveals
// the sticky-note stack without shrinking a height the user dragged taller);
// "exact" sets it to the measured height (snapping closed the unused feed space
// when the heads-up bar is toggled on). Always clamped to the work area.
export function setOverlayHeight(targetHeight: number, mode: "grow" | "exact"): void {
  if (!overlay || overlay.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const maxH = Math.max(MIN_H, workArea.height - 32);
  const clamped = Math.round(Math.min(maxH, Math.max(MIN_H, targetHeight)));
  const [width, height] = overlay.getSize();
  const nextH = mode === "grow" ? Math.max(height, clamped) : clamped;
  if (nextH !== height) overlay.setSize(width, nextH, false);
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
