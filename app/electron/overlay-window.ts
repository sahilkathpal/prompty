import { app, BrowserWindow, screen } from "electron";
import path from "node:path";
import { getSettings, setPanelPosition, setPanelSize } from "./settings-store";

// The gem is a small floating anchor, not a panel. Its width is fixed and
// modest — wide enough that one bloomed note line and the scrollback history
// read comfortably, narrow enough that at rest it's just the gem in the
// top-right corner. Height is driven entirely by the renderer via
// `overlay:set-height` as the gem moves between its three states:
//   gem-only → gem + bloomed note → gem + expanded history.
const FIXED_W = 340;
// Just the gem + its padding. The renderer snaps the window to this when at
// rest (idle / faded), and grows it for the bloom and the history list.
const GEM_ONLY_H = 56;
// Headroom for the expanded scrollback; the renderer clamps the actual height
// to its measured content, so this is only the ceiling.
const MAX_H = 520;

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
  // Width is fixed for the gem; only the position is restored. (A persisted
  // panelSize from the old roomy overlay would otherwise force a huge gem.)
  const pos = settings.panelPosition ?? defaultPosition(FIXED_W);

  overlay = new BrowserWindow({
    width: FIXED_W,
    height: GEM_ONLY_H,
    x: pos.x,
    y: pos.y,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    type: "panel",
    // No macOS vibrancy: the gem is mostly empty transparent space at rest, and
    // vibrancy would paint a frosted slab over the whole window. The gem's own
    // glass comes from CSS on the small bloom/history surface instead.
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
  // Keep the gem out of screen-shares and recordings: it's visible locally but
  // excluded from captured/shared output, so private notes never leak onto a
  // shared screen (RUBY_MVP decision #15).
  overlay.setContentProtection(true);

  // The gem is a `type: "panel"` NSPanel — a non-activating accessory window.
  // On macOS, once it exists and no ordinary window is showing (the resting
  // menubar state), the app gets demoted to an "accessory" (UIElement) app and
  // drops out of the Dock entirely. That makes `app.dock.setIcon()` a no-op,
  // since there's no tile to put an icon on. Re-assert "regular" activation so
  // the Dock tile we want (see main.ts) actually appears.
  app.dock?.show();

  // The window is a transparent rectangle far larger than the visible gem, so by
  // default it must NOT swallow mouse events — clicks pass through the empty area
  // to whatever's behind it. The renderer re-enables capture (via
  // setOverlayMouseIgnore(false)) only while the cursor is over the gem / note /
  // panel. `forward: true` keeps move events flowing so the renderer can still
  // detect when the cursor enters an interactive surface.
  overlay.setIgnoreMouseEvents(true, { forward: true });

  // Test-only bloom-pacing overrides (the renderer can't read process.env),
  // passed as query params: PROMPTY_OVERLAY_{DWELL,HIDE,STALE}_MS → ?dwellMs=
  // &hideMs=&staleMs=. The gem's App.tsx reads these (readParam) to shrink the
  // dwell/hide/stale timings so e2e doesn't wait the full multi-second holds.
  const parts: string[] = [];
  if (process.env.PROMPTY_OVERLAY_DWELL_MS) {
    parts.push(`dwellMs=${encodeURIComponent(process.env.PROMPTY_OVERLAY_DWELL_MS)}`);
  }
  if (process.env.PROMPTY_OVERLAY_HIDE_MS) {
    parts.push(`hideMs=${encodeURIComponent(process.env.PROMPTY_OVERLAY_HIDE_MS)}`);
  }
  if (process.env.PROMPTY_OVERLAY_STALE_MS) {
    parts.push(`staleMs=${encodeURIComponent(process.env.PROMPTY_OVERLAY_STALE_MS)}`);
  }
  const search = parts.join("&");

  if (devUrlCached) {
    overlay.loadURL(
      `${devUrlCached}/overlay/index.html${search ? `?${search}` : ""}`,
    );
  } else {
    overlay.loadFile(
      path.join(__dirname, "../../renderer/overlay/index.html"),
      search ? { search } : undefined,
    );
  }

  overlay.on("move", () => {
    if (!overlay || overlay.isDestroyed()) return;
    const [x, y] = overlay.getPosition();
    setPanelPosition({ x, y });
  });

  // Width is fixed and the window isn't user-resizable, but persist any size
  // anyway (harmless) so a future change can restore it.
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

// Set the gem window's height to fit its current state. Width is never changed.
// The renderer measures its own content (gem-only, gem+bloom, or gem+history)
// and asks for that exact height; we clamp it to a sane min (the gem alone) and
// the work-area ceiling. Always "exact" — the gem snaps tightly to each state
// rather than only growing, so a dismissed bloom or collapsed history returns
// the window to the small resting footprint.
export function setOverlayHeight(targetHeight: number): void {
  if (!overlay || overlay.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const maxH = Math.min(MAX_H, Math.max(GEM_ONLY_H, workArea.height - 32));
  const clamped = Math.round(Math.min(maxH, Math.max(GEM_ONLY_H, targetHeight)));
  const [width, height] = overlay.getSize();
  if (clamped !== height) overlay.setSize(width, clamped, false);
}

// Toggle whether the overlay swallows mouse events. Driven by the renderer:
// ignore (click-through) over empty space, capture over the gem/note/panel.
// Keep `forward: true` while ignoring so move events still reach the renderer.
export function setOverlayMouseIgnore(ignore: boolean): void {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined);
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
