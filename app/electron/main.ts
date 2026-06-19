import { app, dialog, globalShortcut, Notification } from "electron";
import {
  createOverlayWindow,
  configureOverlayWindow,
  getOverlayWindow,
} from "./overlay-window";
import { configureMainWindow, openMainWindow } from "./main-window";
import { configureOnboardingWindow, openOnboardingWindow } from "./onboarding-window";
import { createTray, rebuildMenu } from "./tray";
import {
  getActiveSession,
  fireOnboardingNudge,
  isOnboardingHotkeyArmed,
  registerIpcHandlers,
  requestNudgeFromHotkey,
  shutdownIpc,
} from "./ipc-handlers";
import { recoverOrphanedJournals } from "../src/main-process/journal";
import { getSettings, updateSettings } from "./settings-store";
import { loadEnv } from "./load-env";

// Load the gitignored `.env` (DEEPGRAM_API_KEY, etc.) before anything reads it.
loadEnv();

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const E2E_MODE = process.env.PROMPTY_E2E === "1";

// When Prompty is launched from Finder (or the dev wrapper exits), the stdout/
// stderr pipe can close while the app keeps running. The next console.log then
// throws EPIPE — and because it surfaces as an uncaught exception, it crashes
// the whole main process. The in-call audio path logs frequently, so this fires
// reliably mid-call. Swallow EPIPE on the std streams so a dead pipe degrades to
// "no logs" instead of a crash.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") return;
    // Re-throw anything unexpected on the next tick so it isn't silently lost.
    process.nextTick(() => {
      throw err;
    });
  });
}

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
// `activate` handler below; the floating overlay (the gem) still
// appears over fullscreen apps because it sets visibleOnFullScreen.

let trayCreated = false;

/**
 * Register the global hotkey once. Idempotent: if it's already registered (e.g.
 * armed early for the onboarding step), this is a no-op that reports success.
 * The press callback branches — during the onboarding hotkey step (armed, no
 * live session) it blooms a sample nudge; otherwise it asks the active session's
 * agent for a real one. Returns whether the combo is ours and whether it failed
 * because another app already owns it.
 */
function ensureHotkeyRegistered(): { registered: boolean; conflict: boolean } {
  const hotkey = getSettings().hotkey || "Alt+Shift+Space";
  if (globalShortcut.isRegistered(hotkey)) return { registered: true, conflict: false };
  const ok = globalShortcut.register(hotkey, () => {
    if (isOnboardingHotkeyArmed() && !getActiveSession()) {
      // No live call during onboarding — bloom a canned sample nudge so the
      // user experiences the real surface. Also tells the card it fired.
      fireOnboardingNudge();
      return;
    }
    // requestNudgeFromHotkey → triggerNudge broadcasts nudge:requested and
    // asks the active session's agent for a nudge.
    requestNudgeFromHotkey();
  });
  if (!ok) {
    console.warn(`[main] failed to register global hotkey ${hotkey}`);
    return { registered: false, conflict: true };
  }
  return { registered: true, conflict: false };
}

function startTrayAndOverlay(): void {
  // Create overlay (the gem) hidden — it only displays when showOverlay() is called.
  createOverlayWindow();
  if (!trayCreated) {
    createTray();
    trayCreated = true;
  }
  // Refresh the menu so onboarding-gated items (e.g. "Open main window") pick up
  // the now-completed state when this runs at onboarding:complete.
  rebuildMenu();
  ensureHotkeyRegistered();
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
      title: "Launch Ruby at login?",
      message: "Launch Ruby at login?",
      detail:
        "Ruby can start automatically and stay in your menu bar so it's ready when calls begin.",
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
  configureOnboardingWindow(DEV_URL);

  registerIpcHandlers({
    getOverlayWindow,
    onOnboardingComplete: () => {
      startTrayAndOverlay();
    },
    ensureHotkeyRegistered,
  });

  // Salvage any call whose process crashed before end() wrote its log.
  void recoverOrphanedJournals().catch((e) => {
    console.error("[main] journal recovery failed:", (e as Error).message);
  });

  const settings = getSettings();

  // The menu-bar tray exists in every state, including onboarding — the app is
  // already live then (global hotkey registered, gem overlay shown), so it
  // should have a menu-bar home and a Quit affordance. Session-dependent items
  // stay gated on getActiveSession(); "Open main window" stays gated on
  // onboarding completion (see rebuildMenu).
  if (!trayCreated) {
    createTray();
    trayCreated = true;
  }

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
      authStatus: async () => {
        const { e2eAuthStatus } = require("./ipc-handlers");
        return e2eAuthStatus();
      },
      endSession: async () => {
        const { e2eEndSession } = require("./ipc-handlers");
        return e2eEndSession();
      },
      injectUtterance: (u: unknown) => {
        const { e2eInjectUtterance } = require("./ipc-handlers");
        return e2eInjectUtterance(u);
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
      broadcastSessionState: (state: string) => {
        const { e2eBroadcastSessionState } = require("./ipc-handlers");
        return e2eBroadcastSessionState(state);
      },
    };
  } else if (!settings.onboardingCompleted) {
    openOnboardingWindow();
  } else {
    startTrayAndOverlay();
    maybePromptLoginItem();
  }
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
    // background:false — wait for the summary pass inline so quitting doesn't
    // exit before the consolidated log (with summary) is written.
    void session
      .end("user", { background: false })
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
