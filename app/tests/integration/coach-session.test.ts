// Integration: the session orchestrator (coach-session.ts) driven through its
// public SessionHandle with a mock agent and mocked audio/Deepgram — no model,
// no sidecar, no network. Covers the lifecycle, utterance→nudge flow, the
// hotkey path, the status state machine (listening / no-audio / error), and the
// end→log persistence.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startSession, createMockAgent } from "../../src/main-process/coach-session";
import type { CallSetup, SessionStatus, TranscriptUtterance } from "../../src/main-process/types";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompty-session-"));
  process.env.PROMPTY_CALL_LOG_DIR = dir;
  // E2E flag: skips the post-call summary model pass + the macOS notification,
  // so end() is fully deterministic and offline.
  process.env.PROMPTY_E2E = "1";
});
afterEach(() => {
  delete process.env.PROMPTY_CALL_LOG_DIR;
  delete process.env.PROMPTY_E2E;
  delete process.env.PROMPTY_NO_AUDIO_MS;
  fs.rmSync(dir, { recursive: true, force: true });
});

const setup: CallSetup = { direction: "Probe their pain", memories: [] };
const utt = (text: string): TranscriptUtterance => ({
  speaker: "them",
  text,
  startMs: 0,
  endMs: 1000,
  isFinal: true,
});

describe("coach-session lifecycle", () => {
  it("starts live, turns a final utterance into a nudge, and ends with a saved log", async () => {
    const states: string[] = [];
    const statuses: SessionStatus[] = [];
    const nudges: string[] = [];
    const utterances: string[] = [];

    const h = await startSession(setup, {
      mockAudio: true,
      mockDeepgram: true,
      agentFactory: createMockAgent,
      onStateChange: (s) => states.push(s),
      onStatus: (e) => statuses.push(e.state),
      onNudge: (n) => nudges.push(n.text),
      onUtterance: (u) => utterances.push(u.text),
    });

    expect(h.getState()).toBe("live");
    expect(states).toContain("live");
    expect(statuses).toContain("starting");

    h.injectUtterance(utt("we run eight brokers"));
    await h.waitIdle();

    expect(utterances).toEqual(["we run eight brokers"]);
    expect(h.getTranscript()).toHaveLength(1);
    expect(nudges.length).toBeGreaterThanOrEqual(1); // mock agent emits one per consider
    expect(statuses).toContain("listening"); // markAudio flipped the dot

    await h.end("user");
    expect(states).toContain("ending");
    expect(states).toContain("ended");
    const logPath = h.getLogPath();
    expect(logPath).not.toBeNull();
    expect(fs.existsSync(logPath!)).toBe(true);
    const log = JSON.parse(fs.readFileSync(logPath!, "utf8"));
    expect(log.direction).toBe("Probe their pain");
    expect(log.transcript).toHaveLength(1);
  });

  it("exposes call_ended v2 health signals: utterance + nudge counts, them-silent, sidecar restarts", async () => {
    const h = await startSession(setup, {
      mockAudio: true,
      mockDeepgram: true,
      agentFactory: createMockAgent,
    });

    // transcript_utterances + nudges_fired_count come straight off the handle.
    h.injectUtterance(utt("we run eight brokers"));
    h.injectUtterance(utt("pricing is the sticking point"));
    await h.waitIdle();
    expect(h.getTranscript()).toHaveLength(2);
    expect(h.getNudges().length).toBeGreaterThanOrEqual(1);

    // them_silent_seen + sidecar_restarts default clean, then flip via the seams
    // (real detection — tap-frame staleness / sidecar "restart" events — is physical).
    expect(h.getThemSilentSeen()).toBe(false);
    expect(h.getSidecarRestarts()).toBe(0);
    h.simulateThemSilent();
    h.simulateSidecarRestart();
    h.simulateSidecarRestart();
    expect(h.getThemSilentSeen()).toBe(true);
    expect(h.getSidecarRestarts()).toBe(2);

    await h.end("user");
  });

  it("the hotkey path requests a fresh nudge from the agent", async () => {
    const nudges: string[] = [];
    const h = await startSession(setup, {
      mockAudio: true,
      mockDeepgram: true,
      agentFactory: createMockAgent,
      onNudge: (n) => nudges.push(n.text),
    });
    h.injectUtterance(utt("context line"));
    await h.waitIdle();
    const before = nudges.length;
    h.requestNudge();
    await h.waitIdle();
    expect(nudges.length).toBeGreaterThan(before);
    expect(nudges[nudges.length - 1]).toContain("trigger=hotkey");
    await h.end("user");
  });

  it("flips the status dot to 'no-audio' after a silent gap", async () => {
    process.env.PROMPTY_NO_AUDIO_MS = "300";
    const statuses: SessionStatus[] = [];
    const h = await startSession(setup, {
      mockAudio: true,
      mockDeepgram: true,
      agentFactory: createMockAgent,
      onStatus: (e) => statuses.push(e.state),
    });
    await new Promise((r) => setTimeout(r, 900));
    expect(statuses).toContain("no-audio");
    await h.end("user");
  });

  it("surfaces a transport error as an 'error' status", async () => {
    const statuses: SessionStatus[] = [];
    const h = await startSession(setup, {
      mockAudio: true,
      mockDeepgram: true,
      agentFactory: createMockAgent,
      onStatus: (e) => statuses.push(e.state),
    });
    h.simulateTransportError("boom");
    expect(statuses).toContain("error");
    await h.end("user");
  });
});
