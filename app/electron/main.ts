import { app, crashReporter, dialog, globalShortcut, nativeImage, Notification, session } from "electron";
import path from "node:path";
import {
  createOverlayWindow,
  configureOverlayWindow,
  getOverlayWindow,
} from "./overlay-window";
import { configureMainWindow, openMainWindow } from "./main-window";
import { capture as analyticsCapture, identifyUser, captureException, shutdownAnalytics } from "./analytics";
import { configureOnboardingWindow, openOnboardingWindow } from "./onboarding-window";
import { createTray, rebuildMenu } from "./tray";
import { initUpdater, stopUpdater } from "./updater";
import {
  getActiveSession,
  fireOnboardingNudge,
  isOnboardingHotkeyArmed,
  registerIpcHandlers,
  requestNudgeFromHotkey,
  shutdownIpc,
} from "./ipc-handlers";
import { recoverOrphanedJournals } from "../src/main-process/journal";
import { fetchRemoteConfig } from "../src/main-process/remote-config";
import { getSettings, updateSettings } from "./settings-store";
import { loadEnv } from "./load-env";

// Load the gitignored `.env` (DEEPGRAM_API_KEY, etc.) before anything reads it.
loadEnv();

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const E2E_MODE = process.env.PROMPTY_E2E === "1";

// Parent-death watchdog (E2E only). An Electron app launched as a child of the
// Playwright runner does NOT die when that parent dies: macOS has no
// PR_SET_PDEATHSIG, so an interrupted run (a killed worker, a closed terminal,
// an aborted `verify`) skips the spec's `finally { app.close() }` and orphans
// the app — the OS re-parents it to launchd (ppid 1) and it lingers forever,
// leaving a stray Dock icon that `killall Dock` can't clear (the process is
// real). Watch for the re-parent and exit the moment it happens. Gated to E2E
// so the packaged tray app — whose real parent is already launchd — never
// self-quits; there `process.ppid` starts at 1 and the guard below no-ops.
if (E2E_MODE && process.ppid > 1) {
  const parentPid = process.ppid;
  const watchdog = setInterval(() => {
    if (process.ppid !== parentPid) process.exit(0);
  }, 1000);
  watchdog.unref(); // never keep the app alive just for the watchdog
}

// When Ruby is launched from Finder (or the dev wrapper exits), the stdout/
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

// Global JS-exception capture (§3.1). Without these, an uncaught throw or a
// rejected promise in the main process would crash it (killing any in-progress
// call) or vanish into console noise. Report each, then — consistent with the
// EPIPE guard above — keep the app alive rather than let a stray throw end a
// call. The try/catch guards the reporter (e.g. app not ready yet).
process.on("uncaughtException", (err) => {
  console.error("[main] uncaughtException:", err?.message);
  try {
    captureException(err, { component: "main", fingerprint: `main:uncaught:${err?.name ?? "Error"}` });
  } catch {}
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error("[main] unhandledRejection:", err.message);
  try {
    captureException(err, { component: "main", fingerprint: `main:unhandled:${err.name}` });
  } catch {}
});

// Native/process crashes are the one class PostHog's JS exception capture can't
// see (§3.3): a renderer *process* dying (GPU/OOM), an Electron child process
// (GPU/utility) crashing, or a hard native fault. crashReporter.start writes a
// local minidump for each (uploadToServer:false — no backend yet, but gives
// crash frequency/reason now and an on-ramp later). The render/child-process
// handlers turn each into a content-free PostHog exception so we see them in the
// same issue list as JS errors. Must start before app is ready to catch early crashes.
crashReporter.start({ uploadToServer: false });

app.on("render-process-gone", (_event, webContents, details) => {
  // A clean exit isn't a crash; only report abnormal terminations.
  if (details.reason === "clean-exit") return;
  console.error("[main] render-process-gone:", details.reason, details.exitCode);
  const e = new Error(`renderer process gone: ${details.reason}`);
  e.name = "RenderProcessGone";
  try {
    captureException(e, {
      component: "renderer-ui",
      fingerprint: `renderer-ui:process-gone:${details.reason}`,
      extra: { reason: details.reason, exit_code: details.exitCode },
    });
  } catch {}
});

app.on("child-process-gone", (_event, details) => {
  if (details.reason === "clean-exit") return;
  console.error("[main] child-process-gone:", details.type, details.reason, details.exitCode);
  const e = new Error(`child process gone: ${details.type} ${details.reason}`);
  e.name = "ChildProcessGone";
  try {
    captureException(e, {
      component: "main",
      fingerprint: `main:child-process-gone:${details.type}:${details.reason}`,
      extra: { process_type: details.type, reason: details.reason, exit_code: details.exitCode },
    });
  } catch {}
});

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

/**
 * Content-Security-Policy for the renderer (audit finding: no CSP). Applied as a
 * response header on the default session in PACKAGED builds only — the Vite dev
 * server needs inline scripts + an HMR websocket that a strict policy would
 * break, and dev loads from VITE_DEV_SERVER_URL anyway. style-src allows
 * 'unsafe-inline' because the UI uses React inline styles; scripts are restricted
 * to our own bundle. The renderer reaches the backend over IPC (not governed by
 * CSP), so connect-src can stay tight.
 */
function applyContentSecurityPolicy(): void {
  if (!app.isPackaged) return;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

app.on("ready", () => {
  applyContentSecurityPolicy();

  // Dock icon. Packaged builds get this from build/icon.icns automatically;
  // in dev the running binary is Electron's, so set it explicitly from the same
  // generated art (build/ isn't bundled, so this path only resolves in dev).
  if (!app.isPackaged && app.dock) {
    try {
      const devIcon = nativeImage.createFromPath(
        path.join(__dirname, "../../../build/icon.png"),
      );
      if (!devIcon.isEmpty()) app.dock.setIcon(devIcon);
    } catch {
      // Non-fatal: dev dock icon is cosmetic.
    }
  }

  configureMainWindow(DEV_URL);
  configureOverlayWindow(DEV_URL);
  configureOnboardingWindow(DEV_URL);

  // Pull dynamic link config (founders / how-it-works) from the relay so those
  // URLs can change without a rebuild. Fire-and-forget — UI uses fallbacks until
  // it lands, and falls back permanently if the relay is unreachable.
  void fetchRemoteConfig();

  registerIpcHandlers({
    getOverlayWindow,
    onOnboardingComplete: () => {
      startTrayAndOverlay();
      // Drop straight into Home — the onboarding card promised "Take me to Ruby".
      // Without this the onboarding window just closes to an empty desktop and the
      // user has to find "Open main window" in the tray.
      openMainWindow();
    },
    ensureHotkeyRegistered,
  });

  // Salvage any call whose process crashed before end() wrote its log, and
  // count each one — a mid-call crash/force-quit emits no call_ended, so these
  // would otherwise vanish from the denominator (survivorship bias).
  void recoverOrphanedJournals()
    .then((recovered) => {
      for (const r of recovered) {
        analyticsCapture("call_recovered", { had_transcript: r.hadTranscript, duration_s: r.durationS });
      }
    })
    .catch((e) => {
      console.error("[main] journal recovery failed:", (e as Error).message);
    });

  const settings = getSettings();

  // Re-identify an already-signed-in user on every launch — sign-in only runs
  // once, so without this returning users would stay "anonymous" in PostHog even
  // though we capture against their id. identify is what flips is_identified.
  if (settings.signedIn && settings.signedInUserId) {
    identifyUser(settings.signedInUserId, {
      signed_in: true,
      ...(settings.signedInEmail ? { email: settings.signedInEmail } : {}),
    });
  }
  analyticsCapture("app_launched", { onboarded: settings.onboardingCompleted });

  // The menu-bar tray exists in every state, including onboarding — the app is
  // already live then (global hotkey registered, gem overlay shown), so it
  // should have a menu-bar home and a Quit affordance. Session-dependent items
  // stay gated on getActiveSession(); "Open main window" stays gated on
  // onboarding completion (see rebuildMenu).
  if (!trayCreated) {
    createTray();
    trayCreated = true;
  }

  // Over-the-air auto-update. A hard no-op unless this is a packaged build and
  // not E2E (see updater.ts), so dev/tests never reach the feed. When a download
  // completes, rebuild the tray so the "Restart to update" item appears.
  initUpdater({ onUpdateDownloaded: () => rebuildMenu() });

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
      // Identity-linking step of a fresh Google sign-in, minus the real OAuth
      // (unavailable headless). Lets specs assert the alias+identify sequence.
      signInIdentity: (userId: string) => {
        const { aliasAndIdentify } = require("./analytics");
        return aliasAndIdentify(userId, { signed_in: true });
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
      getAnalyticsEvents: () => {
        const { getRecentEvents } = require("./analytics");
        return getRecentEvents();
      },
      getAnalyticsErrors: () => {
        const { getRecentErrors } = require("./analytics");
        return getRecentErrors();
      },
      // Drive capture() directly (bypassing the renderer allowlist) so a spec
      // can feed the scrubber crafted property values.
      captureEvent: (arg: { event: string; properties?: Record<string, unknown> }) => {
        const { capture } = require("./analytics");
        return capture(arg.event, arg.properties ?? {});
      },
      // Drive the captureException wrapper with a real Error.
      captureError: (arg: { message: string; ctx: Record<string, unknown> }) => {
        const { captureException } = require("./analytics");
        return captureException(new Error(arg.message), arg.ctx);
      },
      setAnalyticsOptOut: (v: boolean) => {
        const { updateSettings } = require("./settings-store");
        updateSettings({ analyticsOptOut: v });
      },
      // Throw asynchronously so it surfaces as a real process uncaughtException
      // (exercising the global handler), not a caught evaluate() rejection.
      forceUncaught: (msg: string) => {
        setImmediate(() => {
          throw new Error(msg);
        });
      },
      forceDeepgramError: (reason?: string) => {
        const { e2eForceTransportError } = require("./ipc-handlers");
        return e2eForceTransportError(reason);
      },
      simulateThemSilent: () => {
        const { e2eSimulateThemSilent } = require("./ipc-handlers");
        return e2eSimulateThemSilent();
      },
      simulateDeepgramStatus: (s: "reconnecting" | "open" | "error") => {
        const { e2eSimulateDeepgramStatus } = require("./ipc-handlers");
        return e2eSimulateDeepgramStatus(s);
      },
      // Hard-crash a live renderer process to exercise the render-process-gone
      // capture path (the plan's induced-renderer-crash check).
      forceRenderCrash: () => {
        const { BrowserWindow } = require("electron");
        const win = BrowserWindow.getAllWindows().find(
          (w: Electron.BrowserWindow) => !w.isDestroyed() && !w.webContents.isDestroyed(),
        );
        win?.webContents.forcefullyCrashRenderer();
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
    // Open the main window on launch. Previously an onboarded user got only the
    // tray + gem overlay at startup and no visible window; bring up Home directly.
    openMainWindow();
    maybePromptLoginItem();
  }
});

let quitting = false;

// On an orderly quit (Cmd-Q, tray Quit, window close), end any live session
// first so it writes a clean consolidated log (with summary) rather than
// leaning on next-launch journal recovery, then flush queued analytics so the
// last events (call_ended, the final action) aren't dropped. Both are async, so
// we defer the quit until they resolve. A true crash never runs this — that's
// what the journal is for, and analytics flush is best-effort by design.
app.on("before-quit", (e) => {
  if (quitting) return; // our own app.quit() below — let this pass through
  e.preventDefault();
  quitting = true;
  const session = getActiveSession();
  // background:false — wait for the summary pass inline so quitting doesn't
  // exit before the consolidated log (with summary) is written.
  const endStep = session
    ? session
        .end("user", { background: false })
        .catch((err) =>
          console.error("[main] end session on quit failed:", (err as Error).message),
        )
    : Promise.resolve();
  void endStep
    .then(() => shutdownAnalytics())
    .catch(() => {})
    .finally(() => app.quit());
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  stopUpdater();
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
