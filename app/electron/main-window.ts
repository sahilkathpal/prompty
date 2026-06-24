import { app, BrowserWindow } from "electron";
import path from "node:path";
import { getSettings, updateSettings } from "./settings-store";

let mainWin: BrowserWindow | null = null;
let devUrlCached: string | undefined;

export type MainTab = "prep" | "in-call" | "past-calls" | "settings";

export function configureMainWindow(devUrl: string | undefined): void {
  devUrlCached = devUrl;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWin;
}

export function openMainWindow(tab?: MainTab): BrowserWindow {
  const target: MainTab =
    tab ?? (getSettings().lastTab as MainTab | undefined) ?? "prep";

  if (mainWin && !mainWin.isDestroyed()) {
    raiseToFront(mainWin);
    mainWin.webContents.send("main:tab-changed", { tab: target });
    updateSettings({ lastTab: target });
    return mainWin;
  }

  mainWin = new BrowserWindow({
    width: 900,
    height: 600,
    title: "Ruby",
    show: false,
    // Cream surface painted before the renderer mounts — matches the warm
    // theme so there's no dark flash / side bars before/around the content.
    backgroundColor: "#faf7e9",
    // Merge the traffic lights into our own dark top bar (see .mw-topbar).
    // Pin their position so it's deterministic across macOS versions; the
    // .mw-topbar left padding is sized to clear this group. y centers them in
    // the 52px-tall bar.
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 18 },
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (devUrlCached) {
    mainWin.loadURL(`${devUrlCached}/main-window/index.html`);
    if (process.env.PROMPTY_E2E !== "1") {
      mainWin.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    mainWin.loadFile(
      path.join(__dirname, "../../renderer/main-window/index.html"),
    );
  }

  mainWin.once("ready-to-show", () => {
    raiseToFront(mainWin);
    mainWin?.webContents.send("main:tab-changed", { tab: target });
  });
  mainWin.on("closed", () => {
    mainWin = null;
  });

  updateSettings({ lastTab: target });
  return mainWin;
}

// Bring the window above every other app's windows, not just our own. On macOS
// show()/focus() alone often leaves the window buried behind whatever the user
// was last in, so we also pull the whole app forward (steal: true) and briefly
// pin the window on top to win the z-order race, then release it so it behaves
// like a normal window afterwards.
function raiseToFront(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
  win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  win.moveTop();
  win.setAlwaysOnTop(false);
}

export function closeMainWindow(): void {
  if (mainWin && !mainWin.isDestroyed()) {
    try {
      mainWin.close();
    } catch {}
  }
  mainWin = null;
}
