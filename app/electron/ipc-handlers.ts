import { app, BrowserWindow, ipcMain, Notification, shell, systemPreferences } from "electron";
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
  ArmedEvent,
} from "../src/shared/ipc";
import { getSettings, updateSettings } from "./settings-store";
import { openMainWindow } from "./main-window";
import { showOverlay, hideOverlay, setOverlayHeight } from "./overlay-window";
import { showTeleprompter, hideTeleprompter } from "./teleprompter-window";
import {
  openPrepSession,
  type PrepSessionHandle,
  type PrepSeed,
} from "../src/main-process/prep-session";
import {
  getPendingPrep,
  setPendingPrep,
  clearPendingPrep,
  type PendingPrep,
  type PendingPrepMessage,
} from "../src/main-process/pending-prep";
import { rebuildMenu } from "./tray";
import { startSession, type SessionHandle, type SessionState } from "../src/main-process/coach-session";
import {
  getDeepgramToken,
  getSessionToken,
  getUserId,
  signInWithGoogleAndRelay,
  clearSessionCache,
} from "../src/main-process/relay-client";
import { getSession as getGoogleSession, signOut as googleSignOut } from "../src/main-process/google-auth";
import {
  startCalendarArm,
  listUpcomingQualifyingEvents,
  type CalendarArmHandle,
  type CalendarEvent,
} from "../src/main-process/calendar-arm";
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
  | { code: "mic" | "auth" | "claude"; message: string; at: number }
  | null = null;
let calendarArm: CalendarArmHandle | null = null;
let lastBroadcastState: SessionState | "idle" = "idle";
let activePrep: PrepSessionHandle | null = null;
let activePrepEvent: CalendarEvent | null = null;

function pendingPrepToPayload(p: PendingPrep | null) {
  if (!p) return null;
  return {
    goal: p.goal ?? "",
    checklist: p.checklist ?? [],
    notes: p.notes,
    mode: p.mode,
    eventId: p.eventId,
    eventTitle: p.eventTitle,
    savedAt: p.savedAt,
  };
}

function seedFromPending(p: PendingPrep): PrepSeed {
  return {
    goal: p.goal,
    checklist: p.checklist,
    notes: p.notes,
    mode: p.mode,
    messages: (p.messages ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt,
      toolName: m.toolName,
    })),
  };
}

function prepStateToPayload(handle: PrepSessionHandle) {
  const s = handle.getState();
  return {
    goal: s.goal,
    checklist: s.checklist,
    notes: s.notes,
    mode: s.mode,
    messages: s.messages,
    assistantBusy: s.assistantBusy,
    event: s.event ? toArmedEvent(s.event) : null,
  };
}

async function ensurePrepSession(
  event: CalendarEvent | null,
  seed?: PrepSeed,
): Promise<PrepSessionHandle> {
  if (activePrep) {
    // If event differs, discard and start anew.
    if ((activePrepEvent?.id ?? null) === (event?.id ?? null) && !seed) {
      return activePrep;
    }
    try { await activePrep.close(); } catch {}
    activePrep = null;
  }
  activePrepEvent = event;
  const handle = await openPrepSession(event, seed);
  handle.on("state-changed", () => {
    broadcast("prep:state-changed", prepStateToPayload(handle));
  });
  handle.on("assistant-chunk", (chunk) => {
    broadcast("prep:assistant-chunk", chunk);
  });
  handle.on("error", (e) => {
    console.error("[prep] error:", e.message);
  });
  activePrep = handle;
  // Broadcast initial state.
  broadcast("prep:state-changed", prepStateToPayload(handle));
  return handle;
}

async function lookupEventById(id?: string): Promise<CalendarEvent | null> {
  if (!id) return null;
  const cur = calendarArm?.getCurrentArmed();
  if (cur && cur.id === id) return cur;
  // Fall back to fetching the upcoming list and finding a match.
  try {
    const list = await listUpcomingQualifyingEvents(20, 24 * 60);
    return list.find((e) => e.id === id) ?? null;
  } catch {
    return null;
  }
}

// The single bridge from the persisted draft to a CallSetup. A null/empty draft
// yields a mode-only setup (the in-call prompt omits absent goal/checklist/notes).
// `fallbackMode` applies only when the draft carries no mode (e.g. a pure idle
// quick-start where the chip's mode is the only signal).
function draftToSetup(draft: PendingPrep | null, fallbackMode?: string): CallSetup {
  const notes = draft?.notes?.trim() || undefined;
  return {
    goal: draft?.goal ?? "",
    checklist: draft?.checklist ?? [],
    context: notes ? { manualNotes: notes } : {},
    mode: draft?.mode ?? fallbackMode,
  };
}

function toArmedEvent(ev: CalendarEvent | null): ArmedEvent | null {
  if (!ev) return null;
  return {
    id: ev.id,
    title: ev.title,
    startsAt: ev.startsAt,
    attendees: ev.attendees,
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
  mic: "Prompty needs microphone access to hear the call.",
  auth: "Sign in with Google to enable transcription.",
  claude: "Install Claude Code to enable AI coaching.",
} as const;

/**
 * Verify the hard requirements before opening an in-call overlay: mic
 * permission, signed-in (for the Deepgram token), and the `claude` binary.
 * On failure the caller surfaces an actionable message instead of opening a
 * dead overlay. Bypassed under E2E/mock so existing start tests still run; a
 * specific failure can be forced for tests via PROMPTY_E2E_FORCE_PREFLIGHT.
 */
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
  const signedIn = !!getGoogleSession() || !!(await getSessionToken());
  if (!signedIn) {
    return { ok: false, code: "auth", message: PREFLIGHT_MESSAGES.auth };
  }
  if (!findClaudeBinary()) {
    return { ok: false, code: "claude", message: PREFLIGHT_MESSAGES.claude };
  }
  return { ok: true };
}

async function doStartSession(
  mode?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (activeSession) {
    return { ok: false, error: "session already active" };
  }
  const pf = await preflight();
  if (!pf.ok) {
    console.warn(`[ipc] preflight blocked start: ${pf.code}`);
    // Surface an actionable message in the main window instead of opening a
    // dead overlay. Record it first so a just-opened window can fetch it on
    // mount (covers the T-0 notification path where no window is open yet).
    lastPreflightFailure = { code: pf.code, message: pf.message, at: Date.now() };
    try {
      openMainWindow();
    } catch {}
    broadcast("preflight:failed", { code: pf.code, message: pf.message });
    return { ok: false, error: pf.code };
  }
  lastPreflightFailure = null;
  // Single source of truth: the persisted draft. It may carry any subset of
  // mode/goal/checklist/notes (or be absent entirely for a bare quick-start).
  // Note: when a draft exists, its mode wins over the idle chip's `mode` — but
  // the chip is only shown when there's no draft hero, so they don't collide.
  const draft = getPendingPrep();
  const setup = draftToSetup(draft, mode);
  if (draft) {
    // Consume the draft on session start.
    clearPendingPrep();
    broadcast("pending-prep:changed", { prep: null });
  }
  activeSessionSetup = setup;
  statusLog = [];

  try {
    const session = await startSession(setup, {
      onUtterance: (u) => broadcast("transcript:utterance", u),
      onNudge: (n) => broadcast("nudge:received", n),
      onStatus: (s) => {
        statusLog.push(s);
        broadcast("session:status", s);
      },
      onChecklistUpdate: (id, status) => {
        // Setup checklist is mutated by coach-session; rebroadcast setup so renderers refresh.
        broadcast("session:setup", { setup });
        void id; void status;
      },
      onStateChange: (s) => {
        broadcastSessionState(s);
        if (s === "ended" || s === "error") {
          activeSession = null;
          activeSessionSetup = null;
          try {
            hideOverlay();
            hideTeleprompter();
          } catch {}
          broadcastSessionState("idle");
        }
      },
      onError: (e) => {
        console.error("[ipc] session error:", e.message);
      },
    });
    activeSession = session;
    // Show overlay + broadcast setup.
    try {
      showOverlay();
      if (getSettings().headsUpBar) showTeleprompter();
    } catch (e) {
      console.error("[ipc] showOverlay failed:", (e as Error).message);
    }
    broadcast("session:setup", { setup });
    // Cancel any pending T-0 timer for the armed event since we just started.
    const armed = calendarArm?.getCurrentArmed();
    if (armed) calendarArm?.cancelStartTimer(armed.id);
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
    setOverlayHeight(payload.height, payload.mode);
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
            const stat = await fs.stat(path.join(dir, e.name));
            return { name: e.name, mtimeMs: stat.mtimeMs };
          }),
      );
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return { files };
    } catch {
      return { files: [] };
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
    // If a session is active, react to focus-mode toggle by showing/hiding teleprompter.
    if (activeSession && payload.headsUpBar !== undefined) {
      try {
        if (next.headsUpBar) showTeleprompter();
        else hideTeleprompter();
      } catch (e) {
        console.error("[ipc] teleprompter toggle failed:", (e as Error).message);
      }
    }
    return next;
  });

  handle("call:start", async (payload) => {
    return doStartSession(payload?.mode);
  });

  handle("call:end", async () => {
    return doEndSession();
  });

  handle("checklist:toggle", (payload) => {
    if (!activeSession) return;
    activeSession.setChecklist(payload.id, payload.status);
    if (activeSessionSetup) {
      broadcast("session:setup", { setup: activeSessionSetup });
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

  handle("calendar:current-arm", () => {
    return { event: toArmedEvent(calendarArm?.getCurrentArmed() ?? null) };
  });

  handle("calendar:list-upcoming", async (req) => {
    const limit = req?.limit ?? 5;
    const windowMinutes = req?.windowMinutes ?? 24 * 60;
    try {
      const events = await listUpcomingQualifyingEvents(limit, windowMinutes);
      return {
        events: events
          .map((e) => toArmedEvent(e))
          .filter((e): e is ArmedEvent => e !== null),
      };
    } catch (e) {
      console.error("[ipc] calendar:list-upcoming failed:", (e as Error).message);
      return { events: [] };
    }
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
        title: "Prompty notifications enabled",
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

  // ---- Prep (Stage 4) ----
  handle("prep:open", async (payload) => {
    try {
      const event = await lookupEventById(payload?.eventId);
      // Hydrate from pending prep if it matches this event (resume case).
      const pp = getPendingPrep();
      let seed: PrepSeed | undefined;
      if (pp) {
        const sameEvent = (pp.eventId ?? null) === (event?.id ?? null);
        if (sameEvent) {
          seed = seedFromPending(pp);
        }
      }
      // Open the prep tab in the main window (no separate prep window now).
      openMainWindow("prep");
      await ensurePrepSession(event, seed);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle("prep:send-message", async (payload) => {
    try {
      let prep = activePrep;
      if (!prep) {
        prep = await ensurePrepSession(activePrepEvent ?? null);
      }
      await prep.sendMessage(payload.text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle("prep:kick", async () => {
    try {
      let prep = activePrep;
      if (!prep) {
        prep = await ensurePrepSession(activePrepEvent ?? null);
      }
      await prep.kick();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle("prep:get-state", () => {
    if (!activePrep) return null;
    return prepStateToPayload(activePrep);
  });

  handle("prep:save", async (payload) => {
    if (!activePrep) {
      return { ok: false, error: "no prep session" };
    }
    const snap = activePrep.snapshot();
    // A draft is worth saving if it carries any of goal / checklist / notes.
    if (!snap.goal && snap.checklist.length === 0 && !snap.notes.trim()) {
      return { ok: false, error: "nothing to save (set a goal, item, or note)" };
    }
    const fullState = activePrep.getState();
    const messages: PendingPrepMessage[] = fullState.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      createdAt: m.createdAt,
      toolName: m.toolName,
    }));
    const pp: PendingPrep = {
      goal: snap.goal || undefined,
      checklist: snap.checklist,
      notes: snap.notes.trim() || undefined,
      mode: snap.mode || undefined,
      eventId: snap.event?.id,
      eventTitle: snap.event?.title,
      messages,
      savedAt: Date.now(),
    };
    try {
      setPendingPrep(pp);
      broadcast("pending-prep:changed", { prep: pendingPrepToPayload(pp) });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    // Tear down the prep session. No separate prep window to close.
    try { await activePrep.close(); } catch {}
    activePrep = null;
    activePrepEvent = null;
    // Broadcast a null prep state so the main window's PrepTab returns to
    // the no-active-prep view.
    broadcast("prep:state-changed", null);
    if (payload.andStartCoaching) {
      const r = await doStartSession();
      return r;
    }
    return { ok: true };
  });

  handle("prep:set-mode", (payload) => {
    if (!activePrep) {
      return { ok: false, error: "no prep session" };
    }
    try {
      activePrep.setMode(payload.mode);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle("prep:set-goal", (payload) => {
    if (!activePrep) {
      return { ok: false, error: "no prep session" };
    }
    try {
      activePrep.setGoal(payload.text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle("prep:set-notes", (payload) => {
    if (!activePrep) {
      return { ok: false, error: "no prep session" };
    }
    try {
      activePrep.setNotes(payload.text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle("prep:add-checklist-item", (payload) => {
    if (!activePrep) {
      return { ok: false, error: "no prep session" };
    }
    try {
      activePrep.addChecklistItem(payload.text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle("prep:edit-checklist-item", (payload) => {
    if (!activePrep) {
      return { ok: false, error: "no prep session" };
    }
    try {
      activePrep.editChecklistItem(payload.id, payload.text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle("prep:remove-checklist-item", (payload) => {
    if (!activePrep) {
      return { ok: false, error: "no prep session" };
    }
    try {
      activePrep.removeChecklistItem(payload.id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  handle("prep:discard", async () => {
    try {
      if (activePrep) {
        await activePrep.discard();
        await activePrep.close();
      }
    } catch {}
    activePrep = null;
    activePrepEvent = null;
    broadcast("prep:state-changed", null);
    return { ok: true };
  });

  handle("draft:set-notes", (payload) => {
    // Notes added from the idle/home screen with no prep session open. Merge
    // into the existing draft (or create a notes-only one) so call:start can
    // carry the notes without ever running prep.
    const cur = getPendingPrep();
    const notes = payload.notes.trim() || undefined;
    const next: PendingPrep = {
      ...(cur ?? {}),
      notes,
      savedAt: Date.now(),
    };
    setPendingPrep(next);
    broadcast("pending-prep:changed", { prep: pendingPrepToPayload(next) });
    return { ok: true };
  });

  handle("pending-prep:get", () => {
    return pendingPrepToPayload(getPendingPrep());
  });

  handle("pending-prep:clear", () => {
    clearPendingPrep();
    broadcast("pending-prep:changed", { prep: null });
    return { ok: true };
  });

  // ---- Calendar-arm scheduler ----
  if (!calendarArm) {
    calendarArm = startCalendarArm({
      onArmed: (event) => {
        console.log(`[calendar-arm] armed: ${event.title}`);
        broadcast("call:status", { status: "armed", reason: event.title });
        broadcast("calendar:arm-changed", { event: toArmedEvent(event) });
      },
      onUnarmed: () => {
        broadcast("calendar:arm-changed", { event: null });
      },
      onNotificationClick: (event) => {
        console.log(`[calendar-arm] notification click for: ${event.title}`);
        // Open prep tab in main window and seed from any matching pending prep.
        try { openMainWindow("prep"); } catch {}
        const pp = getPendingPrep();
        const seed =
          pp && (pp.eventId ?? null) === (event.id ?? null)
            ? seedFromPending(pp)
            : undefined;
        void ensurePrepSession(event, seed).catch((e) => {
          console.error("[calendar-arm] ensurePrepSession failed:", (e as Error).message);
        });
      },
      onStartTime: (event) => {
        console.log(`[calendar-arm] T-0 click — starting session for ${event.title}`);
        void doStartSession();
      },
    });
  }

  // Reference deps to satisfy noUnusedParameters
  void deps;
}

export function shutdownIpc(): void {
  calendarArm?.stop();
  calendarArm = null;
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

export function getCalendarArm(): CalendarArmHandle | null {
  return calendarArm;
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

export async function e2eEnsurePrepSession(event: CalendarEvent | null): Promise<unknown> {
  const handle = await ensurePrepSession(event);
  return prepStateToPayload(handle);
}

export async function e2eSendPrepMessage(text: string): Promise<{ ok: boolean; error?: string }> {
  if (!activePrep) {
    return { ok: false, error: "no prep session" };
  }
  await activePrep.sendMessage(text);
  return { ok: true };
}

export function e2eGetPrepState(): unknown {
  if (!activePrep) return null;
  return prepStateToPayload(activePrep);
}

export async function e2eFireNotificationClick(eventId?: string): Promise<{ ok: boolean }> {
  const cur = calendarArm?.getCurrentArmed();
  const event = (eventId && cur && cur.id === eventId) ? cur : cur;
  if (!event) return { ok: false };
  try { openMainWindow("prep"); } catch {}
  const pp = getPendingPrep();
  const seed =
    pp && (pp.eventId ?? null) === (event.id ?? null)
      ? seedFromPending(pp)
      : undefined;
  await ensurePrepSession(event, seed);
  return { ok: true };
}

export function e2eGetPendingPrep(): unknown {
  return pendingPrepToPayload(getPendingPrep());
}
