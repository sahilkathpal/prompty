import { BrowserWindow, screen } from "electron";
import path from "node:path";
import { getOverlayWindow } from "./overlay-window";

const W = 720;
const H = 54;
const TOP_OFFSET = 32;

let win: BrowserWindow | null = null;
let devUrlCached: string | undefined;

export function configureTeleprompterWindow(devUrl: string | undefined): void {
  devUrlCached = devUrl;
}

export function getTeleprompterWindow(): BrowserWindow | null {
  return win;
}

// Pin the heads-up bar to the same display as the overlay panel, so the two
// surfaces always travel together and placement is deterministic (to move the
// bar to another screen, move the overlay there). Falls back to the display
// under the cursor if the overlay isn't open yet.
function teleprompterDisplay(): Electron.Display {
  const overlay = getOverlayWindow();
  if (overlay && !overlay.isDestroyed()) {
    return screen.getDisplayMatching(overlay.getBounds());
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function topCenterPosition(): { x: number; y: number } {
  const { workArea } = teleprompterDisplay();
  return {
    x: workArea.x + Math.round((workArea.width - W) / 2),
    y: workArea.y + TOP_OFFSET,
  };
}

export function createTeleprompterWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;

  const pos = topCenterPosition();

  win = new BrowserWindow({
    width: W,
    height: H,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    type: "panel",
    roundedCorners: true,
    // NOTE: do NOT use macOS `vibrancy` here. The teleprompter is invisible
    // when idle (its root sits at opacity 0 with no nudge), but vibrancy makes
    // the OS paint the window's frosted material *always* — leaving a blank
    // light bar stuck on screen. The dark "glass" look comes from the CSS
    // translucent background instead; the window stays fully transparent.
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Excluded from screen-shares/recordings (visible locally only) so nudges
  // don't leak onto a shared screen.
  win.setContentProtection(true);

  // Test-only timing overrides (renderer can't read process.env), passed as
  // query params: PROMPTY_TELEPROMPTER_{DWELL,HIDE,STALE}_MS.
  const parts: string[] = [];
  if (process.env.PROMPTY_TELEPROMPTER_DWELL_MS) {
    parts.push(`dwellMs=${encodeURIComponent(process.env.PROMPTY_TELEPROMPTER_DWELL_MS)}`);
  }
  if (process.env.PROMPTY_TELEPROMPTER_HIDE_MS) {
    parts.push(`hideMs=${encodeURIComponent(process.env.PROMPTY_TELEPROMPTER_HIDE_MS)}`);
  }
  if (process.env.PROMPTY_TELEPROMPTER_STALE_MS) {
    parts.push(`staleMs=${encodeURIComponent(process.env.PROMPTY_TELEPROMPTER_STALE_MS)}`);
  }
  const search = parts.join("&");

  if (devUrlCached) {
    win.loadURL(`${devUrlCached}/teleprompter/index.html${search ? `?${search}` : ""}`);
  } else {
    win.loadFile(
      path.join(__dirname, "../../renderer/teleprompter/index.html"),
      search ? { search } : undefined,
    );
  }

  win.on("closed", () => {
    win = null;
  });

  return win;
}

export function showTeleprompter(): void {
  if (!win || win.isDestroyed()) createTeleprompterWindow();
  const pos = topCenterPosition();
  win?.setPosition(pos.x, pos.y);
  win?.showInactive();
}

export function hideTeleprompter(): void {
  if (win && !win.isDestroyed()) win.hide();
}
