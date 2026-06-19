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
import { startTranscription, type TranscriptionHandle } from "./deepgram";
import { getDeepgramToken } from "./relay-client";
import { createMicSilenceDetector } from "./mic-silence";
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

/** Default ms of audio silence before the status flips to "no-audio". */
const DEFAULT_NO_AUDIO_MS = 10_000;

export interface SessionOpts {
  onUtterance?: (u: TranscriptUtterance) => void;
  onNudge?: (n: Nudge) => void;
  /** The agent decided not to nudge this turn, with its reason. */
  onStayQuiet?: (reason: string) => void;
  onStateChange?: (state: SessionState) => void;
  /** Live audio/transcription health for the overlay status dot. */
  onStatus?: (s: SessionStatusEvent) => void;
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
  getNudges(): Nudge[];
  getTranscript(): TranscriptUtterance[];
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
  let logPath: string | null = null;
  let sidecar: SidecarHandle | null = null;
  let transcription: TranscriptionHandle | null = null;
  let agent: Agent | null = null;
  // Timestamp of the most recent audio frame / utterance. Drives the "No audio"
  // status indicator; never ends the session.
  let lastAudioAt = Date.now();
  let ended = false;

  // ---- Status (overlay health dot) ----
  let currentStatus: SessionStatus = "starting";
  let lastPulseEmit = 0;
  let noAudioTimer: NodeJS.Timeout | null = null;
  const noAudioMs =
    Number(process.env.PROMPTY_NO_AUDIO_MS) > 0
      ? Number(process.env.PROMPTY_NO_AUDIO_MS)
      : DEFAULT_NO_AUDIO_MS;

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
    "No audio is reaching the mic. Grant Microphone permission (System Settings → Privacy & Security) and restart. In dev, the packaged app captures audio more reliably than `npm run dev`.";
  const micSilence = createMicSilenceDetector();
  const inspectMicChunk = (chunk: Buffer) => {
    if (micSilence.inspect(chunk)) {
      console.error(`[coach-session] mic silent — ${MIC_SILENCE_REASON}`);
      emitStatus("mic-silent", false, MIC_SILENCE_REASON);
    }
  };

  // Called on every audio frame / utterance: flips to "listening" and pulses.
  const markAudio = () => {
    lastAudioAt = Date.now();
    // Keep the mic-silent warning sticky — frames are arriving, they're just
    // empty, so don't let the steady stream flip the dot back to "listening".
    if (micSilence.isSilent()) return;
    const now = Date.now();
    if (currentStatus !== "listening" || now - lastPulseEmit >= 300) {
      lastPulseEmit = now;
      emitStatus("listening", true);
    }
  };
  const onTransportError = (reason: string) => {
    if (ended) return;
    console.error(`[coach-session] transport error: ${reason}`);
    emitStatus("error", undefined, reason);
  };
  emitStatus("starting");

  const setState = (s: SessionState) => {
    state = s;
    opts.onStateChange?.(s);
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
      throw new Error(
        `Couldn't get a transcription key: ${(e as Error).message}`,
      );
    }
  }

  // ---- Sidecar ----
  if (!usingMockAudio) {
    try {
      sidecar = spawnSidecar({});
      sidecar.controlEvents.on("control", (ev) => {
        console.log(`[sidecar control] ${JSON.stringify(ev)}`);
        if (ev?.type === "error") onTransportError("sidecar");
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
        onStatus: (s) => {
          // "reconnecting" is transient — Deepgram dropped a socket and we're
          // re-opening it. Show the softer "reconnecting" dot rather than a hard
          // error; incoming audio frames flip it back to "listening" on success.
          // "error" is only emitted after reconnect attempts are exhausted.
          if (s === "reconnecting") {
            if (currentStatus !== "error" && !micSilence.isSilent()) {
              emitStatus("reconnecting", false, "Reconnecting to transcription…");
            }
          } else if (s === "error") {
            onTransportError("deepgram error");
          }
        },
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
        console.error(`[coach-session agent error] ${e.message}`);
        debugLog?.write("error", { where: "agent", message: e.message, stack: e.stack });
        opts.onError?.(e);
      },
      onDebug: (turn) => debugLog?.write("agent-turn", { ...turn }),
    });
  } catch (e) {
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
    sidecar.micStream.on("data", markAudio);
    sidecar.micStream.on("data", inspectMicChunk);
    sidecar.tapStream.on("data", markAudio);
  }
  // Flip to "no-audio" after a gap with no frames/utterances. Period is a
  // fraction of the threshold so the transition is timely (and fast in tests).
  const noAudioPeriod = Math.max(200, Math.min(2000, Math.floor(noAudioMs / 2)));
  noAudioTimer = setInterval(() => {
    if (ended || currentStatus === "error") return;
    if (Date.now() - lastAudioAt > noAudioMs && currentStatus !== "no-audio") {
      emitStatus("no-audio");
    }
  }, noAudioPeriod);

  setState("live");

  const handle: SessionHandle = {
    async end(_reason: EndReason = "user", endOpts: { background?: boolean } = {}) {
      if (ended) return;
      ended = true;
      if (noAudioTimer) clearInterval(noAudioTimer);
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
              body: `Click to open ${path.basename(logPath)}`,
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
    getNudges() {
      return [...nudges];
    },
    getTranscript() {
      return [...transcript];
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
