import { describe, it, expect } from "vitest";
import { shouldAutoApply, IDLE_THRESHOLD_SECONDS, type AutoApplyState } from "../../electron/updater-policy";

// A state that WOULD auto-apply; each test flips one field to prove the gate.
const ready: AutoApplyState = {
  downloaded: true,
  enabled: true,
  callActive: false,
  idleSeconds: IDLE_THRESHOLD_SECONDS,
  idleThresholdSeconds: IDLE_THRESHOLD_SECONDS,
};

describe("shouldAutoApply", () => {
  it("applies when opted in, staged, idle, and off any call", () => {
    expect(shouldAutoApply(ready)).toBe(true);
    // Comfortably past the threshold too.
    expect(shouldAutoApply({ ...ready, idleSeconds: IDLE_THRESHOLD_SECONDS + 999 })).toBe(true);
  });

  it("NEVER applies during a call — the hard safety invariant", () => {
    expect(shouldAutoApply({ ...ready, callActive: true })).toBe(false);
    // Even wildly idle, a live call still blocks it.
    expect(shouldAutoApply({ ...ready, callActive: true, idleSeconds: 10 ** 6 })).toBe(false);
  });

  it("does not apply unless the user opted in", () => {
    expect(shouldAutoApply({ ...ready, enabled: false })).toBe(false);
  });

  it("does not apply until idle past the threshold", () => {
    expect(shouldAutoApply({ ...ready, idleSeconds: IDLE_THRESHOLD_SECONDS - 1 })).toBe(false);
    expect(shouldAutoApply({ ...ready, idleSeconds: 0 })).toBe(false);
  });

  it("does not apply when nothing is staged", () => {
    expect(shouldAutoApply({ ...ready, downloaded: false })).toBe(false);
  });

  it("requires ALL gates — no single condition is sufficient", () => {
    expect(shouldAutoApply({ downloaded: false, enabled: false, callActive: true, idleSeconds: 0, idleThresholdSeconds: IDLE_THRESHOLD_SECONDS })).toBe(false);
  });

  // Added by independent verifier: exhaustively sweep the full boolean cube plus
  // idle boundaries and assert the two hard invariants hold in EVERY combination:
  //   (1) a live call ALWAYS blocks a silent apply, and
  //   (2) opting out (enabled=false) ALWAYS blocks a silent apply.
  it("exhaustive: callActive OR opted-out blocks apply in every combination", () => {
    const idleValues = [0, IDLE_THRESHOLD_SECONDS - 1, IDLE_THRESHOLD_SECONDS, IDLE_THRESHOLD_SECONDS + 10 ** 6];
    for (const downloaded of [true, false]) {
      for (const enabled of [true, false]) {
        for (const callActive of [true, false]) {
          for (const idleSeconds of idleValues) {
            const result = shouldAutoApply({ downloaded, enabled, callActive, idleSeconds, idleThresholdSeconds: IDLE_THRESHOLD_SECONDS });
            if (callActive) expect(result, `callActive must block: ${JSON.stringify({ downloaded, enabled, idleSeconds })}`).toBe(false);
            if (!enabled) expect(result, `opt-out must block: ${JSON.stringify({ downloaded, callActive, idleSeconds })}`).toBe(false);
            // Sanity: the ONLY combination that applies is the fully-satisfied one.
            const expected = downloaded && enabled && !callActive && idleSeconds >= IDLE_THRESHOLD_SECONDS;
            expect(result).toBe(expected);
          }
        }
      }
    }
  });
});
