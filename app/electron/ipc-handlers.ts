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
import {
  capture as analyticsCapture,
  aliasAndIdentify,
  rotateAnonId,
  captureException,
  addBreadcrumb,
} from "./analytics";
import { openExternalSafely } from "./safe-open";
import { getRemoteConfig } from "../src/main-process/remote-config";
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
  restoreMemory,
} from "../src/main-process/memory-store";
import { openPrepAgent, type PrepAgent } from "../src/main-process/prep-agent";
import {
  getSessionToken,
  getUserId,
  signInWithGoogleAndRelay,
  clearSessionCache,
  setReauthHandler,
  revalidateAuth,
} from "../src/main-process/relay-client";
import {
  getSession as getGoogleSession,
  signOut as googleSignOut,
  reopenSignIn,
  cancelSignIn,
  setRefreshFailedHandler,
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

// Analytics events a renderer is allowed to emit via analytics:capture. Keep in
// sync with the renderer call sites; anything else is dropped (see handler).
const RENDERER_EVENTS = new Set<string>([
  "prep_started",
  "playbook_selected",
  "first_run_dismissed",
  "speak_to_founders_clicked",
  "post_call_opened",
  "summary_opened",
  "transcript_opened",
  "screen_viewed",
  "prep_completed",
  "onboarding_step_viewed",
  "nudge_expanded",
  "nudge_dismissed",
]);

let activeSession: SessionHandle | null = null;
let activeSessionSetup: CallSetup | null = null;
// Wall-clock start of the active call, for the call_ended analytics duration.
let sessionStartedAt = 0;

// A call this long "should" have produced transcript; below it, "no transcript"
// is just a quick start/stop, not a failure. Overridable for tests. This is the
// initial silent-call threshold (open decision #4) — tune from field data.
const MEANINGFUL_CALL_S = Number.isFinite(Number(process.env.PROMPTY_MEANINGFUL_CALL_S))
  ? Number(process.env.PROMPTY_MEANINGFUL_CALL_S)
  : 60;

interface CallHealth {
  reason: string;
  duration_s: number | null;
  skill: string | null;
  error_category: string | null;
  audio_input_transport: string | null;
  reached_listening: boolean;
  mic_silent_seen: boolean;
  no_audio_seen: boolean;
  transcript_utterances: number | null;
  them_silent_seen: boolean;
  nudges_fired_count: number | null;
  sidecar_restarts: number | null;
  tap_rebuilds: number | null;
  tap_gave_up: boolean;
}

/**
 * The silent-failure → synthetic-issue bridge (§5.4, the crux). Exception
 * tracking can NEVER catch the John class — nothing throws, capture just goes
 * quiet — so manufacture an issue from the same end-of-call aggregate that builds
 * call_ended. A meaningful call that transcribed nothing (or never reached
 * listening) is a silent-call failure; one that captured us but never the far
 * side is a them-leg blackout. Stable fingerprints so each forms ONE durable,
 * alertable issue instead of a "successful" call that hides the failure.
 */
function reportCallOutcome(h: CallHealth): void {
  const duration = typeof h.duration_s === "number" ? h.duration_s : 0;
  if (duration < MEANINGFUL_CALL_S) return; // too short to judge outcome
  const utterances = typeof h.transcript_utterances === "number" ? h.transcript_utterances : 0;
  const { skill, ...extra } = h; // skill rides as a ctx tag, not duplicated in extra

  if (utterances === 0 || h.reached_listening === false) {
    const e = new Error("call of meaningful duration produced no transcript");
    e.name = "SilentCallError";
    captureException(e, {
      component: "capture",
      phase: "in-call",
      fingerprint: "capture:silent-call",
      skill: skill ?? undefined,
      extra,
    });
    return; // silent-call subsumes the them-leg case — one issue per call
  }
  if (h.them_silent_seen === true) {
    const e = new Error("far-side (them) audio never captured on a meaningful call");
    e.name = "ThemBlackoutError";
    captureException(e, {
      component: "capture",
      phase: "in-call",
      fingerprint: "capture:them-blackout",
      skill: skill ?? undefined,
      extra,
    });
  }
}
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
// Input device transport ("builtin"/"bluetooth"/...) reported by the sidecar,
// attached to call_ended analytics. Metadata only.
let inputTransport: string | null = null;
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
    // First-call primer flag: true while the user's first call is starting/live.
    firstCall:
      (state === "starting" || state === "live") && getSettings().firstCallCoach,
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
  mic: "Ruby can't hear you — allow microphone access to start a call.",
  auth: "Sign in with Google to enable transcription.",
  claude: "Finish setup — connect Claude Code to start calls.",
} as const;

// Proactive auth revalidation cadence (see the revalidateWhenIdle wiring). Launch
// delay lets the window settle first; the interval bounds how long a revoked
// user can keep seeing a stale "Signed in" row while the app stays open.
const AUTH_REVALIDATE_LAUNCH_DELAY_MS = 10_000;
const AUTH_REVALIDATE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h

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
  inputTransport = null;

  try {
    const session = await startSession(setup, {
      debug: debugEnabled(),
      onUtterance: (u) => broadcast("transcript:utterance", u),
      onNudge: (n) => broadcast("nudge:received", n),
      onStatus: (s) => {
        statusLog.push(s);
        broadcast("session:status", s);
      },
      onAudioInfo: (info) => {
        inputTransport = info.inputTransport;
      },
      onSummaryReady: (logPath) => {
        // The background summary pass patched the saved log — tell any open
        // Past Calls view to re-read it.
        if (logPath) broadcast("calls:updated", { name: path.basename(logPath) });
      },
      onStateChange: (s, errorStage) => {
        // Content-free breadcrumb: the state transition (+ which leg failed),
        // so any exception this call raises carries the run-up.
        addBreadcrumb("session-state", errorStage ? `${s}:${errorStage}` : s);
        broadcastSessionState(s);
        if (s === "ended" || s === "error") {
          // Metadata only — duration, outcome, which playbook, and (when a leg
          // failed mid-call) which one; never content.
          // One source of truth: the call_ended health props AND the synthetic
          // silent-call issue (§5.4) are computed from the same aggregate here.
          const health = {
            reason: s,
            duration_s: sessionStartedAt ? Math.round((Date.now() - sessionStartedAt) / 1000) : null,
            skill: setup.skill || null,
            error_category: errorStage ?? (s === "error" ? "unknown" : null),
            // Capture-health (metadata only) — closes the blind spot where a
            // silent call looked "ended" cleanly with no signal about why.
            audio_input_transport: inputTransport,
            reached_listening: statusLog.some((e) => e.state === "listening"),
            // Per-cause telemetry flags (the user-facing status is now unified as
            // "reconnecting-audio", so derive these from the session, not the status log).
            mic_silent_seen: activeSession?.getMicSilentSeen() ?? false,
            no_audio_seen: activeSession?.getNoAudioSeen() ?? false,
            // v2 outcome signal (§7.1): "did it actually work", not just "did it end".
            transcript_utterances: activeSession?.getTranscript().length ?? null,
            them_silent_seen: activeSession?.getThemSilentSeen() ?? false,
            nudges_fired_count: activeSession?.getNudges().length ?? null,
            sidecar_restarts: activeSession?.getSidecarRestarts() ?? null,
            // Tap-watchdog activity (§Phase 6 gap): rebuilds needed to keep "them"
            // alive, and whether it ultimately gave up. A high tap_rebuilds across
            // calls surfaces the SR-change rebuild storm.
            tap_rebuilds: activeSession?.getTapRebuilds() ?? null,
            tap_gave_up: activeSession?.getTapGaveUp() ?? false,
          };
          analyticsCapture("call_ended", health);
          reportCallOutcome(health);
          sessionStartedAt = 0;
          activeSession = null;
          activeSessionSetup = null;
          try {
            hideOverlay();
          } catch {}
          broadcastSessionState("idle");
        }
      },
      onDeepgramConnection: (s) => {
        // Transcription transport health (§7.3) — a dropped/recovered Deepgram
        // socket. Content-free.
        analyticsCapture(s === "disconnected" ? "deepgram_disconnected" : "deepgram_recovered", {
          during_call: true,
        });
      },
      onTapWatchdog: (ev) => {
        // Tap-frame watchdog (the field-visibility half of the v0.1.2 fix). A
        // "recovered" is the watchdog doing its job — count it so a rising rebuild
        // rate (the SR-change storm) is visible. A "gave_up" is a real them-blackout
        // the watchdog couldn't fix → a synthetic capture:tap-gave-up issue, the
        // tap-side sibling of capture:silent-call. Content-free.
        if (ev.kind === "recovered") {
          analyticsCapture("tap_recovered", {
            during_call: true,
            rebuilds: typeof ev.rebuilds === "number" ? ev.rebuilds : null,
          });
        } else {
          const e = new Error("CoreAudio tap gave up rebuilding — the other side isn't being captured");
          e.name = "TapGaveUpError";
          captureException(e, {
            component: "capture",
            phase: "in-call",
            fingerprint: "capture:tap-gave-up",
            skill: setup.skill || undefined,
            extra: { attempt: typeof ev.attempt === "number" ? ev.attempt : null },
          });
          analyticsCapture("tap_gave_up", { during_call: true });
        }
      },
      onError: (e) => {
        console.error("[ipc] session error:", e.message);
        // Route the real stack into error tracking (§3.3). The agent wraps its
        // failures as `agent error: <subtype>`; put the subtype in the
        // fingerprint so distinct causes don't over-merge into one issue (§5.3).
        const m = e.message || "";
        const subtype = m.startsWith("agent error: ") ? m.slice("agent error: ".length) : null;
        captureException(e, {
          component: "agent",
          phase: "in-call",
          skill: setup.skill || undefined,
          fingerprint: subtype ? `agent:${subtype}` : undefined,
        });
      },
    });
    activeSession = session;
    sessionStartedAt = Date.now();
    analyticsCapture("call_started", {
      skill: setup.skill || null,
      component_count: setup.components?.length ?? 0,
    });
    // Show the gem overlay + broadcast setup.
    try {
      showOverlay();
      // Deterministically wipe any stale nudge state the moment the gem is
      // shown for this call — the overlay window is reused across calls and
      // onboarding, so we can't rely on the timing-sensitive "starting"
      // broadcast alone.
      sendTo(getOverlayWindow(), "overlay:reset", { reason: "call-start" });
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
  // The first real call has now happened — retire the one-time in-call primer so
  // it never shows again (regardless of how this call ends).
  if (getSettings().firstCallCoach) updateSettings({ firstCallCoach: false });
  try {
    await s.end("user");
  } catch (e) {
    console.error("[ipc] session end error:", (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true };
}

export function registerIpcHandlers(deps: IpcDeps): void {
  // When the relay client hits a revoked/expired Google refresh token
  // (invalid_grant), it has already dropped the local Google + relay session;
  // the app layer finishes the sign-out: flip signed-in state, rotate the
  // analytics anon id (so a later account can't cross-merge), tell every window,
  // and nudge the user to sign in again. Same effect as an explicit sign-out.
  setReauthHandler((reason) => {
    try {
      rotateAnonId();
      const next = updateSettings({ signedIn: false, signedInUserId: null, signedInEmail: null });
      broadcast("settings:changed", next);
      broadcast("auth:state-changed", { signedIn: false });
      // `reason` distinguishes how the revoke was caught: "revalidate" (proactive,
      // no call) vs "invalid_grant" (at call/mint time) — so a re-auth wave and
      // its trigger are visible in PostHog.
      analyticsCapture("auth_reauth_required", { reason });
      if (Notification.isSupported()) {
        new Notification({
          title: "Ruby needs you to sign in again",
          body: "Your Google session expired. Open Ruby and sign in to keep calls working.",
        }).show();
      }
    } catch (e) {
      console.error("[ipc] re-auth handler failed:", (e as Error).message);
    }
  });

  // Surface transient (non-revoke) refresh failures — network, relay, Google 5xx —
  // so a broken refresh path shows up in analytics instead of only manifesting as
  // users with silently dead calls. A real invalid_grant goes through the re-auth
  // path above, not here.
  setRefreshFailedHandler((reason) => analyticsCapture("token_refresh_failed", { reason }));

  // Proactively detect a revoked/expired Google refresh token so Settings and
  // preflight stop trusting a stale google-session.bin. Without this, a revoke is
  // only caught the next time a call starts or the relay JWT ages out — leaving
  // the Settings "Signed in" row wrong for days. revalidateAuth() is a no-op when
  // signed out and self-throttles; we skip it entirely during an active call to
  // avoid any mid-call auth churn (a staged token rotation is pointless then).
  const revalidateWhenIdle = () => {
    if (getActiveSession()) return;
    void revalidateAuth();
  };
  setTimeout(revalidateWhenIdle, AUTH_REVALIDATE_LAUNCH_DELAY_MS);
  setInterval(revalidateWhenIdle, AUTH_REVALIDATE_INTERVAL_MS).unref?.();

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
            let attendee: string | undefined;
            try {
              const obj = JSON.parse(await fs.readFile(full, "utf8")) as {
                title?: string;
                summary?: { title?: string };
                direction?: string;
                startedAt?: number;
                endedAt?: number;
                summaryPending?: boolean;
                attendee?: { name?: string };
              };
              title = deriveCallTitle(obj.title, obj.summary?.title, obj.direction);
              startedAt = obj.startedAt;
              endedAt = obj.endedAt;
              summaryPending = obj.summaryPending === true;
              attendee = obj.attendee?.name;
            } catch {
              // Unreadable/corrupt log — list it with an empty title.
            }
            return { name: e.name, mtimeMs: stat.mtimeMs, title, startedAt, endedAt, summaryPending, attendee };
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
      // Tell any open Past Calls / recap view to re-read the renamed log.
      broadcast("calls:updated", { name: path.basename(full) });
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

  // Prep errors reach the prep chat verbatim, so a raw thrown message can leak
  // internals (CLAUDE_CLI_PATH, file paths, octal modes, SDK stack detail). Show a
  // plain line to the user; keep the real message in the logs.
  const reportPrepError = (e: unknown) => {
    console.error("[ipc] prep error:", (e as Error)?.message ?? e);
    broadcast("prep:error", {
      message: "Couldn't reach the prep assistant. Make sure Claude Code is set up, then try again.",
    });
  };

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
          onError: (e) => reportPrepError(e),
        },
        carried,
      );
      // Fire the opening turn (reflect the brief + ask flesh-out-or-go). Don't
      // block the handler on it — it streams in through the same broadcasts as any
      // turn, after the renderer has shown the seed as the first user bubble.
      broadcast("prep:thinking", { thinking: true });
      void activePrep
        .open()
        .catch((e) => reportPrepError(e))
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
      reportPrepError(e);
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
  handle("memory:restore", (payload) => ({
    item: restoreMemory(payload.item, payload.index),
  }));

  handle("settings:get", () => getSettings());

  handle("settings:set", (payload) => {
    const next = updateSettings(payload);
    broadcast("settings:changed", next);
    return next;
  });

  handle("skills:list", () => ({ skills: listBundledSkills() }));

  handle("auth:google-sign-in", async () => {
    analyticsCapture("sign_in_started");
    try {
      const session = await signInWithGoogleAndRelay();
      const next = updateSettings({
        signedIn: true,
        signedInUserId: session.userId,
        signedInEmail: session.email,
      });
      broadcast("settings:changed", next);
      // Stitch pre-sign-in activity to this user, then mark them identified.
      // alias fires only here (the sign-in moment) — never on relaunch.
      aliasAndIdentify(session.userId, { signed_in: true, email: session.email });
      analyticsCapture("signed_in");
      broadcast("auth:state-changed", {
        signedIn: true,
        userId: session.userId,
        email: session.email,
      });
      return { ok: true, userId: session.userId, email: session.email };
    } catch (e) {
      const msg = (e as Error).message;
      // Distinguish a user-cancelled sign-in from a real failure so the funnel
      // isn't polluted by people who simply closed the window.
      const cancelled = /cancel/i.test(msg);
      analyticsCapture("sign_in_failed", { reason: cancelled ? "cancelled" : "error", message: msg });
      console.error("[ipc] auth:google-sign-in failed:", msg);
      return { ok: false, error: msg };
    }
  });

  // Re-open the browser to the in-flight sign-in URL (the user closed/lost the
  // tab we opened). Reuses the same flow — no parallel loopback, no state churn.
  handle("auth:reopen-signin", async () => ({ ok: reopenSignIn() }));

  // Cancel the in-flight sign-in so the disabled button clears immediately instead
  // of waiting out the 5-min abandon timeout.
  handle("auth:cancel-signin", async () => {
    cancelSignIn();
    return { ok: true };
  });

  handle("auth:sign-out", async () => {
    try {
      googleSignOut();
      clearSessionCache();
      // Rotate the anon id so a different account signing in next on this device
      // aliases a fresh anon person, not this user's already-identified id.
      rotateAnonId();
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
      // Report the file-based answer immediately (keeps Settings snappy), but
      // kick a throttled background revalidation: if the refresh token is dead,
      // handleReauthRequired fires and broadcasts auth:state-changed{signedIn:false}
      // a moment later, flipping the UI. Not awaited on purpose — a slow/failed
      // Google round-trip must never hang or wrongly sign out the status call.
      if (!getActiveSession()) void revalidateAuth();
      return { signedIn: true, userId: g.sub, email: g.email };
    }
    const tok = await getSessionToken();
    if (!tok) return { signedIn: false };
    const uid = (await getUserId()) ?? undefined;
    return { signedIn: true, userId: uid };
  });

  // Whether verbose debug capture is on (the `PROMPTY_DEBUG=1` env switch). The
  // Settings "Debug logs" row is only rendered when this is true — it's a
  // developer affordance, not a user-facing control. Kept here (not on a static
  // window field) so a renderer reload always reflects the live env.
  handle("debug:enabled", async () => {
    return { enabled: process.env.PROMPTY_DEBUG === "1" };
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
      // A denied mic = a permanently broken app; track the outcome so the
      // activation drop-off is visible. Metadata only (no content).
      analyticsCapture("mic_permission_result", { granted, status: post, where: "onboarding" });
      return { granted };
    } catch (e) {
      console.error("[onboarding] askForMediaAccess failed:", (e as Error).message);
      analyticsCapture("mic_permission_result", { granted: false, where: "onboarding" });
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
    // Scheme-allowlisted (audit finding #5) — see openExternalSafely.
    openExternalSafely(payload.url);
  });

  // Dynamic links (founders call, "How Ruby works") whose URLs come from the
  // relay's /config so they can change without an app rebuild. The renderer only
  // names WHICH link; the URL is resolved here from the cached remote config and
  // run through the same scheme allowlist.
  handle("links:open", (payload) => {
    const cfg = getRemoteConfig();
    const url = payload.which === "howItWorks" ? cfg.howItWorksUrl : cfg.foundersUrl;
    openExternalSafely(url);
  });

  // Renderer-emitted analytics. Allowlisted so only known, content-free events
  // can be sent from a window — the main process owns the distinct_id + base
  // props (see analytics.ts). Unknown names are dropped with a warning.
  handle("analytics:capture", (payload) => {
    if (!payload || !RENDERER_EVENTS.has(payload.event)) {
      console.warn(`[analytics] dropped non-allowlisted renderer event: ${payload?.event}`);
      return;
    }
    analyticsCapture(payload.event, payload.properties ?? {});
  });

  // A renderer saw an audio device/route change. Only a during-call flip is
  // signal (the John trigger — correlate with silent calls); outside a call it's
  // noise, so drop it.
  handle("analytics:audio-route-changed", (payload) => {
    if (!activeSession) return;
    analyticsCapture("audio_route_changed", {
      during_call: true,
      // The actual transition (e.g. "MacBook Air Speakers" → "Sahil's QC") — what
      // explains a silent call, not just that a flip happened. Null before mic
      // permission makes labels readable.
      from_input: payload?.fromInput ?? null,
      to_input: payload?.toInput ?? null,
      from_output: payload?.fromOutput ?? null,
      to_output: payload?.toOutput ?? null,
    });
  });

  // Renderer JS exceptions (window.onerror / unhandledrejection / ErrorBoundary).
  // Rebuild the Error from the serialized fields and report it; the scrubber runs
  // in captureException/before_send so the stack/message ship safe.
  handle("analytics:captureException", (payload) => {
    if (!payload || !payload.message) return;
    const err = new Error(payload.message);
    if (payload.name) err.name = payload.name;
    if (payload.stack) err.stack = payload.stack;
    captureException(err, {
      component: "renderer-ui",
      extra: { surface: payload.surface, ...(payload.properties ?? {}) },
    });
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
    // Arm the one-time guided first run in Home (prep + playbook coachmarks).
    updateSettings({ onboardingCompleted: true, firstRunCoach: true, firstCallCoach: true });
    analyticsCapture("onboarding_completed");
    sendTo(getOverlayWindow(), "overlay:ruby-message", { text: null });
    // Clear the canned onboarding demo nudge so it can't linger in the gem's
    // history into the first real call.
    sendTo(getOverlayWindow(), "overlay:reset", { reason: "onboarding-complete" });
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
    analyticsCapture("nudge_fired", { source });
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

export function e2eSimulateThemSilent(): boolean {
  if (!activeSession) return false;
  activeSession.simulateThemSilent();
  return true;
}

export function e2eSimulateDeepgramStatus(s: "reconnecting" | "open" | "error"): boolean {
  if (!activeSession) return false;
  activeSession.simulateDeepgramStatus(s);
  return true;
}

// Push a synthetic session state to the renderers via the real broadcast path.
// Used by e2e to hold a window in a transient state (e.g. "ending") long enough
// to assert its UI — the mock end() flow flips through "ending" too fast to catch.
export function e2eBroadcastSessionState(state: SessionState | "idle"): boolean {
  broadcastSessionState(state);
  return true;
}
