import { BrowserWindow } from "electron";
import path from "node:path";

// Scaffold only — Block F fills this in.

let onboardingWin: BrowserWindow | null = null;
let devUrlCached: string | undefined;

export function configureOnboardingWindow(devUrl: string | undefined): void {
  devUrlCached = devUrl;
}

export function openOnboardingWindow(): BrowserWindow {
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    onboardingWin.show();
    onboardingWin.focus();
    return onboardingWin;
  }

  onboardingWin = new BrowserWindow({
    width: 420,
    height: 500,
    title: "Welcome to Ruby",
    show: false,
    backgroundColor: "#ffffff",
    // Match the main window's frameless warm chrome (see main-window.ts).
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 16, y: 14 },
    minimizable: false,
    maximizable: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (devUrlCached) {
    onboardingWin.loadURL(`${devUrlCached}/onboarding/index.html`);
  } else {
    onboardingWin.loadFile(path.join(__dirname, "../../renderer/onboarding/index.html"));
  }

  // Window is shown by the first onboarding:set-height IPC call so it
  // appears at the correct size immediately rather than flashing at the
  // initial placeholder height.
  onboardingWin.on("closed", () => {
    onboardingWin = null;
  });

  return onboardingWin;
}

export function closeOnboardingWindow(): void {
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    try {
      onboardingWin.close();
    } catch {}
  }
  onboardingWin = null;
}

export function getOnboardingWindow(): BrowserWindow | null {
  return onboardingWin;
}
