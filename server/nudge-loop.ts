import type { Agent } from "./agent.ts";
import type { TranscriptUtterance } from "./types.ts";

/**
 * Debounces transcript deltas and feeds windows to the agent.
 *
 * Triggers when EITHER condition fires:
 *   - silence for `silenceMs` (no new final utterance recently)
 *   - `maxSpeechMs` elapsed since last consider, regardless of silence
 *
 * Also exposes `requestImmediate()` for hotkey-triggered nudges.
 */
export type NudgeLoop = {
  pushUtterance(u: TranscriptUtterance): void;
  requestImmediate(): Promise<void>;
  stop(): void;
};

export type NudgeLoopOptions = {
  silenceMs?: number;
  maxSpeechMs?: number;
  /** Window size (recent utterances) sent to the agent. */
  windowSize?: number;
};

export function startNudgeLoop(
  agent: Agent,
  opts: NudgeLoopOptions = {},
): NudgeLoop {
  const silenceMs = opts.silenceMs ?? 3000;
  const maxSpeechMs = opts.maxSpeechMs ?? 15000;
  const windowSize = opts.windowSize ?? 12;

  const buffer: TranscriptUtterance[] = [];
  let lastFinalAt = 0;
  let lastConsiderAt = Date.now();
  let silenceTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const fire = async (trigger: "auto" | "hotkey") => {
    if (stopped) return;
    if (buffer.length === 0 && trigger === "auto") return;
    // Coalesce: if a turn is already in flight, queue at most one follow-up.
    if (inFlight) {
      await inFlight;
      if (stopped) return;
    }
    const window = buffer.slice(-windowSize);
    lastConsiderAt = Date.now();
    inFlight = agent.consider(window, trigger).finally(() => {
      inFlight = null;
    });
    await inFlight;
  };

  const schedule = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (stopped) return;
    silenceTimer = setTimeout(() => {
      void fire("auto");
    }, silenceMs);
  };

  const speechWatcher = setInterval(() => {
    if (stopped) return;
    if (Date.now() - lastConsiderAt > maxSpeechMs && buffer.length > 0) {
      void fire("auto");
    }
  }, 1000);

  return {
    pushUtterance(u) {
      if (!u.isFinal) return; // only act on final utterances
      buffer.push(u);
      lastFinalAt = Date.now();
      void lastFinalAt;
      schedule();
    },
    async requestImmediate() {
      if (silenceTimer) clearTimeout(silenceTimer);
      await fire("hotkey");
    },
    stop() {
      stopped = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      clearInterval(speechWatcher);
    },
  };
}
