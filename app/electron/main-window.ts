import { BrowserWindow } from "electron";
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
    mainWin.show();
    mainWin.focus();
    mainWin.webContents.send("main:tab-changed", { tab: target });
    updateSettings({ lastTab: target });
    return mainWin;
  }

  mainWin = new BrowserWindow({
    width: 900,
    height: 600,
    title: "Prompty",
    show: false,
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
    mainWin?.show();
    mainWin?.webContents.send("main:tab-changed", { tab: target });
  });
  mainWin.on("closed", () => {
    mainWin = null;
  });

  updateSettings({ lastTab: target });
  return mainWin;
}

export function closeMainWindow(): void {
  if (mainWin && !mainWin.isDestroyed()) {
    try {
      mainWin.close();
    } catch {}
  }
  mainWin = null;
}
