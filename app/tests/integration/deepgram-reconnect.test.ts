// Integration: the stateful half of the Deepgram client (deepgram.ts) — pending
// audio buffering, utterance emission, and reconnect-on-abnormal-close — driven
// against a fake `ws` WebSocket. No network.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A registry of every fake socket the module under test constructs, so the test
// can drive open/message/close on each in turn.
const reg = vi.hoisted(() => ({ instances: [] as FakeSocket[] }));

interface FakeSocket {
  readyState: number;
  sent: unknown[];
  on: (ev: string, cb: (...a: unknown[]) => void) => FakeSocket;
  once: (ev: string, cb: (...a: unknown[]) => void) => FakeSocket;
  emit: (ev: string, ...a: unknown[]) => void;
  send: (d: unknown) => void;
  close: () => void;
  terminate: () => void;
}

vi.mock("ws", () => {
  const { EventEmitter } = require("node:events");
  class FakeWS extends EventEmitter {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    sent: unknown[] = [];
    constructor() {
      super();
      reg.instances.push(this as unknown as FakeSocket);
    }
    send(d: unknown) {
      this.sent.push(d);
    }
    close() {}
    terminate() {
      this.readyState = 3;
    }
  }
  return { WebSocket: FakeWS };
});

import { openDeepgramStream } from "../../src/main-process/deepgram";
import type { DeepgramConnStatus } from "../../src/main-process/deepgram";
import type { TranscriptUtterance } from "../../src/main-process/types";

const OPEN = 1;

beforeEach(() => {
  reg.instances.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const resultMsg = (transcript: string, isFinal: boolean) =>
  Buffer.from(
    JSON.stringify({
      type: "Results",
      is_final: isFinal,
      start: 0,
      duration: 1,
      channel: { alternatives: [{ transcript }] },
    }),
  );

describe("openDeepgramStream", () => {
  it("buffers audio sent before open, then flushes it once connected", () => {
    const stream = openDeepgramStream("me", "key", { onUtterance: () => {}, onError: () => {} });
    const ws = reg.instances[0];
    stream.sendAudio(Buffer.from([1, 2, 3, 4])); // before open → buffered
    expect(ws.sent).toHaveLength(0);
    ws.readyState = OPEN;
    ws.emit("open");
    expect(ws.sent.length).toBeGreaterThanOrEqual(1); // pending flushed on open
  });

  it("emits speaker-tagged utterances from Results messages", () => {
    const utts: TranscriptUtterance[] = [];
    openDeepgramStream("them", "key", { onUtterance: (u) => utts.push(u), onError: () => {} });
    const ws = reg.instances[0];
    ws.readyState = OPEN;
    ws.emit("open");
    ws.emit("message", resultMsg("eight brokers", true));
    expect(utts).toHaveLength(1);
    expect(utts[0]).toMatchObject({ speaker: "them", text: "eight brokers", isFinal: true });
  });

  it("reconnects on an abnormal close and reports 'reconnecting'", () => {
    const statuses: DeepgramConnStatus[] = [];
    openDeepgramStream("me", "key", {
      onUtterance: () => {},
      onError: () => {},
      onStatus: (s) => statuses.push(s),
    });
    const ws0 = reg.instances[0];
    ws0.readyState = OPEN;
    ws0.emit("open");
    expect(statuses).toContain("open");

    ws0.readyState = 3;
    ws0.emit("close", 1011, Buffer.from("idle timeout")); // not a clean 1000
    expect(statuses).toContain("reconnecting");

    vi.advanceTimersByTime(600); // past reconnectDelay(0)=500ms
    expect(reg.instances.length).toBe(2); // a fresh socket was opened
  });

  it("does NOT reconnect after a clean close (1000)", () => {
    const statuses: DeepgramConnStatus[] = [];
    openDeepgramStream("me", "key", {
      onUtterance: () => {},
      onError: () => {},
      onStatus: (s) => statuses.push(s),
    });
    const ws0 = reg.instances[0];
    ws0.readyState = OPEN;
    ws0.emit("open");
    ws0.emit("close", 1000, Buffer.from("done"));
    vi.advanceTimersByTime(10_000);
    expect(reg.instances.length).toBe(1); // no reconnect
    expect(statuses).not.toContain("reconnecting");
  });

  it("gives up and reports 'error' after exhausting reconnect attempts", () => {
    const statuses: DeepgramConnStatus[] = [];
    openDeepgramStream("me", "key", {
      onUtterance: () => {},
      onError: () => {},
      onStatus: (s) => statuses.push(s),
    });
    // Drive close→advance repeatedly; each new socket never opens, so attempts
    // climb until scheduleReconnect trips the give-up branch.
    for (let i = 0; i < 10 && !statuses.includes("error"); i++) {
      const ws = reg.instances[reg.instances.length - 1];
      ws.readyState = 3;
      ws.emit("close", 1011, Buffer.from("drop"));
      vi.advanceTimersByTime(9000); // past the max backoff
    }
    expect(statuses).toContain("error");
  });
});
