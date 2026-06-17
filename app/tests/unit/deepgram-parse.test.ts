// Unit: the pure Deepgram message→utterance mapping and reconnect backoff
// (deepgram.ts), exercised without a live socket.

import { describe, it, expect } from "vitest";
import { parseDeepgramResult, reconnectDelay } from "../../src/main-process/deepgram";

describe("parseDeepgramResult", () => {
  it("maps a final Results message to a speaker-tagged utterance", () => {
    const u = parseDeepgramResult(
      {
        type: "Results",
        is_final: true,
        start: 1.5,
        duration: 0.5,
        channel: { alternatives: [{ transcript: "hello there" }] },
      },
      "them",
    );
    expect(u).toEqual({
      speaker: "them",
      text: "hello there",
      startMs: 1500,
      endMs: 2000,
      isFinal: true,
    });
  });

  it("marks interim results as not final", () => {
    const u = parseDeepgramResult(
      { type: "Results", is_final: false, channel: { alternatives: [{ transcript: "partial" }] } },
      "me",
    );
    expect(u?.isFinal).toBe(false);
    expect(u?.startMs).toBe(0);
  });

  it("returns null for non-Results messages and empty transcripts", () => {
    expect(parseDeepgramResult({ type: "Metadata" }, "me")).toBeNull();
    expect(
      parseDeepgramResult({ type: "Results", channel: { alternatives: [{ transcript: "" }] } }, "me"),
    ).toBeNull();
    expect(parseDeepgramResult({ type: "Results", channel: { alternatives: [] } }, "me")).toBeNull();
  });
});

describe("reconnectDelay", () => {
  it("doubles per attempt and caps at the max", () => {
    expect(reconnectDelay(0)).toBe(500);
    expect(reconnectDelay(1)).toBe(1000);
    expect(reconnectDelay(2)).toBe(2000);
    expect(reconnectDelay(3)).toBe(4000);
    expect(reconnectDelay(4)).toBe(8000);
    expect(reconnectDelay(5)).toBe(8000); // capped at RECONNECT_MAX_MS
    expect(reconnectDelay(10)).toBe(8000);
  });
});
