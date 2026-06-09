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
import { writeCallLog } from "./call-log";
import { openJournal, type JournalHandle } from "./journal";
import { spawnSidecar, type SidecarHandle } from "./sidecar";
import { startTranscription, type TranscriptionHandle } from "./deepgram";
import { getDeepgramToken } from "./relay-client";
import type {
  CallSetup,
  ChecklistItem,
  Nudge,
  TranscriptUtterance,
  SessionStatus,
  SessionStatusEvent,
} from "./types";

export type SessionState = "starting" | "live" | "ending" | "ended" | "error";
export type EndReason = "user" | "error";

/** Default ms of audio silence before the status flips to "no-audio". */
const DEFAULT_NO_AUDIO_MS = 10_000;

export interface SessionOpts {
  onUtterance?: (u: TranscriptUtterance) => void;
  onNudge?: (n: Nudge) => void;
  onChecklistUpdate?: (id: string, status: ChecklistItem["status"]) => void;
  onStateChange?: (state: SessionState) => void;
  /** Live audio/transcription health for the overlay status dot. */
  onStatus?: (s: SessionStatusEvent) => void;
  onError?: (e: Error) => void;
  /** Override mock-flag detection (mostly for tests). */
  mockAudio?: boolean;
  mockDeepgram?: boolean;
  /** Mocked agent factory — primarily for E2E. */
  agentFactory?: (setup: CallSetup, events: Parameters<typeof openAgent>[1]) => Promise<Agent>;
}

export interface SessionHandle {
  end(reason?: EndReason): Promise<void>;
  setChecklist(id: string, status: ChecklistItem["status"]): void;
  injectUtterance(u: TranscriptUtterance): void;
  /** Manually request a nudge from the agent — used by the hotkey. */
  requestNudge(): void;
  /** Force an "error" status — used by E2E to verify the status wiring. */
  simulateTransportError(reason?: string): void;
  getNudges(): Nudge[];
  getTranscript(): TranscriptUtterance[];
  getSetup(): CallSetup;
  getState(): SessionState;
  /** Resolved log path once end() completes. */
  getLogPath(): string | null;
}

/**
 * Mock agent — used in E2E mode (PROMPTY_MOCK_AGENT=1) and as a stub in
 * smoke tests. Emits a canned nudge each `consider()` call.
 */
export function createMockAgent(
  _setup: CallSetup,
  events: Parameters<typeof openAgent>[1],
): Promise<Agent> {
  let counter = 0;
  return Promise.resolve({
    async consider(_window, trigger) {
      counter++;
      events.onNudge({
        id: `mock-${counter}-${Date.now()}`,
        kind: trigger === "hotkey" ? "answer" : "fact-reminder",
        text: `Mock nudge ${counter} (trigger=${trigger})`,
        urgency: "medium",
        createdAt: Date.now(),
      });
    },
    noteChecklistChange(itemId, status, _itemText) {
      events.onChecklistUpdate(itemId, status);
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
  const startedAt = Date.now();
  const transcript: TranscriptUtterance[] = [];
  const nudges: Nudge[] = [];
  // Crash-safe append-as-you-go journal; recovered on next launch if we crash
  // before end() writes the consolidated log.
  const journal: JournalHandle | null = openJournal(setup, startedAt);
  const considerWindow: TranscriptUtterance[] = [];

  const usingMockAudio = opts.mockAudio ?? process.env.PROMPTY_MOCK_AUDIO === "1";
  const usingMockDeepgram =
    opts.mockDeepgram ?? process.env.PROMPTY_MOCK_DEEPGRAM === "1";
  const usingMockAgent = process.env.PROMPTY_MOCK_AGENT === "1";

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
    currentStatus = s;
    opts.onStatus?.({ state: s, audioPulse, reason });
  };
  // Called on every audio frame / utterance: flips to "listening" and pulses.
  const markAudio = () => {
    lastAudioAt = Date.now();
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

  const handleUtterance = (u: TranscriptUtterance) => {
    markAudio();
    if (u.isFinal) {
      transcript.push(u);
      journal?.appendUtterance(u);
      opts.onUtterance?.(u);
    }
    considerWindow.push(u);
    while (considerWindow.length > 12) considerWindow.shift();
    if (u.isFinal && agent) {
      void agent.consider([...considerWindow], "auto").catch((e) => {
        console.error("[coach-session] consider error:", (e as Error).message);
      });
    }
  };

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
      const deepgramKey = usingMockDeepgram ? "mock" : await getDeepgramToken();
      transcription = startTranscription({
        micStream: sidecar.micStream,
        tapStream: sidecar.tapStream,
        deepgramKey,
        onUtterance: handleUtterance,
        onError: (e) => {
          console.error("[coach-session] dg error:", e.message);
        },
        onStatus: (s) => {
          if (s === "error" || s === "reconnecting") {
            onTransportError(`deepgram ${s}`);
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
        console.log(`[coach-session nudge ${n.kind}/${n.urgency}] ${n.text}`);
        opts.onNudge?.(n);
      },
      onChecklistUpdate: (id, status) => {
        const item = setup.checklist.find((c) => c.id === id);
        if (item) item.status = status;
        console.log(`[coach-session checklist] ${id} → ${status}`);
        opts.onChecklistUpdate?.(id, status);
      },
      onStayQuiet: (reason) => {
        console.log(`[coach-session quiet] ${reason}`);
      },
      onError: (e) => {
        console.error(`[coach-session agent error] ${e.message}`);
        opts.onError?.(e);
      },
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
    async end(_reason = "user") {
      if (ended) return;
      ended = true;
      if (noAudioTimer) clearInterval(noAudioTimer);
      setState("ending");
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
      let summary: import("./summary").CallSummary | undefined;
      if (process.env.PROMPTY_E2E !== "1" && transcript.length > 0) {
        try {
          const { summarizeCall } = await import("./summary");
          const s = await summarizeCall(setup, transcript);
          if (s) summary = s;
        } catch (e) {
          console.error("[coach-session] summarize failed:", (e as Error).message);
        }
      }
      try {
        logPath = await writeCallLog({
          goal: setup.goal,
          mode: setup.mode,
          checklist: setup.checklist,
          transcript,
          nudges,
          attendee: setup.context.attendee,
          startedAt,
          endedAt: Date.now(),
          summary,
        });
        console.log("[coach-session] log written to", logPath);
        // Consolidated log is safe — drop the crash journal. Kept on failure
        // so the next launch's recovery can still salvage the call.
        journal?.delete();
      } catch (e) {
        console.error("[coach-session] write log failed:", (e as Error).message);
      }
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
      setState("ended");
    },
    setChecklist(id, status) {
      const item = setup.checklist.find((c) => c.id === id);
      if (!item) return;
      item.status = status;
      agent?.noteChecklistChange(id, status, item.text);
    },
    injectUtterance(u) {
      handleUtterance(u);
    },
    requestNudge() {
      if (!agent) return;
      void agent.consider([...considerWindow], "hotkey").catch((e) => {
        console.error("[coach-session] hotkey consider error:", (e as Error).message);
      });
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
