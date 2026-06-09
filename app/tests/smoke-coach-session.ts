// Smoke test for Stage 3 coach-session module.
//
// Boots a stubbed session: PROMPTY_MOCK_AUDIO=1 disables sidecar spawn,
// PROMPTY_MOCK_DEEPGRAM=1 short-circuits real WS. Real agent loop runs
// against the user's `claude` binary — consumes a small quota.
//
// Pass criteria: at least one nudge fired, log file written on session end
// with goal, checklist, nudges, transcript, startedAt, endedAt all populated.

process.env.PROMPTY_MOCK_AUDIO = "1";
process.env.PROMPTY_MOCK_DEEPGRAM = "1";

// Override the call-log directory so we don't pollute ~/.prompty/calls.
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "prompty-coach-smoke-"));
process.env.PROMPTY_CALL_LOG_DIR = logDir;

// Stub out the electron module before importing coach-session, since
// call-log -> coach-session -> electron transitively. coach-session uses
// `Notification` and `shell` at end(); both are tolerated as no-ops if
// missing (we PROMPTY_E2E gates notifications). Set PROMPTY_E2E=1 to skip
// the Notification path entirely in the smoke.
process.env.PROMPTY_E2E = "1";

// Provide a fake electron module so coach-session import resolves.
const Module = require("node:module") as { _resolveFilename: Function; _cache: Record<string, unknown> };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
  if (request === "electron") {
    return require.resolve("./fixtures/fake-electron.cjs");
  }
  return origResolve.call(this, request, parent, ...rest);
};

import { startSession } from "../src/main-process/coach-session";
import type { CallSetup, TranscriptUtterance } from "../src/main-process/types";

const setup: CallSetup = {
  goal: "Learn whether the prospect needs managed Kafka.",
  checklist: [
    { id: "team", text: "Ask about team size", status: "open" },
    { id: "scale", text: "Ask about current Kafka scale", status: "open" },
  ],
  context: {
    attendee: { name: "Test User", company: "Acme" },
  },
};

function utt(speaker: "me" | "them", text: string): TranscriptUtterance {
  return { speaker, text, startMs: 0, endMs: 1000, isFinal: true };
}

async function main() {
  let nudgeCount = 0;
  const session = await startSession(setup, {
    onNudge: (n) => {
      nudgeCount++;
      console.log(`[smoke] nudge: ${n.kind} — ${n.text}`);
    },
    onStateChange: (s) => console.log(`[smoke] state → ${s}`),
    silenceTimeoutMs: 5 * 60_000, // don't auto-end during the smoke
  });

  console.log("[smoke] injecting utterances…");
  session.injectUtterance(utt("them", "Hey, thanks for hopping on. We're running about 8 brokers right now."));
  session.injectUtterance(utt("me", "Got it. How big is your platform team?"));
  session.injectUtterance(utt("them", "We're a team of 5 engineers managing all of it."));

  // Give the agent ~30s to chew through the consider() calls.
  await new Promise((r) => setTimeout(r, 30_000));

  console.log("[smoke] ending session…");
  await session.end("user");

  const files = readdirSync(logDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.error("[smoke] FAIL — no log file written");
    process.exit(1);
  }
  const log = JSON.parse(readFileSync(join(logDir, files[0]!), "utf8"));
  const ok =
    log.goal === setup.goal &&
    Array.isArray(log.checklist) &&
    Array.isArray(log.transcript) &&
    Array.isArray(log.nudges) &&
    typeof log.startedAt === "number" &&
    typeof log.endedAt === "number" &&
    log.transcript.length >= 3;

  console.log(`[smoke] log file: ${files[0]}`);
  console.log(`[smoke] nudges fired: ${nudgeCount}, in log: ${log.nudges.length}`);
  console.log(`[smoke] transcript entries: ${log.transcript.length}`);

  const pass = ok && nudgeCount >= 1;
  console.log(`[smoke] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
