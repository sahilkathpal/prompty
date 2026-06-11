import { app, dialog, globalShortcut, Notification } from "electron";
import {
  createOverlayWindow,
  configureOverlayWindow,
  getOverlayWindow,
} from "./overlay-window";
import {
  createTeleprompterWindow,
  configureTeleprompterWindow,
  getTeleprompterWindow,
} from "./teleprompter-window";
import { configureMainWindow, openMainWindow } from "./main-window";
import { configureOnboardingWindow, openOnboardingWindow } from "./onboarding-window";
import { createTray, rebuildMenu } from "./tray";
import {
  getActiveSession,
  registerIpcHandlers,
  requestNudgeFromHotkey,
  shutdownIpc,
} from "./ipc-handlers";
import { recoverOrphanedJournals } from "../src/main-process/journal";
import { getSettings, updateSettings } from "./settings-store";
import { setupAutoUpdater } from "./auto-updater";

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const E2E_MODE = process.env.PROMPTY_E2E === "1";

// In E2E mode, log every Notification ever constructed to a global array so
// Playwright can read it via app.evaluate().
if (E2E_MODE) {
  const seen: { title: string; body: string }[] = [];
  (global as unknown as { __prompty_notifications: typeof seen }).__prompty_notifications = seen;
  const OriginalNotification = Notification as unknown as new (
    opts?: { title?: string; body?: string },
  ) => InstanceType<typeof Notification>;
  // Wrap the constructor — Electron exports Notification as a class.
  // We intercept by replacing the export reference where it's used. Easiest:
  // monkey-patch via Object.defineProperty on the electron module is messy;
  // instead, we replace via reading the env var in handlers. The simplest
  // working approach: wrap the global Notification reference by patching
  // its prototype's `show` method to push when called.
  const proto = OriginalNotification.prototype as unknown as {
    show: () => void;
    _origShow?: () => void;
  };
  if (!proto._origShow) {
    proto._origShow = proto.show;
    proto.show = function (this: InstanceType<typeof Notification>) {
      try {
        const self = this as unknown as { title?: string; body?: string };
        seen.push({ title: self.title ?? "", body: self.body ?? "" });
      } catch {}
      // Suppress real OS notifications in E2E.
    };
  }
}

// Show a Dock icon. Clicking it re-opens the main window via the
// `activate` handler below; the floating overlay/teleprompter still
// appear over fullscreen apps because they set visibleOnFullScreen.

let trayCreated = false;

function startTrayAndOverlay(): void {
  // Create overlay hidden — it only displays when showOverlay() is called.
  createOverlayWindow();
  // Create teleprompter hidden — shown when a session goes live.
  createTeleprompterWindow();
  if (!trayCreated) {
    createTray();
    trayCreated = true;
  }
  const hotkey = getSettings().hotkey || "Alt+Shift+Space";
  if (!globalShortcut.isRegistered(hotkey)) {
    const ok = globalShortcut.register(hotkey, () => {
      // requestNudgeFromHotkey → triggerNudge broadcasts nudge:requested and
      // asks the active session's agent for a nudge.
      requestNudgeFromHotkey();
    });
    if (!ok) {
      console.warn(`[main] failed to register global hotkey ${hotkey}`);
    }
  }
}

function maybePromptLoginItem(): void {
  const settings = getSettings();
  if (!settings.onboardingCompleted) return;
  if (settings.loginItemPrompted) return;
  if (E2E_MODE) return;
  setTimeout(() => {
    const result = dialog.showMessageBoxSync({
      type: "question",
      buttons: ["Yes", "No"],
      defaultId: 0,
      cancelId: 1,
      title: "Launch Prompty at login?",
      message: "Launch Prompty at login?",
      detail:
        "Prompty can start automatically and stay in your menu bar so it's ready when calls begin.",
    });
    if (result === 0) {
      try {
        app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
        updateSettings({ launchAtLogin: true, loginItemPrompted: true });
      } catch (e) {
        console.error("[main] setLoginItemSettings failed:", (e as Error).message);
        updateSettings({ loginItemPrompted: true });
      }
    } else {
      updateSettings({ loginItemPrompted: true });
    }
  }, 1500);
}

app.on("ready", () => {
  configureMainWindow(DEV_URL);
  configureOverlayWindow(DEV_URL);
  configureTeleprompterWindow(DEV_URL);
  configureOnboardingWindow(DEV_URL);

  registerIpcHandlers({
    getOverlayWindow,
    onOnboardingComplete: () => {
      startTrayAndOverlay();
    },
  });

  // Salvage any call whose process crashed before end() wrote its log.
  void recoverOrphanedJournals().catch((e) => {
    console.error("[main] journal recovery failed:", (e as Error).message);
  });

  const settings = getSettings();
  if (E2E_MODE) {
    // Predictable starting state for E2E: skip onboarding, just bring up tray + overlay (hidden).
    if (!settings.onboardingCompleted) {
      updateSettings({ onboardingCompleted: true });
    }
    startTrayAndOverlay();
    // Expose handles for Playwright's app.evaluate (CommonJS require isn't
    // available inside evaluate). Tests can reach these via (global as any).
    (global as unknown as { __prompty_e2e: unknown }).__prompty_e2e = {
      openMainWindow,
      showOverlay: () => {
        const { showOverlay } = require("./overlay-window");
        showOverlay();
      },
      hideOverlay: () => {
        const { hideOverlay } = require("./overlay-window");
        hideOverlay();
      },
      pollCalendarArm: async () => {
        const { getCalendarArm } = require("./ipc-handlers");
        const arm = getCalendarArm?.();
        if (arm) await arm.pollNow();
      },
      getE2ENotifications: () => {
        return (
          (global as unknown as { __prompty_notifications?: unknown[] })
            .__prompty_notifications ?? []
        );
      },
      startSession: async () => {
        const { e2eStartSession } = require("./ipc-handlers");
        return e2eStartSession();
      },
      endSession: async () => {
        const { e2eEndSession } = require("./ipc-handlers");
        return e2eEndSession();
      },
      injectUtterance: (u: unknown) => {
        const { e2eInjectUtterance } = require("./ipc-handlers");
        return e2eInjectUtterance(u);
      },
      openPrepWindow: (event?: unknown) => {
        // Legacy E2E helper: prep now lives in the main window's Prep tab.
        openMainWindow("prep");
        void event;
      },
      sendPrepMessage: async (text: string) => {
        const { e2eSendPrepMessage } = require("./ipc-handlers");
        return e2eSendPrepMessage(text);
      },
      getPrepState: () => {
        const { e2eGetPrepState } = require("./ipc-handlers");
        return e2eGetPrepState();
      },
      ensurePrepSession: async (event?: unknown) => {
        const { e2eEnsurePrepSession } = require("./ipc-handlers");
        return e2eEnsurePrepSession(event ?? null);
      },
      fireNotificationClick: async (eventId?: string) => {
        const { e2eFireNotificationClick } = require("./ipc-handlers");
        return e2eFireNotificationClick(eventId);
      },
      getPendingPrep: () => {
        const { e2eGetPendingPrep } = require("./ipc-handlers");
        return e2eGetPendingPrep();
      },
      getSettings: () => {
        const { getSettings } = require("./settings-store");
        return getSettings();
      },
      trayEndSession: async () => {
        // Same code path the tray "End session" item invokes.
        const { endActiveSession } = require("./ipc-handlers");
        return endActiveSession();
      },
      getStatusLog: () => {
        const { e2eGetStatusLog } = require("./ipc-handlers");
        return e2eGetStatusLog();
      },
      forceDeepgramError: (reason?: string) => {
        const { e2eForceTransportError } = require("./ipc-handlers");
        return e2eForceTransportError(reason);
      },
      emitNudge: (n: unknown) => {
        const { e2eEmitNudge } = require("./ipc-handlers");
        return e2eEmitNudge(n);
      },
    };
  } else if (!settings.onboardingCompleted) {
    openOnboardingWindow();
  } else {
    startTrayAndOverlay();
    maybePromptLoginItem();
  }

  setupAutoUpdater();
});

let endingSessionForQuit = false;

// On an orderly quit (Cmd-Q, tray Quit, window close), end any live session
// first so it writes a clean consolidated log (with summary) rather than
// leaning on next-launch journal recovery. end() is async, so we defer the
// quit until it resolves. A true crash never runs this — that's what the
// journal is for.
app.on("before-quit", (e) => {
  const session = getActiveSession();
  if (session && !endingSessionForQuit) {
    e.preventDefault();
    endingSessionForQuit = true;
    void session
      .end("user")
      .catch((err) =>
        console.error("[main] end session on quit failed:", (err as Error).message),
      )
      .finally(() => app.quit());
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  shutdownIpc();
});

app.on("window-all-closed", () => {
  // Menubar app: do not quit when windows are hidden.
});

app.on("activate", () => {
  // Reopening from dock isn't typical for a menubar app, but if it happens,
  // bring the main window up.
  openMainWindow();
});
