// Integration: spawnSidecar wiring (sidecar.ts) — that demuxed frames route to
// the right stream/emitter and that an unexpected exit triggers a respawn —
// against a fake child process. No real Swift binary, no electron runtime
// (the `electron` import is aliased to the test fake in vitest.config.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const reg = vi.hoisted(() => ({ children: [] as FakeChild[] }));

interface FakeChild {
  stdout: { emit: (e: string, ...a: unknown[]) => void; on: (...a: unknown[]) => void };
  stderr: { emit: (e: string, ...a: unknown[]) => void; on: (...a: unknown[]) => void };
  emit: (e: string, ...a: unknown[]) => void;
  on: (...a: unknown[]) => void;
  once: (...a: unknown[]) => void;
  kill: () => void;
}

vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  class Child extends EventEmitter {
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    kill() {}
  }
  return {
    spawn: vi.fn(() => {
      const c = new Child();
      reg.children.push(c as unknown as FakeChild);
      return c;
    }),
  };
});

import { spawnSidecar } from "../../src/main-process/sidecar";
import {
  FRAME_TAG_CONTROL,
  FRAME_TAG_MIC,
  FRAME_TAG_TAP,
} from "../../src/main-process/sidecar-protocol";

function frame(tag: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head[0] = tag;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  reg.children.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("spawnSidecar", () => {
  it("routes mic/tap PCM frames to their streams and control JSON to the emitter", async () => {
    const h = spawnSidecar({});
    const child = reg.children[0];
    const mic: Buffer[] = [];
    const tap: Buffer[] = [];
    const control: { type?: string }[] = [];
    h.micStream.on("data", (c: Buffer) => mic.push(c));
    h.tapStream.on("data", (c: Buffer) => tap.push(c));
    h.controlEvents.on("control", (e) => control.push(e));
    let readyFired = false;
    h.controlEvents.on("ready", () => (readyFired = true));

    child.stdout.emit("data", frame(FRAME_TAG_MIC, Buffer.from([1, 2, 3])));
    child.stdout.emit("data", frame(FRAME_TAG_TAP, Buffer.from([9, 8])));
    child.stdout.emit("data", frame(FRAME_TAG_CONTROL, Buffer.from(JSON.stringify({ type: "ready" }))));
    await tick();

    expect(Buffer.concat(mic).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(Buffer.concat(tap).equals(Buffer.from([9, 8]))).toBe(true);
    expect(control).toEqual([{ type: "ready" }]);
    expect(readyFired).toBe(true); // re-emitted under its own event name
    h.kill();
  });

  it("respawns after an unexpected exit (bounded retries)", () => {
    vi.useFakeTimers();
    spawnSidecar({});
    expect(reg.children.length).toBe(1);
    reg.children[0].emit("exit", 1, null); // crash
    vi.advanceTimersByTime(600); // past the 500ms*attempt backoff
    expect(reg.children.length).toBe(2); // a replacement was spawned
  });
});
