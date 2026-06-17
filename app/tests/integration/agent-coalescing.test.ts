// Integration: auto-consider coalescing (coach-session.ts runAutoConsider).
//
// The agent processes one consider() turn at a time. Fast speech must NOT pile
// up a backlog: at most one turn runs and at most one is queued, and the queued
// turn always uses the FRESHEST window — intermediate windows are dropped. We
// assert that contract directly with a controllable agent whose consider()
// promises the test resolves by hand.
//
// (openAgent's own SDK-bound internals — the MCP tool decision flow and early
// interrupt — are loaded via a `new Function` dynamic import that bypasses
// module mocking, so they're verified by the real-Claude lane: smoke:real:agent
// and the mocked E2E. This test owns the queue logic, which lives here.)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startSession } from "../../src/main-process/coach-session";
import type { Agent } from "../../src/main-process/agent";
import type { CallSetup, TranscriptUtterance } from "../../src/main-process/types";

let dir: string;
beforeEach(() => {
  process.env.PROMPTY_E2E = "1"; // no summary keeper, no real model anywhere
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompty-coalesce-"));
  process.env.PROMPTY_CALL_LOG_DIR = dir; // keep end()'s log out of ~/.prompty
});
afterEach(() => {
  delete process.env.PROMPTY_E2E;
  delete process.env.PROMPTY_CALL_LOG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const setup: CallSetup = { direction: "x", memories: [] };
const utt = (text: string): TranscriptUtterance => ({
  speaker: "them",
  text,
  startMs: 0,
  endMs: 1,
  isFinal: true,
});
const tick = () => new Promise((r) => setImmediate(r));

describe("auto-consider coalescing", () => {
  it("runs one turn, queues at most one, and re-runs with the freshest window", async () => {
    const calls: { window: string[]; trigger: string }[] = [];
    let pendingResolvers: Array<() => void> = [];

    const controllableAgent = (): Promise<Agent> =>
      Promise.resolve({
        consider(window, trigger) {
          calls.push({ window: window.map((u) => u.text), trigger });
          return new Promise<void>((resolve) => pendingResolvers.push(resolve));
        },
        async close() {},
      });

    const h = await startSession(setup, {
      mockAudio: true,
      mockDeepgram: true,
      agentFactory: controllableAgent,
    });

    // Three utterances arrive faster than the first turn completes.
    h.injectUtterance(utt("a")); // turn #1 starts, window = [a]
    h.injectUtterance(utt("b")); // in flight → marks pending
    h.injectUtterance(utt("c")); // pending already set → still just one queued
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0].window).toEqual(["a"]);

    // Finish turn #1 → the single queued turn fires with the FRESHEST window,
    // and the intermediate [a,b] window is never considered on its own.
    pendingResolvers.shift()!();
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].window).toEqual(["a", "b", "c"]);

    // Finish turn #2 → the session settles (no further turns).
    pendingResolvers.shift()!();
    await h.waitIdle();
    expect(calls).toHaveLength(2);

    await h.end("user");
  });
});
