// Stage 3 — Coach session module.
//
// Encapsulates everything needed to run a live coaching session: spawn the
// Swift audio sidecar, open dual-stream Deepgram, start the agent loop,
// route final utterances into the agent's `consider()` window, and silence-
// based auto-end. Returns a SessionHandle so callers can end the session,
// inject test utterances, or push checklist updates.
//
// This was previously inlined inside electron/ipc-handlers.ts's startCall().
// Behavior is intentionally identical.

import path from "node:path";
import { Notification, shell } from "electron";
import { openAgent, type Agent } from "./agent";
import { CONSIDER_WINDOW } from "./windowing";
import { answerNow } from "./answer";
import { createSummaryKeeper, type SummaryKeeper } from "./running-summary";
import { writeCallLog, deriveCallTitle, updateCallLogSummary } from "./call-log";
import { readMemory } from "./memory-store";
import { openJournal, type JournalHandle } from "./journal";
import { openDebugLog, type DebugLog } from "./debug-logger";
import { buildSystemPrompt } from "./prompts/system";
import { spawnSidecar, type SidecarHandle } from "./sidecar";
import { startTranscription, type TranscriptionHandle, type DeepgramConnStatus } from "./deepgram";
import { getDeepgramToken } from "./relay-client";
import { createMicSilenceDetector } from "./mic-silence";
import { createThemSilenceDetector } from "./them-silence";
import type {
  CallSetup,
  Nudge,
  TranscriptUtterance,
  SessionStatus,
  SessionStatusEvent,
} from "./types";

export type SessionState = "starting" | "live" | "ending" | "ended" | "error";
export type EndReason = "user" | "error";

/**
 * Build the Deepgram key provider for a session. Called on every socket connect
 * (incl. reconnects) so a re-key past the relay key's 1h TTL gets a fresh key.
 *
 * Three paths, in priority order:
 *   - mock: a stub key (the mock stream never actually uses it).
 *   - dev local: `DEEPGRAM_API_KEY` in the gitignored `.env`/env — a static key
 *     for local/E2E, bypassing the relay entirely (plan §Phase B 2).
 *   - relay: mint/reuse a short-lived ephemeral key via the Google-auth'd relay.
 */
function makeDeepgramKeyProvider(usingMockDeepgram: boolean): () => Promise<string> {
  if (usingMockDeepgram) return async () => "mock";
  const localKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (localKey) return async () => localKey;
  return getDeepgramToken;
}

/** Default ms of audio silence before the status flips to "reconnecting-audio". */
const DEFAULT_NO_AUDIO_MS = 10_000;
/** Default ms of no mic frames (while the tap is live) before flagging the mic dead. */
const DEFAULT_MIC_DEAD_MS = 6_000;

export interface SessionOpts {
  onUtterance?: (u: TranscriptUtterance) => void;
  onNudge?: (n: Nudge) => void;
  /** The agent decided not to nudge this turn, with its reason. */
  onStayQuiet?: (reason: string) => void;
  onStateChange?: (state: SessionState, errorStage?: string | null) => void;
  /** Live audio/transcription health for the overlay status dot. */
  onStatus?: (s: SessionStatusEvent) => void;
  /**
   * Capture-device metadata once the sidecar reports ready — currently the
   * input device transport ("builtin" / "bluetooth" / "usb" / ...). Metadata
   * only; lets the IPC layer attach it to call analytics.
   */
  onAudioInfo?: (info: { inputTransport: string | null }) => void;
  /** Deepgram transport health: a socket dropped (disconnected) or a reconnect
   * succeeded (recovered). Metadata only; the IPC layer turns it into analytics. */
  onDeepgramConnection?: (s: "disconnected" | "recovered") => void;
  /** Tap-frame watchdog (CoreAudioTap) health: the "them" leg went silent and the
   * sidecar rebuilt the graph ("recovered" after N rebuilds) or exhausted its
   * bounded retries ("gave_up" — a real them-blackout). Metadata only; the IPC
   * layer turns "recovered" into an analytics event and "gave_up" into a synthetic
   * capture:tap-gave-up issue. This is the field-visibility half of the v0.1.2
   * watchdog fix — without it the sidecar's tap_silent/tap_recovered messages are
   * dropped and we can't tell whether the fix is holding in the field. */
  onTapWatchdog?: (ev: {
    kind: "recovered" | "gave_up";
    rebuilds?: number;
    attempt?: number;
  }) => void;
  /**
   * Fired after the background summary pass has patched the saved log (or right
   * after the fast end when there's nothing to summarize). `logPath` is null if
   * the write failed. Lets the IPC layer tell renderers to refresh the Past
   * Calls card once the summary has landed.
   */
  onSummaryReady?: (
    logPath: string | null,
    summary?: import("./summary").CallSummary,
  ) => void;
  onError?: (e: Error) => void;
  /** Override mock-flag detection (mostly for tests). */
  mockAudio?: boolean;
  mockDeepgram?: boolean;
  /** Mocked agent factory — primarily for E2E. */
  agentFactory?: (setup: CallSetup, events: Parameters<typeof openAgent>[1]) => Promise<Agent>;
  /** Start with verbose debug capture on (the `PROMPTY_DEBUG` env switch). */
  debug?: boolean;
}

export interface SessionHandle {
  /**
   * End the call. By default the post-call summary is generated in the
   * background — `end()` resolves as soon as the call is torn down and the log
   * is persisted, so the UI returns to rest immediately. Pass
   * `{ background: false }` (the quit path) to await the summary inline so the
   * process doesn't exit before it lands.
   */
  end(reason?: EndReason, opts?: { background?: boolean }): Promise<void>;
  injectUtterance(u: TranscriptUtterance): void;
  /** Manually request a nudge from the agent — used by the hotkey. */
  requestNudge(): void;
  /**
   * Resolve once the session is idle: no auto-consider in flight or pending and
   * no hotkey answer in flight. Dormant in real calls (no one awaits it); the
   * replay harness uses it to feed utterances settle-between.
   */
  waitIdle(): Promise<void>;
  /** Toggle verbose debug capture mid-session (used by the debug-capture smoke test). */
  setDebug(enabled: boolean): void;
  /** Force an "error" status — used by E2E to verify the status wiring. */
  simulateTransportError(reason?: string): void;
  /** Test seams: mark the them-leg silent / bump the sidecar-restart count.
   * The real detection (tap-frame staleness, sidecar "restart" events) is
   * physical; these verify the getter→call_ended wiring offline. */
  simulateThemSilent(): void;
  simulateSidecarRestart(): void;
  /** Test seam: drive a tap-watchdog outcome ("recovered" with N rebuilds, or
   * "gave_up") through the same path the sidecar control event takes — verifies
   * the getter→call_ended wiring and the onTapWatchdog callback offline. */
  simulateTapWatchdog(ev: { kind: "recovered" | "gave_up"; rebuilds?: number; attempt?: number }): void;
  /** Test seam: drive a Deepgram connection status through the REAL handler
   * (exercises the disconnect/recover latch), e.g. "reconnecting" then "open". */
  simulateDeepgramStatus(s: DeepgramConnStatus): void;
  getNudges(): Nudge[];
  getTranscript(): TranscriptUtterance[];
  /** Whole-call "ever" flag: the tap (them) leg went silent while the mic stayed live. */
  getThemSilentSeen(): boolean;
  /** Whole-call "ever" flag: the mic leg went all-zero (permission/muted) or dead. */
  getMicSilentSeen(): boolean;
  /** Whole-call "ever" flag: both legs stopped delivering frames at once. */
  getNoAudioSeen(): boolean;
  /** Number of sidecar auto-restarts observed during this call. */
  getSidecarRestarts(): number;
  /** Total tap-frame-watchdog rebuilds needed to recover the "them" leg this call. */
  getTapRebuilds(): number;
  /** The tap watchdog exhausted its retries this call (a real them-blackout). */
  getTapGaveUp(): boolean;
  getSetup(): CallSetup;
  getState(): SessionState;
  /** Resolved log path once end() completes. */
  getLogPath(): string | null;
}

/** Mark a checklist item covered in the live setup (RUBY B3 phase 3c). The
 *  mutated `setup.components` is what end() persists into the CallLog. */
function markChecklistItemCovered(setup: CallSetup, itemId: string): void {
  for (const c of setup.components ?? []) {
    if (c.type !== "checklist") continue;
    const item = c.items.find((it) => it.id === itemId);
    if (item) {
      item.done = true;
      return;
    }
  }
}

/**
 * Mock agent — used in E2E mode (PROMPTY_MOCK_AGENT=1) and as a stub in
 * smoke tests. Emits a canned nudge each `consider()` call, and on the first
 * call marks the first checklist item covered so the check-off path is
 * exercisable without a real model.
 */
export function createMockAgent(
  setup: CallSetup,
  events: Parameters<typeof openAgent>[1],
): Promise<Agent> {
  let counter = 0;
  const firstChecklistItemId = (() => {
    for (const c of setup.components ?? []) {
      if (c.type === "checklist" && c.items.length) return c.items[0]!.id;
    }
    return null;
  })();
  return Promise.resolve({
    async consider(_window, trigger) {
      counter++;
      if (counter === 1 && firstChecklistItemId) {
        events.onItemCovered?.(firstChecklistItemId);
      }
      events.onNudge({
        id: `mock-${counter}-${Date.now()}`,
        text: `Mock nudge ${counter} (trigger=${trigger})`,
        urgency: "medium",
        createdAt: Date.now(),
      });
    },
    async close() {
      /* no-op */
    },
  });
}

export async function startSession(
  setup: CallSetup,
  opts: SessionOpts = {},
): Promise<SessionHandle> {
  // Snapshot the user's global memory (personalisation) onto the setup so every
  // prompt built from it — in-call nudges and the hotkey one-shot — reflects how
  // Ruby should coach them. Done once here, the single entry point for all
  // sessions (IPC, smoke, replay). A caller may pre-supply `memories` (e.g. [])
  // to override; we only fill it when absent.
  if (setup.memories === undefined) {
    setup = { ...setup, memories: readMemory() };
  }
  const startedAt = Date.now();
  const transcript: TranscriptUtterance[] = [];
  const nudges: Nudge[] = [];
  // Crash-safe append-as-you-go journal; recovered on next launch if we crash
  // before end() writes the consolidated log.
  const journal: JournalHandle | null = openJournal(setup, startedAt);
  const considerWindow: TranscriptUtterance[] = [];

  // ---- Verbose debug capture (opt-in via `PROMPTY_DEBUG=1`) ----
  // Separate from the always-on journal: captures the model's-eye view
  // (resolved prompt, per-turn context, raw responses, tool calls, latencies,
  // interim utterances, status transitions). Null unless debug is on; can be
  // opened/closed mid-session via setDebug() so a toggle takes effect at once.
  let debugLog: DebugLog | null = null;
  const openDebug = () => {
    if (debugLog) return;
    debugLog = openDebugLog("call", startedAt);
    debugLog?.write("session-start", {
      direction: setup.direction,
      skill: setup.skill,
      startedAt,
      // Resolved static prompt, logged once (fidelity "B").
      systemPrompt: buildSystemPrompt(setup),
    });
  };
  const closeDebug = () => {
    if (!debugLog) return;
    debugLog.close();
    debugLog = null;
  };
  if (opts.debug) openDebug();

  const usingMockAudio = opts.mockAudio ?? process.env.PROMPTY_MOCK_AUDIO === "1";
  const usingMockDeepgram =
    opts.mockDeepgram ?? process.env.PROMPTY_MOCK_DEEPGRAM === "1";
  const usingMockAgent = process.env.PROMPTY_MOCK_AGENT === "1";
  const isE2E = process.env.PROMPTY_E2E === "1";

  // Background running summary of the live call — read instantly by the hotkey
  // one-shot. Skip the model machinery in mock/E2E runs.
  const summaryKeeper: SummaryKeeper | null =
    usingMockAgent || isE2E
      ? null
      : createSummaryKeeper(setup, (s) => debugLog?.write("summary-update", { summary: s }));

  let state: SessionState = "starting";
  // Which leg failed, if any — surfaced to analytics via onStateChange so a
  // failed call is categorized (tap / deepgram / relay-token / agent) rather
  // than landing in one undifferentiated "error" bucket. Metadata only.
  let errorStage: string | null = null;
  let logPath: string | null = null;
  let sidecar: SidecarHandle | null = null;
  let transcription: TranscriptionHandle | null = null;
  let agent: Agent | null = null;
  // Timestamp of the most recent audio frame / utterance. Drives the "No audio"
  // status indicator; never ends the session.
  let lastAudioAt = Date.now();
  // Per-leg liveness, so a dead mic can't hide behind live tap frames: the tap
  // stream keeps `lastAudioAt` fresh (masking a silent "me" leg from the overall
  // no-audio check), so track the mic and tap separately.
  let lastMicFrameAt = Date.now();
  let lastTapFrameAt = Date.now();
  let micDead = false;
  // Whether Deepgram is currently mid-reconnect, so "open" after a drop reads as
  // a recovery (not the initial connect). NOTE: this is a single latch across
  // BOTH sockets (mic + tap). If both legs drop, the first to reopen clears it
  // and emits "recovered" while the other may still be down — acceptable for a
  // coarse transport-health signal (recovered can slightly lead full recovery).
  let dgDisconnected = false;
  // Symmetric to micDead: the tap (them) leg went silent while the mic stayed
  // live — the exact blind spot where a call reads healthy but we captured none
  // of the other party. `themSilentSeen` is a whole-call "ever" aggregate for
  // call_ended (§7.1); `tapDead` keeps the per-tick detection from re-firing.
  let tapDead = false;
  let themSilentSeen = false;
  // Whole-call "ever" telemetry flags for call_ended. The USER-FACING status is
  // unified ("reconnecting-audio"), but call_ended keeps per-cause granularity, so
  // these track the cause independently of what the overlay shows. micSilentSeen =
  // the mic leg went all-zero (permission/muted) or dead (no frames); noAudioSeen =
  // both legs stopped delivering frames at once.
  let micSilentSeen = false;
  let noAudioSeen = false;
  // Count of sidecar auto-restarts during this call (from its "restart" control
  // event). The give-up-after-N bug used to vanish; make it a number.
  let sidecarRestarts = 0;
  // Tap-frame watchdog activity during this call (from the sidecar's tap_recovered
  // / tap_silent{gave_up} control events). `tapRebuilds` sums how many rebuilds the
  // watchdog needed to recover the "them" leg — a nonzero count on many calls means
  // the tap keeps thrashing (e.g. the SR-change rebuild storm) even if it recovers.
  // `tapGaveUp` is the watchdog exhausting its retries: a real them-blackout.
  let tapRebuilds = 0;
  let tapGaveUp = false;
  let ended = false;

  // ---- Status (overlay health dot) ----
  let currentStatus: SessionStatus = "starting";
  let lastPulseEmit = 0;
  let noAudioTimer: NodeJS.Timeout | null = null;
  const noAudioMs =
    Number(process.env.PROMPTY_NO_AUDIO_MS) > 0
      ? Number(process.env.PROMPTY_NO_AUDIO_MS)
      : DEFAULT_NO_AUDIO_MS;
  const micDeadMs =
    Number(process.env.PROMPTY_MIC_DEAD_MS) > 0
      ? Number(process.env.PROMPTY_MIC_DEAD_MS)
      : DEFAULT_MIC_DEAD_MS;

  const emitStatus = (s: SessionStatus, audioPulse?: boolean, reason?: string) => {
    // Log transitions only — "listening" pulses fire every ~300ms and would
    // flood the debug log with no added signal.
    if (s !== currentStatus) debugLog?.write("status", { status: s, reason });
    currentStatus = s;
    opts.onStatus?.({ state: s, audioPulse, reason });
  };

  // ---- Mic silence detection ----
  // macOS can report microphone permission as "granted" yet feed a
  // separately-signed helper (our Swift sidecar) all-zero buffers — the session
  // looks healthy ("listening") while Deepgram receives digital silence and
  // never returns transcripts, so no nudges ever fire. A real microphone always
  // carries a non-zero noise floor, so a sustained run of exactly-zero PCM at
  // the start of a session is an unambiguous signal that the sidecar isn't
  // getting real audio (permission not effective, wrong/muted input device).
  const MIC_SILENCE_REASON =
    "No audio is reaching the mic. Make sure Ruby is allowed under System Settings → Privacy & Security → Microphone, then restart the call.";
  const micSilence = createMicSilenceDetector();
  const inspectMicChunk = (chunk: Buffer) => {
    if (micSilence.inspect(chunk)) {
      micSilentSeen = true;
      console.error(`[coach-session] mic silent — ${MIC_SILENCE_REASON}`);
      emitStatus("mic-silent", false, MIC_SILENCE_REASON);
    }
  };

  // Tap (them / system-audio) silence detector. Catches the case the mic
  // detector and the frame-arrival triggers can't: a tap that stays healthy and
  // keeps delivering frames but carries only bit-exact zero the whole call
  // (system-audio capture denied — missing process-tap TCC grant). Finalised
  // into themSilentSeen at call end (handle.end). See them-silence.ts.
  const themSilence = createThemSilenceDetector();

  // Called on every audio frame / utterance: flips to "listening" and pulses.
  const markAudio = () => {
    lastAudioAt = Date.now();
    // Keep a capture problem sticky — don't let one live leg flip the dot back to
    // "listening" while the other is down. Mic silent/dead = the user's own voice
    // isn't captured; tapDead = the far side isn't. The frame handler that cleared
    // the relevant flag (onMicFrame/onTapFrame) runs markAudio() right after, so
    // recovery flips back to "listening" on the very next good frame.
    if (micSilence.isSilent() || micDead || tapDead) return;
    const now = Date.now();
    if (currentStatus !== "listening" || now - lastPulseEmit >= 300) {
      lastPulseEmit = now;
      emitStatus("listening", true);
    }
  };
  // Unified transient-loss message. A device flip rebuilds BOTH the mic and tap
  // graphs together, so any one leg (or both) going stale is really "audio is
  // reconnecting" — one calm state, no user action (none helps; it self-heals when
  // frames resume). Not a device-fiddling instruction: switching devices mid-rebuild
  // can re-trigger the churn. Clears on the next good frame (onMicFrame/onTapFrame).
  const RECONNECTING_AUDIO_REASON = "Reconnecting audio…";
  // Escalation for the one leg that CAN report giving up: the tap watchdog. Then it
  // is a real failure worth the one reliable remedy (restart), not a workaround.
  const THEM_LOST_REASON =
    "Couldn't capture the other side's audio — end and restart the call.";
  // Terminal transport failure (the sidecar died, or Deepgram gave up after its
  // retries). The precise cause stays in errorStage → telemetry/logs; the user
  // only needs the one reliable remedy, in plain language (no internal names).
  const TRANSPORT_ERROR_REASON =
    "Something went wrong with the call — end and restart it.";
  // Per-leg frame handlers: update liveness, run mic-silence inspection, pulse.
  const onMicFrame = (chunk: Buffer) => {
    lastMicFrameAt = Date.now();
    // Mic frames are flowing again — clear the dead flag (the all-zero case is
    // still caught by the silence detector).
    if (micDead) micDead = false;
    inspectMicChunk(chunk);
    markAudio();
  };
  const onTapFrame = (chunk: Buffer) => {
    lastTapFrameAt = Date.now();
    if (tapDead) tapDead = false;
    themSilence.inspect(chunk);
    markAudio();
  };
  const onTransportError = (reason: string) => {
    if (ended) return;
    // `reason` is the internal label (e.g. "sidecar", "deepgram error"): kept in
    // errorStage for telemetry + logs. The overlay gets a plain, generic message —
    // never the internal name.
    errorStage = reason;
    console.error(`[coach-session] transport error: ${reason}`);
    emitStatus("error", undefined, TRANSPORT_ERROR_REASON);
  };
  // Deepgram connection transitions (fed to startTranscription's onStatus, and
  // driven directly by the simulateDeepgramStatus test seam). "reconnecting" is
  // transient (a socket dropped and we're re-opening); "error" is terminal (only
  // after reconnect attempts are exhausted). The dgDisconnected latch turns a
  // drop → one "disconnected" and the following "open" → "recovered", while the
  // initial connect's "open" is NOT a recovery.
  const handleDeepgramStatus = (s: DeepgramConnStatus) => {
    if (s === "reconnecting") {
      if (!dgDisconnected) {
        dgDisconnected = true;
        opts.onDeepgramConnection?.("disconnected");
      }
      if (currentStatus !== "error" && !micSilence.isSilent()) {
        emitStatus("reconnecting", false, "Reconnecting to transcription…");
      }
    } else if (s === "open") {
      if (dgDisconnected) {
        dgDisconnected = false;
        opts.onDeepgramConnection?.("recovered");
      }
    } else if (s === "error") {
      onTransportError("deepgram error");
    }
  };
  emitStatus("starting");

  const setState = (s: SessionState) => {
    state = s;
    opts.onStateChange?.(s, errorStage);
  };

  // Auto-considers fire on every final utterance, but the agent processes one
  // turn at a time. Without coalescing, fast speech piles up a backlog that a
  // hotkey-triggered consider would have to wait behind. Keep at most one
  // auto-consider in flight and at most one queued; the queued run always uses
  // the freshest window, so dropping intermediate ones loses nothing.
  let autoConsiderInFlight = false;
  let autoConsiderPending = false;

  // Idle tracking — lets a caller (the replay harness) await a settled turn.
  // "Busy" = an auto-consider is running or queued, or a hotkey answer is in
  // flight. settleIdle() drains the waiters the instant nothing is busy.
  let hotkeyInFlight = false;
  let idleWaiters: Array<() => void> = [];
  const isBusy = () =>
    autoConsiderInFlight || autoConsiderPending || hotkeyInFlight;
  const settleIdle = () => {
    if (isBusy()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  };

  const runAutoConsider = () => {
    if (!agent) return;
    if (autoConsiderInFlight) {
      autoConsiderPending = true;
      return;
    }
    autoConsiderInFlight = true;
    void agent
      .consider([...considerWindow], "auto")
      .catch((e) => {
        console.error("[coach-session] consider error:", (e as Error).message);
      })
      .finally(() => {
        autoConsiderInFlight = false;
        if (autoConsiderPending) {
          autoConsiderPending = false;
          runAutoConsider();
        }
        settleIdle();
      });
  };

  const handleUtterance = (u: TranscriptUtterance) => {
    markAudio();
    if (u.isFinal) {
      transcript.push(u);
      journal?.appendUtterance(u);
      debugLog?.write("utterance", { ...u });
      opts.onUtterance?.(u);
    } else {
      debugLog?.write("interim", { ...u });
    }
    considerWindow.push(u);
    while (considerWindow.length > CONSIDER_WINDOW) considerWindow.shift();
    if (u.isFinal) {
      summaryKeeper?.note(transcript);
      runAutoConsider();
    }
  };

  // ---- Deepgram key ----
  // Resolve up-front, before spawning the sidecar, so an unobtainable key (not
  // signed in, mint failure, missing dev key) fails the session start cleanly
  // (throws out of startSession → surfaced by the IPC layer) instead of leaving
  // an orphaned sidecar and a silent overlay. The same provider is then handed
  // to startTranscription, which re-invokes it on every (re)connect.
  const getDeepgramKey = makeDeepgramKeyProvider(usingMockDeepgram);
  if (!usingMockDeepgram) {
    try {
      await getDeepgramKey();
    } catch (e) {
      const raw = (e as Error).message;
      // A dead/expired Google session surfaces here as a raw relay/OAuth string
      // ("not signed in…", "invalid_grant", "…refresh token revoked"). Show the
      // user a plain, actionable re-auth message instead of the internal error.
      const isAuth = /not signed in|invalid_grant|revoked|sign in with google/i.test(raw);
      throw new Error(
        isAuth
          ? "You've been signed out — open Ruby and sign in again to start calls."
          : `Couldn't get a transcription key: ${raw}`,
      );
    }
  }

  // ---- Sidecar ----
  if (!usingMockAudio) {
    try {
      sidecar = spawnSidecar({});
      sidecar.controlEvents.on("control", (ev) => {
        console.log(`[sidecar control] ${JSON.stringify(ev)}`);
        if (ev?.type === "ready") {
          opts.onAudioInfo?.({
            inputTransport:
              typeof ev.inputTransport === "string" ? ev.inputTransport : null,
          });
        }
        if (ev?.type === "restart") sidecarRestarts++;
        if (ev?.type === "error") onTransportError("sidecar");
        // Tap-frame watchdog (§Phase 6 gap). The sidecar emits these; before this
        // they were logged and dropped. "recovered" carries the rebuild count for
        // the episode; a "tap_silent" with action:"gave_up" is a real them-blackout.
        if (ev?.type === "tap_recovered") {
          const n = typeof ev.rebuilds === "number" ? ev.rebuilds : 1;
          tapRebuilds += n;
          opts.onTapWatchdog?.({ kind: "recovered", rebuilds: n });
        }
        if (ev?.type === "tap_silent" && ev.action === "gave_up") {
          tapGaveUp = true;
          themSilentSeen = true;
          tapDead = true; // keep the status sticky until real tap frames resume
          opts.onTapWatchdog?.({
            kind: "gave_up",
            attempt: typeof ev.attempt === "number" ? ev.attempt : undefined,
          });
          // Escalate from the calm "reconnecting" to an honest failure the user
          // can act on. Clears when tap frames resume (onTapFrame → markAudio).
          emitStatus("them-lost", false, THEM_LOST_REASON);
        }
      });
    } catch (e) {
      console.error("[coach-session] sidecar spawn failed:", (e as Error).message);
    }
  }

  // ---- Deepgram (only if sidecar) ----
  if (sidecar) {
    try {
      transcription = startTranscription({
        micStream: sidecar.micStream,
        tapStream: sidecar.tapStream,
        getKey: getDeepgramKey,
        onUtterance: handleUtterance,
        onError: (e) => {
          console.error("[coach-session] dg error:", e.message);
        },
        onStatus: handleDeepgramStatus,
      });
    } catch (e) {
      console.error(
        "[coach-session] deepgram start failed:",
        (e as Error).message,
      );
    }
  }

  // ---- Agent ----
  const agentFactory = opts.agentFactory ?? (usingMockAgent ? createMockAgent : openAgent);
  try {
    agent = await agentFactory(setup, {
      onNudge: (n) => {
        nudges.push(n);
        journal?.appendNudge(n);
        debugLog?.write("nudge", { nudge: n });
        console.log(`[coach-session nudge ${n.urgency}] ${n.text}`);
        opts.onNudge?.(n);
      },
      onStayQuiet: (reason) => {
        console.log(`[coach-session quiet] ${reason}`);
        opts.onStayQuiet?.(reason);
      },
      onItemCovered: (itemId) => markChecklistItemCovered(setup, itemId),
      onError: (e) => {
        errorStage = errorStage ?? "agent";
        console.error(`[coach-session agent error] ${e.message}`);
        debugLog?.write("error", { where: "agent", message: e.message, stack: e.stack });
        opts.onError?.(e);
      },
      onDebug: (turn) => debugLog?.write("agent-turn", { ...turn }),
    });
  } catch (e) {
    errorStage = errorStage ?? "agent";
    setState("error");
    if (sidecar) sidecar.kill();
    if (transcription) await transcription.close();
    opts.onError?.(e as Error);
    throw e;
  }

  // ---- Audio-flow tracking ----
  // Track when audio last arrived to drive the "No audio" status. This
  // intentionally does NOT end the session — session end is fully manual
  // (overlay/tray "End session").
  if (sidecar) {
    sidecar.micStream.on("data", onMicFrame);
    sidecar.tapStream.on("data", onTapFrame);
  }
  // Flip to "reconnecting-audio" after a gap with no frames/utterances. Period is a
  // fraction of the threshold so the transition is timely (and fast in tests).
  const noAudioPeriod = Math.max(200, Math.min(2000, Math.floor(noAudioMs / 2)));
  noAudioTimer = setInterval(() => {
    if (ended || currentStatus === "error") return;
    const now = Date.now();
    if (now - lastAudioAt > noAudioMs) {
      // No frames from EITHER leg — both capture graphs are down/rebuilding.
      noAudioSeen = true;
      if (currentStatus !== "reconnecting-audio") {
        emitStatus("reconnecting-audio", false, RECONNECTING_AUDIO_REASON);
      }
      return;
    }
    // Per-leg liveness only means something when real streams feed
    // onMicFrame/onTapFrame. Without a sidecar (mock audio) the per-leg
    // timestamps never advance, so a call kept audio-fresh by injected
    // utterances would spuriously read both legs "stale" — guard on the sidecar.
    if (sidecar) {
      // Mic dead while the tap is still live: the "me" leg produced no frames for
      // a while but "them" is flowing (so the both-legs check above never trips).
      // This is a transient rebuild, not the all-zero permission case — surface it
      // as the unified "reconnecting audio" (it self-heals when frames resume).
      const tapAlive = now - lastTapFrameAt < noAudioMs;
      const micStale = now - lastMicFrameAt > micDeadMs;
      if (
        tapAlive &&
        micStale &&
        !micDead &&
        !micSilence.isSilent() &&
        currentStatus !== "reconnecting-audio"
      ) {
        micDead = true;
        micSilentSeen = true;
        console.error("[coach-session] mic leg stale — reconnecting");
        emitStatus("reconnecting-audio", false, RECONNECTING_AUDIO_REASON);
      }
      // The mirror case: the tap (them) leg produced no frames while the mic is
      // still live — recorded for call_ended (them_silent_seen) AND surfaced as the
      // same unified reconnecting state. The 6s micDeadMs threshold means a blip the
      // watchdog self-heals in ~1s never surfaces — only sustained loss. If the
      // watchdog later GIVES UP, the control handler escalates this to "them-lost".
      const micAlive = now - lastMicFrameAt < noAudioMs;
      const tapStale = now - lastTapFrameAt > micDeadMs;
      if (micAlive && tapStale && !tapDead) {
        tapDead = true;
        themSilentSeen = true;
        console.error("[coach-session] them/tap leg silent — reconnecting");
        emitStatus("reconnecting-audio", false, RECONNECTING_AUDIO_REASON);
      }
    }
  }, noAudioPeriod);

  setState("live");

  const handle: SessionHandle = {
    async end(_reason: EndReason = "user", endOpts: { background?: boolean } = {}) {
      if (ended) return;
      ended = true;
      if (noAudioTimer) clearInterval(noAudioTimer);
      // Finalise the far-side silence signal: if the tap produced a meaningful
      // run of frames but never a single non-zero sample, "them" was digital
      // silence end-to-end — capture was effectively dead even though the graph
      // looked healthy (frames kept arriving). Distinct from, and complementary
      // to, the frame-starvation / watchdog triggers that set this flag mid-call.
      if (themSilence.wasSilentAllCall()) themSilentSeen = true;
      setState("ending");

      // ---- Phase A: fast teardown + persist ----
      // Stop audio/transcription/agent and write the call log *without* the
      // summary, then flip to "ended" so the overlay hides and the UI returns to
      // rest at once. The summary (a multi-second model pass) happens in Phase B.
      try {
        if (transcription) await transcription.close();
      } catch (e) {
        console.error(
          "[coach-session] transcription close error:",
          (e as Error).message,
        );
      }
      try {
        if (sidecar) sidecar.kill();
      } catch (e) {
        console.error("[coach-session] sidecar kill error:", (e as Error).message);
      }
      try {
        await agent?.close();
      } catch (e) {
        console.error("[coach-session] agent close error:", (e as Error).message);
      }

      const willSummarize =
        process.env.PROMPTY_E2E !== "1" && transcript.length > 0;
      try {
        logPath = await writeCallLog({
          direction: setup.direction,
          skill: setup.skill,
          title: deriveCallTitle(undefined, undefined, setup.direction),
          transcript,
          nudges,
          components: setup.components,
          startedAt,
          endedAt: Date.now(),
          summary: undefined,
          summaryPending: willSummarize,
        });
        console.log("[coach-session] log written to", logPath);
        // Consolidated log is safe — drop the crash journal. Kept on failure
        // so the next launch's recovery can still salvage the call.
        journal?.delete();
      } catch (e) {
        console.error("[coach-session] write log failed:", (e as Error).message);
      }
      setState("ended");

      // ---- Phase B: summarize, patch the saved log, then notify ----
      // Backgrounded by default (ending feels instant); awaited on the quit path
      // so the process doesn't exit mid-summary.
      const finalize = async () => {
        let summary: import("./summary").CallSummary | undefined;
        if (willSummarize) {
          try {
            const { summarizeCall } = await import("./summary");
            const s = await summarizeCall(setup, transcript, nudges, startedAt);
            if (s) summary = s;
          } catch (e) {
            console.error("[coach-session] summarize failed:", (e as Error).message);
          }
          if (logPath) {
            try {
              updateCallLogSummary(logPath, summary);
            } catch (e) {
              console.error("[coach-session] patch log failed:", (e as Error).message);
            }
          }
        }
        debugLog?.write("session-end", { endedAt: Date.now(), summary });
        closeDebug();
        if (logPath && process.env.PROMPTY_E2E !== "1") {
          try {
            const n = new Notification({
              title: "Call saved",
              body: "Click to open your call notes.",
            });
            n.on("click", () => {
              try {
                shell.showItemInFolder(logPath!);
              } catch {}
            });
            n.show();
          } catch {}
        }
        opts.onSummaryReady?.(logPath, summary);
      };

      if (endOpts.background === false) await finalize();
      else void finalize();
    },
    injectUtterance(u) {
      handleUtterance(u);
    },
    requestNudge() {
      if (!agent) return;
      // Mock/E2E: keep the canned consider("hotkey") path the tests assert on.
      if (usingMockAgent || isE2E) {
        void agent.consider([...considerWindow], "hotkey").catch((e) => {
          console.error("[coach-session] hotkey consider error:", (e as Error).message);
        });
        return;
      }
      // Real path: dedicated one-shot over the full live context, so the answer
      // lands this turn instead of a turn late via the persistent session.
      const recent = transcript.slice(-60);
      const recentNudges = nudges.slice(-5).map((n) => n.text);
      let hotkeyDbg: import("./answer").AnswerDebug | null = null;
      hotkeyInFlight = true;
      void answerNow({
        setup,
        summary: summaryKeeper?.current() ?? "",
        recent,
        recentNudges,
        onDebug: (d) => {
          hotkeyDbg = d;
        },
      })
        .then((n) => {
          // Record the hotkey turn as an agent-turn (trigger:"hotkey"), with
          // nudgeFired reflecting whether a usable line came back.
          if (hotkeyDbg) {
            debugLog?.write("agent-turn", {
              trigger: "hotkey",
              context: hotkeyDbg.context,
              systemPrompt: hotkeyDbg.systemPrompt,
              assistantText: hotkeyDbg.rawResponse,
              toolCalls: [],
              decision: "answer",
              nudgeFired: !!n,
              latencyMs: hotkeyDbg.latencyMs,
            });
          }
          if (!n) return;
          nudges.push(n);
          journal?.appendNudge(n);
          debugLog?.write("nudge", { nudge: n });
          console.log(`[coach-session nudge ${n.urgency}] ${n.text}`);
          opts.onNudge?.(n);
        })
        .catch((e) => {
          console.error("[coach-session] hotkey answer error:", (e as Error).message);
          debugLog?.write("error", { where: "hotkey", message: (e as Error).message });
        })
        .finally(() => {
          hotkeyInFlight = false;
          settleIdle();
        });
    },
    waitIdle() {
      if (!isBusy()) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    setDebug(enabled) {
      if (enabled) openDebug();
      else closeDebug();
    },
    simulateTransportError(reason) {
      onTransportError(reason ?? "simulated");
    },
    simulateThemSilent() {
      themSilentSeen = true;
    },
    simulateSidecarRestart() {
      sidecarRestarts++;
    },
    simulateTapWatchdog(ev) {
      if (ev.kind === "recovered") {
        const n = typeof ev.rebuilds === "number" ? ev.rebuilds : 1;
        tapRebuilds += n;
        opts.onTapWatchdog?.({ kind: "recovered", rebuilds: n });
      } else {
        tapGaveUp = true;
        opts.onTapWatchdog?.({ kind: "gave_up", attempt: ev.attempt });
      }
    },
    simulateDeepgramStatus(s) {
      handleDeepgramStatus(s);
    },
    getNudges() {
      return [...nudges];
    },
    getTranscript() {
      return [...transcript];
    },
    getThemSilentSeen() {
      return themSilentSeen;
    },
    getMicSilentSeen() {
      return micSilentSeen;
    },
    getNoAudioSeen() {
      return noAudioSeen;
    },
    getSidecarRestarts() {
      return sidecarRestarts;
    },
    getTapRebuilds() {
      return tapRebuilds;
    },
    getTapGaveUp() {
      return tapGaveUp;
    },
    getSetup() {
      return setup;
    },
    getState() {
      return state;
    },
    getLogPath() {
      return logPath;
    },
  };
  return handle;
}
