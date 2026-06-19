import { app, BrowserWindow, ipcMain, Notification, shell, systemPreferences } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findClaudeBinary } from "../src/main-process/claude-cli";
import { closeOnboardingWindow, getOnboardingWindow } from "./onboarding-window";
import type { MediaPermissionStatus, Nudge, PermissionStatus } from "../src/shared/types";
import type {
  InvokeChannel,
  InvokeChannels,
  EventChannel,
  EventPayload,
} from "../src/shared/ipc";
import { getSettings, updateSettings } from "./settings-store";
import { openMainWindow, getMainWindow } from "./main-window";
import {
  showOverlay,
  hideOverlay,
  setOverlayHeight,
  setOverlayMouseIgnore,
  getOverlayWindow,
} from "./overlay-window";
import { rebuildMenu } from "./tray";
import { startSession, type SessionHandle, type SessionState } from "../src/main-process/coach-session";
import { deriveCallTitle } from "../src/main-process/call-log";
import {
  readMemory,
  addMemory,
  updateMemory,
  deleteMemory,
} from "../src/main-process/memory-store";
import { openPrepAgent, type PrepAgent } from "../src/main-process/prep-agent";
import {
  getSessionToken,
  getUserId,
  signInWithGoogleAndRelay,
  clearSessionCache,
} from "../src/main-process/relay-client";
import {
  getSession as getGoogleSession,
  signOut as googleSignOut,
} from "../src/main-process/google-auth";
import { listBundledSkills } from "../src/main-process/prompts/loader";
import type { PrepComponent } from "../src/main-process/types";
import { debugDir, debugEnabled } from "../src/main-process/debug-logger";
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
  // Register the global hotkey (idempotent). Lives in main where globalShortcut
  // is owned; called when the onboarding hotkey step arms.
  ensureHotkeyRegistered?: () => { registered: boolean; conflict: boolean };
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
// The current prep chat session (RUBY B2 phase 2b). At most one at a time.
let activePrep: PrepAgent | null = null;
// Components (goal/checklist) armed by the current/last prep, awaiting the next
// call start (RUBY B3). Persisted alongside directionDraft (Gap 2) so a brief
// prepped ahead of a call survives an app quit; folded onto the setup and then
// cleared at call:start. Initialised from disk; mutate only via
// setActivePrepComponents so the on-disk copy stays in sync.
let activePrepComponents: PrepComponent[] = getSettings().prepComponents ?? [];

function setActivePrepComponents(components: PrepComponent[]): void {
  activePrepComponents = components;
  updateSettings({ prepComponents: components });
}
// --- Onboarding hotkey step (no live call) ----------------------------------
// While the onboarding hotkey step is on screen we register the real global
// shortcut early and flip this on, so its press callback blooms a canned sample
// nudge (there's no session/agent yet) instead of the live path. Cleared at
// onboarding:complete; after that the same shortcut routes to the real agent.
let onboardingHotkeyArmed = false;
let onboardingNudgeIndex = 0;
const ONBOARDING_SAMPLE_NUDGES = [
  "What does a great outcome here look like for you?",
  "What's the biggest risk nobody's naming yet?",
  "What would have to be true for this to be a yes?",
  "What's changed since you two last spoke?",
];

// Buffer of session:status events for the active session — read by E2E.
let statusLog: SessionStatusEvent[] = [];
// Last pre-flight failure, so a just-opened main window can fetch it on mount.
let lastPreflightFailure:
  | { code: "mic" | "auth" | "claude"; message: string; at: number }
  | null = null;
let lastBroadcastState: SessionState | "idle" = "idle";

// Build a CallSetup from the free-text direction (+ optional skill). No prep,
// no goal, no checklist — the direction is the whole brief (RUBY_MVP §3, §7.2).
function directionToSetup(direction: string, skill?: string): CallSetup {
  return {
    direction: direction.trim() || undefined,
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
  | { ok: false; code: "mic" | "auth" | "claude"; message: string };

const PREFLIGHT_MESSAGES = {
  mic: "Ruby needs microphone access to hear the call.",
  auth: "Sign in with Google to enable transcription.",
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
/**
 * Whether the Deepgram-key requirement is satisfied: signed in with Google, or
 * bypassed for E2E/mock runs and the dev local-key path (no relay, no auth).
 * Shared by preflight and the onboarding-complete gate.
 */
async function authSatisfied(): Promise<boolean> {
  if (
    process.env.PROMPTY_E2E === "1" ||
    process.env.PROMPTY_MOCK_AUDIO === "1" ||
    process.env.PROMPTY_MOCK_DEEPGRAM === "1" ||
    process.env.PROMPTY_MOCK_AGENT === "1" ||
    process.env.DEEPGRAM_API_KEY?.trim()
  ) {
    return true;
  }
  return !!getGoogleSession() || !!(await getSessionToken());
}

async function preflight(): Promise<PreflightResult> {
  const forced = process.env.PROMPTY_E2E_FORCE_PREFLIGHT as
    | "mic"
    | "auth"
    | "claude"
    | undefined;
  if (forced === "mic" || forced === "auth" || forced === "claude") {
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
  // A relay-minted Deepgram key needs a signed-in Google session (bypassed by
  // the dev local-key path inside authSatisfied).
  if (!(await authSatisfied())) {
    return { ok: false, code: "auth", message: PREFLIGHT_MESSAGES.auth };
  }
  if (!findClaudeBinary()) {
    return { ok: false, code: "claude", message: PREFLIGHT_MESSAGES.claude };
  }
  return { ok: true };
}

async function doStartSession(
  opts: { skill?: string; direction?: string } = {},
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
  // The ephemeral per-call direction comes straight from the renderer at start
  // (RUBY B2 phase 2a) — nothing is read from disk. It is the whole brief.
  const setup = directionToSetup(opts.direction ?? "", opts.skill);
  // Fold in the components armed during prep (RUBY B3 phase 3b), then clear the
  // whole pending prep — direction + components are per-call and consumed by this
  // start, so they don't leak into the next call (Gap 2). Skill is sticky and is
  // intentionally left untouched. The prep:components reset lets any open window
  // drop its armed cards even when the call was started from the hotkey/tray.
  if (activePrepComponents.length > 0) {
    setup.components = activePrepComponents;
  }
  activePrepComponents = [];
  updateSettings({ directionDraft: "", prepComponents: [] });
  broadcast("prep:components", { components: [] });
  activeSessionSetup = setup;
  statusLog = [];

  try {
    const session = await startSession(setup, {
      debug: debugEnabled(),
      onUtterance: (u) => broadcast("transcript:utterance", u),
      onNudge: (n) => broadcast("nudge:received", n),
      onStatus: (s) => {
        statusLog.push(s);
        broadcast("session:status", s);
      },
      onSummaryReady: (logPath) => {
        // The background summary pass patched the saved log — tell any open
        // Past Calls view to re-read it.
        if (logPath) broadcast("calls:updated", { name: path.basename(logPath) });
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

  handle("overlay:set-mouse-ignore", (payload) => {
    setOverlayMouseIgnore(payload.ignore);
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
            let summaryPending = false;
            try {
              const obj = JSON.parse(await fs.readFile(full, "utf8")) as {
                title?: string;
                summary?: { title?: string };
                direction?: string;
                startedAt?: number;
                endedAt?: number;
                summaryPending?: boolean;
              };
              title = deriveCallTitle(obj.title, obj.summary?.title, obj.direction);
              startedAt = obj.startedAt;
              endedAt = obj.endedAt;
              summaryPending = obj.summaryPending === true;
            } catch {
              // Unreadable/corrupt log — list it with an empty title.
            }
            return { name: e.name, mtimeMs: stat.mtimeMs, title, startedAt, endedAt, summaryPending };
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

  handle("prep:start", async (payload) => {
    if (activePrep) {
      await activePrep.close().catch(() => {});
      activePrep = null;
    }
    // The pending prep (direction + components) is ONE artifact that survives until
    // a call consumes it or the user explicitly discards it — entering prep no
    // longer clears it. Carry the armed components into the new session so the
    // opening turn can acknowledge them (resume), and so they aren't dropped.
    const carried = activePrepComponents.map((c) => ({ ...c }));
    try {
      activePrep = await openPrepAgent(
        payload?.direction ?? "",
        {
          onAssistantDelta: (text) => broadcast("prep:assistant-delta", { text }),
          onAssistant: (text) => broadcast("prep:assistant", { text }),
          onDirection: (direction) => broadcast("prep:direction", { direction }),
          onComponents: (components) => {
            setActivePrepComponents(components);
            broadcast("prep:components", { components });
          },
          onError: (e) => broadcast("prep:error", { message: e.message }),
        },
        carried,
      );
      // Fire the opening turn (reflect the brief + ask flesh-out-or-go). Don't
      // block the handler on it — it streams in through the same broadcasts as any
      // turn, after the renderer has shown the seed as the first user bubble.
      broadcast("prep:thinking", { thinking: true });
      void activePrep
        .open()
        .catch((e) => broadcast("prep:error", { message: (e as Error).message }))
        .finally(() => broadcast("prep:thinking", { thinking: false }));
      return { ok: true };
    } catch (e) {
      console.error("[ipc] prep:start failed:", (e as Error).message);
      activePrep = null;
      return { ok: false };
    }
  });

  handle("prep:send", async (payload) => {
    if (!activePrep) return { ok: false };
    broadcast("prep:thinking", { thinking: true });
    try {
      await activePrep.send(payload.message);
      return { ok: true };
    } catch (e) {
      broadcast("prep:error", { message: (e as Error).message });
      return { ok: false };
    } finally {
      broadcast("prep:thinking", { thinking: false });
    }
  });

  handle("prep:end", async () => {
    if (activePrep) {
      await activePrep.close().catch(() => {});
      activePrep = null;
    }
    return { ok: true };
  });

  handle("main:set-prep-layout", (payload) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    const [w, h] = payload.wide ? [1180, 760] : [900, 600];
    try {
      const [x, y] = win.getPosition();
      const [curW] = win.getSize();
      // Grow/shrink around the window's horizontal centre so it expands evenly
      // instead of lurching off one edge.
      const nextX = Math.round(x - (w - curW) / 2);
      win.setBounds({ x: nextX, y, width: w, height: h }, true);
    } catch {
      win.setSize(w, h, true);
    }
  });

  handle("prep:set-components", (payload) => {
    // User edited the cards — the renderer is the source of truth for edits.
    setActivePrepComponents(payload.components);
    return { ok: true };
  });

  handle("memory:list", () => ({ items: readMemory() }));
  handle("memory:add", (payload) => ({
    item: addMemory(payload.text),
  }));
  handle("memory:update", (payload) => ({
    ok: updateMemory(payload.id, payload.text),
  }));
  handle("memory:delete", (payload) => ({ ok: deleteMemory(payload.id) }));

  handle("settings:get", () => getSettings());

  handle("settings:set", (payload) => {
    const next = updateSettings(payload);
    broadcast("settings:changed", next);
    return next;
  });

  handle("skills:list", () => ({ skills: listBundledSkills() }));

  handle("auth:google-sign-in", async () => {
    try {
      const session = await signInWithGoogleAndRelay();
      const next = updateSettings({
        signedIn: true,
        signedInUserId: session.userId,
        signedInEmail: session.email,
      });
      broadcast("settings:changed", next);
      broadcast("auth:state-changed", {
        signedIn: true,
        userId: session.userId,
        email: session.email,
      });
      return { ok: true, userId: session.userId, email: session.email };
    } catch (e) {
      const msg = (e as Error).message;
      console.error("[ipc] auth:google-sign-in failed:", msg);
      return { ok: false, error: msg };
    }
  });

  handle("auth:sign-out", async () => {
    try {
      googleSignOut();
      clearSessionCache();
      const next = updateSettings({
        signedIn: false,
        signedInUserId: null,
        signedInEmail: null,
      });
      broadcast("settings:changed", next);
      broadcast("auth:state-changed", { signedIn: false });
      return { ok: true };
    } catch (e) {
      console.error("[ipc] auth:sign-out failed:", (e as Error).message);
      return { ok: false };
    }
  });

  handle("auth:status", async () => {
    const g = getGoogleSession();
    if (g) {
      return { signedIn: true, userId: g.sub, email: g.email };
    }
    const tok = await getSessionToken();
    if (!tok) return { signedIn: false };
    const uid = (await getUserId()) ?? undefined;
    return { signedIn: true, userId: uid };
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
    return doStartSession({
      skill: payload?.skill,
      direction: payload?.direction,
    });
  });

  handle("call:end", async () => {
    return doEndSession();
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

  handle("onboarding:set-height", (payload) => {
    const win = getOnboardingWindow();
    if (!win || win.isDestroyed()) return;
    const { workArea } = require("electron").screen.getPrimaryDisplay();
    const maxH = Math.min(800, workArea.height - 32);
    const clamped = Math.round(Math.max(200, Math.min(maxH, payload.height)));
    const [w, h] = win.getSize();
    if (clamped !== h) win.setSize(w, clamped, true);
    // Show on first call so the window appears at the correct size
    if (!win.isVisible()) win.show();
  });

  let pendingRubyMessage: { text: string | null } | null = null;

  handle("onboarding:set-ruby-message", (payload) => {
    pendingRubyMessage = { text: payload.text };
    if (payload.text !== null) {
      showOverlay();
    }
    const overlayWin = getOverlayWindow();
    if (!overlayWin || overlayWin.isDestroyed()) return;
    if (overlayWin.webContents.isLoading()) {
      overlayWin.webContents.once("did-finish-load", () => {
        if (pendingRubyMessage !== null) {
          sendTo(getOverlayWindow(), "overlay:ruby-message", pendingRubyMessage);
        }
      });
    } else {
      sendTo(overlayWin, "overlay:ruby-message", { text: payload.text });
    }
  });

  handle("onboarding:arm-hotkey", () => {
    onboardingHotkeyArmed = true;
    onboardingNudgeIndex = 0;
    const res = deps.ensureHotkeyRegistered?.() ?? { registered: false, conflict: true };
    return { ok: true, registered: res.registered, conflict: res.conflict };
  });

  handle("onboarding:fire-nudge", () => {
    fireOnboardingNudge();
  });

  handle("onboarding:celebrate", async () => {
    const { BrowserWindow: BW, screen } = require("electron") as typeof import("electron");
    // Confetti particle = the bundled Ruby image. Resolve from resources when
    // packaged, else from source in dev. Confetti is pure eye-candy, so a
    // missing asset must never break the onboarding flow — bail out quietly.
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath;
    const imgPath =
      app.isPackaged && resourcesPath
        ? path.join(resourcesPath, "ruby.png")
        : path.join(app.getAppPath(), "src", "onboarding", "ruby.png");
    let imgSrc: string;
    try {
      const imgB64 = (await fs.readFile(imgPath)).toString("base64");
      imgSrc = `data:image/png;base64,${imgB64}`;
    } catch (e) {
      console.warn("[onboarding] confetti image not found, skipping:", (e as Error).message);
      return;
    }
    const { workArea } = screen.getPrimaryDisplay();

    // Get onboarding window center in screen coordinates
    const obWin = getOnboardingWindow();
    const [obX, obY] = obWin ? obWin.getPosition() : [workArea.x + workArea.width / 2, workArea.y + workArea.height / 2];
    const [obW, obH] = obWin ? obWin.getSize() : [420, 500];
    // Convert to canvas-relative coords (canvas covers workArea)
    const originX = obX - workArea.x + obW / 2;
    const originY = obY - workArea.y + obH / 2;

    // Three burst origins: center, left-of-center, right-of-center
    const origins = [
      { x: originX, y: originY },
      { x: originX - 80, y: originY + 40 },
      { x: originX + 80, y: originY + 40 },
    ];

    const html = `<!DOCTYPE html><html><body style="margin:0;background:transparent;overflow:hidden">
<canvas id="c" style="position:fixed;inset:0;display:block"></canvas>
<script>
const img = new Image();
img.src = ${JSON.stringify(imgSrc)};
img.onload = () => {
  const canvas = document.getElementById('c');
  canvas.width = ${workArea.width};
  canvas.height = ${workArea.height};
  const ctx = canvas.getContext('2d');
  const rand = (a, b) => a + Math.random() * (b - a);
  const origins = ${JSON.stringify(origins)};
  const particles = [];
  function burst(origin) {
    for (let i = 0; i < 45; i++) {
      particles.push({
        x: origin.x, y: origin.y,
        vx: rand(-7, 7), vy: rand(-10, 1),
        rotation: rand(0, Math.PI * 2),
        vr: rand(-0.07, 0.07),
        scale: rand(0.3, 0.75),
        alpha: 1,
        gravity: rand(0.06, 0.14),
      });
    }
  }
  burst(origins[0]);
  setTimeout(() => burst(origins[1]), 400);
  setTimeout(() => burst(origins[2]), 800);
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.99;
      p.rotation += p.vr;
      p.alpha -= 0.005;
      if (p.alpha <= 0) continue;
      alive = true;
      const w = img.width * p.scale, h = img.height * p.scale;
      ctx.save();
      ctx.globalAlpha = Math.min(1, p.alpha);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.drawImage(img, -w/2, -h/2, w, h);
      ctx.restore();
    }
    if (alive) requestAnimationFrame(animate);
  }
  animate();
};
</script></body></html>`;
    const win = new BW({
      x: workArea.x, y: workArea.y,
      width: workArea.width, height: workArea.height,
      transparent: true, frame: false, focusable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true);
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.showInactive();
    setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 6000);
  });

  handle("onboarding:complete", async () => {
    // Sign-in is the last onboarding step; don't let the window finish (and tear
    // itself down) until a session exists, so the first call isn't dead on a
    // missing Deepgram key. Bypassed for E2E/mock and the dev local-key path.
    if (!(await authSatisfied())) {
      return { ok: false };
    }
    pendingRubyMessage = null;
    // Hand the global hotkey back to the live nudge path.
    onboardingHotkeyArmed = false;
    updateSettings({ onboardingCompleted: true });
    sendTo(getOverlayWindow(), "overlay:ruby-message", { text: null });
    hideOverlay();
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

export function isOnboardingHotkeyArmed(): boolean {
  return onboardingHotkeyArmed;
}

/**
 * Bloom a canned sample nudge for the onboarding hotkey step and tell the
 * onboarding card it fired. Cycles ONBOARDING_SAMPLE_NUDGES on repeat presses
 * so the user sees that nudges vary. Used by the global hotkey callback only
 * while armed and with no live session.
 */
export function fireOnboardingNudge(): void {
  const text =
    ONBOARDING_SAMPLE_NUDGES[onboardingNudgeIndex % ONBOARDING_SAMPLE_NUDGES.length];
  onboardingNudgeIndex += 1;
  const nudge: Nudge = {
    id: `onboarding_${Date.now()}_${onboardingNudgeIndex}`,
    urgency: "medium",
    text,
    createdAt: Date.now(),
  };
  broadcast("nudge:received", nudge);
  broadcast("onboarding:hotkey-fired", { nudge });
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

// Read-only sign-in state for E2E, mirroring the auth:status handler. Lets a
// spec seed google-session.bin and assert the real app detects the session.
export async function e2eAuthStatus(): Promise<{ signedIn: boolean; userId?: string; email?: string }> {
  const g = getGoogleSession();
  if (g) return { signedIn: true, userId: g.sub, email: g.email };
  const tok = await getSessionToken();
  if (!tok) return { signedIn: false };
  return { signedIn: true, userId: (await getUserId()) ?? undefined };
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
