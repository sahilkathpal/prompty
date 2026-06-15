import { app, BrowserWindow, dialog, ipcMain, Notification, shell, systemPreferences } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findClaudeBinary } from "../src/main-process/claude-cli";
import { closeOnboardingWindow } from "./onboarding-window";
import type { MediaPermissionStatus, PermissionStatus } from "../src/shared/types";
import type {
  InvokeChannel,
  InvokeChannels,
  EventChannel,
  EventPayload,
} from "../src/shared/ipc";
import { getSettings, updateSettings } from "./settings-store";
import { openMainWindow } from "./main-window";
import {
  showOverlay,
  hideOverlay,
  setOverlayHeight,
  getOverlayWindow,
} from "./overlay-window";
import { rebuildMenu } from "./tray";
import { startSession, type SessionHandle, type SessionState } from "../src/main-process/coach-session";
import { deriveCallTitle } from "../src/main-process/call-log";
import { debugDir } from "../src/main-process/debug-logger";
import type {
  CallSetup,
  TranscriptUtterance,
  SessionStatusEvent,
} from "../src/main-process/types";

type Handler<C extends InvokeChannel> = (
  payload: InvokeChannels[C]["request"],
) => Promise<InvokeChannels[C]["response"]> | InvokeChannels[C]["response"];

function handle<C extends InvokeChannel>(channel: C, fn: Handler<C>): void {
  ipcMain.handle(channel, async (_event, payload) => fn(payload));
}

export function broadcast<C extends EventChannel>(
  channel: C,
  payload: EventPayload<C>,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export function sendTo<C extends EventChannel>(
  win: BrowserWindow | null,
  channel: C,
  payload: EventPayload<C>,
): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

export interface IpcDeps {
  getOverlayWindow: () => BrowserWindow | null;
  onOnboardingComplete?: () => void;
}

function micStatus(): MediaPermissionStatus {
  if (process.platform !== "darwin") return "granted";
  try {
    return systemPreferences.getMediaAccessStatus("microphone") as MediaPermissionStatus;
  } catch {
    return "unknown";
  }
}

function permissionStatus(): PermissionStatus {
  return {
    microphone: micStatus(),
    notifications: Notification.isSupported() ? "enabled" : "unknown",
  };
}

let activeSession: SessionHandle | null = null;
let activeSessionSetup: CallSetup | null = null;
// Buffer of session:status events for the active session — read by E2E.
let statusLog: SessionStatusEvent[] = [];
// Last pre-flight failure, so a just-opened main window can fetch it on mount.
let lastPreflightFailure:
  | { code: "mic" | "claude"; message: string; at: number }
  | null = null;
let lastBroadcastState: SessionState | "idle" = "idle";

// The single persisted playground direction. UI box ⇄ this file. It is the
// surviving free-text context input (RUBY_MVP §7.2): a call starts straight
// from this direction with no prep.
const playgroundDirectionFile = path.join(
  os.homedir(),
  ".prompty",
  "playground",
  "direction.md",
);

async function readPlaygroundDirection(): Promise<string> {
  try {
    return await fs.readFile(playgroundDirectionFile, "utf8");
  } catch {
    return "";
  }
}

// Build a CallSetup from the free-text direction (+ optional skill). No prep,
// no goal, no checklist — the direction is the whole brief (RUBY_MVP §3, §7.2).
function directionToSetup(direction: string, skill?: string): CallSetup {
  return {
    direction: direction.trim() || undefined,
    context: {},
    skill: skill || undefined,
  };
}

function broadcastSessionState(state: SessionState | "idle"): void {
  lastBroadcastState = state;
  broadcast("session:state-changed", {
    state,
    setup: activeSessionSetup,
  });
  // Legacy: also send the simpler call:status for existing listeners.
  const legacy =
    state === "live" || state === "starting"
      ? "live"
      : state === "ended" || state === "error"
        ? "ended"
        : "idle";
  broadcast("call:status", { status: legacy });
  try {
    rebuildMenu();
  } catch {}
}

type PreflightResult =
  | { ok: true }
  | { ok: false; code: "mic" | "claude"; message: string };

const PREFLIGHT_MESSAGES = {
  mic: "Ruby needs microphone access to hear the call.",
  claude: "Install Claude Code to enable AI coaching.",
} as const;

/**
 * Verify the hard requirements before opening an in-call overlay: mic
 * permission and the `claude` binary. (The Deepgram key is checked at session
 * start — a missing key fails loudly there.) On failure the caller surfaces an
 * actionable message instead of opening a dead overlay. Bypassed under E2E/mock
 * so existing start tests still run; a specific failure can be forced for tests
 * via PROMPTY_E2E_FORCE_PREFLIGHT.
 */
async function preflight(): Promise<PreflightResult> {
  const forced = process.env.PROMPTY_E2E_FORCE_PREFLIGHT as
    | "mic"
    | "claude"
    | undefined;
  if (forced === "mic" || forced === "claude") {
    return { ok: false, code: forced, message: PREFLIGHT_MESSAGES[forced] };
  }
  if (
    process.env.PROMPTY_E2E === "1" ||
    process.env.PROMPTY_MOCK_AUDIO === "1" ||
    process.env.PROMPTY_MOCK_DEEPGRAM === "1" ||
    process.env.PROMPTY_MOCK_AGENT === "1"
  ) {
    return { ok: true };
  }
  if (micStatus() !== "granted") {
    return { ok: false, code: "mic", message: PREFLIGHT_MESSAGES.mic };
  }
  if (!findClaudeBinary()) {
    return { ok: false, code: "claude", message: PREFLIGHT_MESSAGES.claude };
  }
  return { ok: true };
}

async function doStartSession(
  skill?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (activeSession) {
    return { ok: false, error: "session already active" };
  }
  const pf = await preflight();
  if (!pf.ok) {
    console.warn(`[ipc] preflight blocked start: ${pf.code}`);
    // Surface an actionable message in the main window instead of opening a
    // dead overlay. Record it first so a just-opened window can fetch it on
    // mount.
    lastPreflightFailure = { code: pf.code, message: pf.message, at: Date.now() };
    try {
      openMainWindow();
    } catch {}
    broadcast("preflight:failed", { code: pf.code, message: pf.message });
    return { ok: false, error: pf.code };
  }
  lastPreflightFailure = null;
  // The free-text direction (persisted to ~/.prompty/playground/direction.md by
  // the direction:save-current handler) is the whole brief. No prep dependency.
  const direction = await readPlaygroundDirection();
  const setup = directionToSetup(direction, skill);
  activeSessionSetup = setup;
  statusLog = [];

  try {
    const session = await startSession(setup, {
      debug: getSettings().debugMode,
      onUtterance: (u) => broadcast("transcript:utterance", u),
      onNudge: (n) => broadcast("nudge:received", n),
      onStatus: (s) => {
        statusLog.push(s);
        broadcast("session:status", s);
      },
      onStateChange: (s) => {
        broadcastSessionState(s);
        if (s === "ended" || s === "error") {
          activeSession = null;
          activeSessionSetup = null;
          try {
            hideOverlay();
          } catch {}
          broadcastSessionState("idle");
        }
      },
      onError: (e) => {
        console.error("[ipc] session error:", e.message);
      },
    });
    activeSession = session;
    // Show the gem overlay + broadcast setup.
    try {
      showOverlay();
    } catch (e) {
      console.error("[ipc] showOverlay failed:", (e as Error).message);
    }
    broadcast("session:setup", { setup });
    return { ok: true };
  } catch (e) {
    activeSession = null;
    activeSessionSetup = null;
    return { ok: false, error: (e as Error).message };
  }
}

async function doEndSession(): Promise<{ ok: boolean; error?: string }> {
  const s = activeSession;
  if (!s) {
    broadcastSessionState("idle");
    return { ok: true };
  }
  try {
    await s.end("user");
  } catch (e) {
    console.error("[ipc] session end error:", (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true };
}

export function registerIpcHandlers(deps: IpcDeps): void {
  handle("main:open-tab", (payload) => {
    openMainWindow(payload.tab);
  });

  handle("overlay:open", () => {
    showOverlay();
  });

  handle("overlay:close", () => {
    hideOverlay();
  });

  handle("overlay:set-height", (payload) => {
    setOverlayHeight(payload.height);
    return { ok: true };
  });

  handle("overlay:move-by", (payload) => {
    const win = getOverlayWindow();
    if (!win || win.isDestroyed()) return { ok: false };
    const [x, y] = win.getPosition();
    win.setPosition(Math.round(x + payload.dx), Math.round(y + payload.dy));
    return { ok: true };
  });

  handle("calls:list", async () => {
    const dir = process.env.PROMPTY_CALL_LOG_DIR ?? path.join(os.homedir(), ".prompty", "calls");
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((e) => e.isFile() && e.name.endsWith(".json"))
          .map(async (e) => {
            const full = path.join(dir, e.name);
            const stat = await fs.stat(full);
            let title = "";
            let startedAt: number | undefined;
            let endedAt: number | undefined;
            try {
              const obj = JSON.parse(await fs.readFile(full, "utf8")) as {
                title?: string;
                summary?: { title?: string };
                direction?: string;
                startedAt?: number;
                endedAt?: number;
              };
              title = deriveCallTitle(obj.title, obj.summary?.title, obj.direction);
              startedAt = obj.startedAt;
              endedAt = obj.endedAt;
            } catch {
              // Unreadable/corrupt log — list it with an empty title.
            }
            return { name: e.name, mtimeMs: stat.mtimeMs, title, startedAt, endedAt };
          }),
      );
      // Newest first, by when the call happened (fall back to file mtime).
      files.sort((a, b) => (b.startedAt ?? b.mtimeMs) - (a.startedAt ?? a.mtimeMs));
      return { files };
    } catch {
      return { files: [] };
    }
  });

  handle("calls:rename", async (payload) => {
    const dir = process.env.PROMPTY_CALL_LOG_DIR ?? path.join(os.homedir(), ".prompty", "calls");
    const full = path.join(dir, path.basename(payload.name));
    try {
      const obj = JSON.parse(await fs.readFile(full, "utf8")) as Record<string, unknown>;
      obj.title = payload.title.trim();
      await fs.writeFile(full, JSON.stringify(obj, null, 2));
      return { ok: true };
    } catch (e) {
      console.error("[ipc] calls:rename failed:", (e as Error).message);
      return { ok: false };
    }
  });

  handle("calls:read", async (payload) => {
    const dir = process.env.PROMPTY_CALL_LOG_DIR ?? path.join(os.homedir(), ".prompty", "calls");
    const safe = path.basename(payload.name);
    const full = path.join(dir, safe);
    try {
      const content = await fs.readFile(full, "utf8");
      return { content };
    } catch (e) {
      return { content: `Error reading ${safe}: ${(e as Error).message}` };
    }
  });

  handle("settings:get", () => getSettings());

  handle("settings:set", (payload) => {
    const next = updateSettings(payload);
    broadcast("settings:changed", next);
    // Debug mode takes effect immediately mid-session: open/close the capture
    // file on the active coach session right away.
    if (payload.debugMode !== undefined) {
      try {
        activeSession?.setDebug(next.debugMode);
      } catch (e) {
        console.error("[ipc] debug toggle failed:", (e as Error).message);
      }
    }
    return next;
  });

  handle("debug:reveal", async () => {
    const dir = debugDir();
    try {
      await fs.mkdir(dir, { recursive: true });
      // openPath focuses the directory itself (showItemInFolder would need an
      // existing file inside to highlight, which may not exist yet).
      await shell.openPath(dir);
      return { ok: true, path: dir };
    } catch (e) {
      console.error("[ipc] debug:reveal failed:", (e as Error).message);
      return { ok: false, path: dir };
    }
  });

  handle("call:start", async (payload) => {
    return doStartSession(payload?.skill);
  });

  handle("call:end", async () => {
    return doEndSession();
  });

  handle("direction:load-file", async () => {
    const res = await dialog.showOpenDialog({
      title: "Load direction from file",
      properties: ["openFile"],
      filters: [
        { name: "Markdown / text", extensions: ["md", "txt"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    const file = res.canceled ? undefined : res.filePaths[0];
    if (!file) return null;
    try {
      const content = await fs.readFile(file, "utf8");
      return { content, path: file };
    } catch (e) {
      console.error("[ipc] direction:load-file failed:", (e as Error).message);
      return null;
    }
  });

  handle("direction:load-current", async () => {
    return { content: await readPlaygroundDirection() };
  });
  handle("direction:save-current", async (payload) => {
    try {
      await fs.mkdir(path.dirname(playgroundDirectionFile), { recursive: true });
      await fs.writeFile(playgroundDirectionFile, payload?.content ?? "", "utf8");
      return { ok: true };
    } catch (e) {
      console.error("[ipc] direction:save-current failed:", (e as Error).message);
      return { ok: false };
    }
  });

  handle("nudge:request", (payload) => {
    return { ok: triggerNudge(payload?.source ?? "panel") };
  });

  handle("preflight:get", () => {
    if (lastPreflightFailure && Date.now() - lastPreflightFailure.at < 15_000) {
      return { code: lastPreflightFailure.code, message: lastPreflightFailure.message };
    }
    return null;
  });

  handle("debug:inject-utterance", (payload) => {
    if (!activeSession) {
      return { ok: false, error: "no active session" };
    }
    activeSession.injectUtterance({
      speaker: payload.speaker,
      text: payload.text,
      startMs: 0,
      endMs: 0,
      isFinal: payload.isFinal ?? true,
    });
    return { ok: true };
  });

  handle("session:state", () => {
    return {
      state: lastBroadcastState,
      setup: activeSessionSetup,
      nudges: activeSession?.getNudges() ?? [],
      transcript: activeSession?.getTranscript() ?? [],
    };
  });

  handle("quit", () => {
    app.quit();
  });

  // ---- Onboarding (Block F) ----
  handle("onboarding:check-claude", () => {
    const found = findClaudeBinary();
    return { found: !!found, path: found };
  });

  handle("onboarding:request-mic", async () => {
    console.log("[onboarding] request-mic invoked");
    if (process.platform !== "darwin") return { granted: true };
    const pre = systemPreferences.getMediaAccessStatus("microphone");
    console.log("[onboarding] pre-request mic status:", pre);
    try {
      const granted = await systemPreferences.askForMediaAccess("microphone");
      const post = systemPreferences.getMediaAccessStatus("microphone");
      console.log("[onboarding] askForMediaAccess returned:", granted, "post-status:", post);
      return { granted };
    } catch (e) {
      console.error("[onboarding] askForMediaAccess failed:", (e as Error).message);
      return { granted: false };
    }
  });

  handle("onboarding:permission-status", () => permissionStatus());

  handle("onboarding:fire-notification", () => {
    try {
      if (!Notification.isSupported()) {
        return { ok: false, error: "notifications not supported" };
      }
      const n = new Notification({
        title: "Ruby notifications enabled",
        body: "You'll see nudges and call summaries here.",
      });
      n.show();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle("onboarding:open-external", (payload) => {
    void shell.openExternal(payload.url);
  });

  handle("onboarding:complete", () => {
    updateSettings({ onboardingCompleted: true });
    closeOnboardingWindow();
    deps.onOnboardingComplete?.();
    return { ok: true };
  });

  // Reference deps to satisfy noUnusedParameters
  void deps;
}

export function shutdownIpc(): void {
  // Nothing to tear down now that the calendar-arm scheduler is gone.
}

/**
 * Shared on-demand nudge trigger. Announces the request to all windows and
 * asks the active session's agent for a nudge. Used by the global hotkey and
 * the overlay's "What should I ask?" button.
 */
export function triggerNudge(source: "hotkey" | "tray" | "panel"): boolean {
  broadcast("nudge:requested", { source });
  if (!activeSession) return false;
  try {
    activeSession.requestNudge();
    return true;
  } catch (e) {
    console.error(`[ipc] triggerNudge(${source}) failed:`, (e as Error).message);
    return false;
  }
}

export function requestNudgeFromHotkey(): void {
  triggerNudge("hotkey");
}

export function getActiveSession(): SessionHandle | null {
  return activeSession;
}

/** End the active session from outside the IPC layer (e.g. the tray menu). */
export function endActiveSession(): Promise<{ ok: boolean; error?: string }> {
  return doEndSession();
}

export function e2eStartSession(): Promise<{ ok: boolean; error?: string }> {
  return doStartSession();
}

export function e2eEndSession(): Promise<{ ok: boolean; error?: string }> {
  return doEndSession();
}

export function e2eInjectUtterance(u: TranscriptUtterance): boolean {
  if (!activeSession) return false;
  activeSession.injectUtterance(u);
  return true;
}

export function e2eGetStatusLog(): SessionStatusEvent[] {
  return [...statusLog];
}

export function e2eEmitNudge(n: unknown): boolean {
  broadcast("nudge:received", n as never);
  return true;
}

export function e2eForceTransportError(reason?: string): boolean {
  if (!activeSession) return false;
  activeSession.simulateTransportError(reason);
  return true;
}

// Push a synthetic session state to the renderers via the real broadcast path.
// Used by e2e to hold a window in a transient state (e.g. "ending") long enough
// to assert its UI — the mock end() flow flips through "ending" too fast to catch.
export function e2eBroadcastSessionState(state: SessionState | "idle"): boolean {
  broadcastSessionState(state);
  return true;
}
