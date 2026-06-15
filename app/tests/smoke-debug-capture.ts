// Smoke test for debug-mode CAPTURE wiring in coach-session — no claude, no
// real audio. Uses a custom agent factory that drives both the onNudge and
// onDebug paths so we can assert the full call-*.jsonl event stream and the
// mid-session setDebug() toggle, without burning model quota.

process.env.PROMPTY_MOCK_AUDIO = "1";
process.env.PROMPTY_MOCK_DEEPGRAM = "1";
process.env.PROMPTY_E2E = "1"; // skip Notification + summary model call

import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const callDir = mkdtempSync(join(tmpdir(), "prompty-dbgcap-calls-"));
const debugDirPath = mkdtempSync(join(tmpdir(), "prompty-dbgcap-debug-"));
process.env.PROMPTY_CALL_LOG_DIR = callDir;
process.env.PROMPTY_DEBUG_LOG_DIR = debugDirPath;

// Fake electron so the transitive import resolves.
const Module = require("node:module") as { _resolveFilename: Function };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
  if (request === "electron") return require.resolve("./fixtures/fake-electron.cjs");
  return origResolve.call(this, request, parent, ...rest);
};

import { startSession } from "../src/main-process/coach-session";
import type { Agent, AgentEvents } from "../src/main-process/agent";
import type { CallSetup, TranscriptUtterance } from "../src/main-process/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[smoke-debug-capture] FAIL — ${msg}`);
    process.exit(1);
  }
}

const setup: CallSetup = {
  direction: "Learn whether the prospect needs managed Kafka; probe team size and scale.",
  context: { attendee: { name: "Test User", company: "Acme" } },
};

// Agent that, per consider(), reports a debug turn AND emits a nudge — exercises
// both coach-session debug write paths (agent-turn + nudge).
let turn = 0;
const debugAgentFactory = (_setup: CallSetup, events: AgentEvents): Promise<Agent> =>
  Promise.resolve({
    async consider(_window, trigger) {
      turn++;
      events.onDebug?.({
        trigger,
        turnId: turn,
        context: `ctx ${turn}`,
        assistantText: "thinking…",
        toolCalls: [{ name: "emit_nudge", args: { text: "x" } }],
        decision: "emit_nudge",
        nudgeFired: true,
        latencyMs: 42,
      });
      events.onNudge({
        id: `m-${turn}`,
        text: `Nudge ${turn}`,
        urgency: "medium",
        createdAt: 1700000000000 + turn,
      });
    },
    async close() {},
  });

function utt(speaker: "me" | "them", text: string, isFinal = true): TranscriptUtterance {
  return { speaker, text, startMs: 100, endMs: 900, isFinal };
}

async function main() {
  const session = await startSession(setup, {
    debug: true,
    agentFactory: debugAgentFactory,
  });

  // An interim (non-final) then finals — both should be captured distinctly.
  session.injectUtterance(utt("them", "interim…", false));
  session.injectUtterance(utt("them", "We run 8 brokers."));
  session.injectUtterance(utt("me", "How big is your team?"));

  // Let the mock consider() turns resolve.
  await new Promise((r) => setTimeout(r, 200));

  await session.end("user");

  // ---- Assert the debug file exists and is well-formed ----
  const files = readdirSync(debugDirPath).filter((f) => f.startsWith("call-") && f.endsWith(".jsonl"));
  assert(files.length === 1, `expected exactly one call-*.jsonl, got ${files.length}`);

  const events = readFileSync(join(debugDirPath, files[0]!), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  const kinds = events.map((e) => e.kind);
  assert(kinds[0] === "session-start", `first event should be session-start, got ${kinds[0]}`);
  assert(kinds[kinds.length - 1] === "session-end", `last event should be session-end, got ${kinds.at(-1)}`);
  assert(kinds.includes("utterance"), "should capture final utterances");
  assert(kinds.includes("interim"), "should capture interim utterances");
  assert(kinds.includes("nudge"), "should capture nudges");
  assert(kinds.includes("agent-turn"), "should capture agent-turns");

  // session-start carries the resolved static prompt (fidelity B, logged once).
  const start = events.find((e) => e.kind === "session-start");
  assert(typeof start.systemPrompt === "string" && start.systemPrompt.length > 0, "session-start should carry systemPrompt");
  assert(start.direction === setup.direction, "session-start direction preserved");
  assert(events.filter((e) => e.kind === "session-start").length === 1, "systemPrompt logged exactly once");

  // Every event carries a wall-clock ts.
  for (const e of events) assert(typeof e.ts === "number", `event missing ts: ${e.kind}`);

  // utterance preserves original stream-relative fields.
  const u = events.find((e) => e.kind === "utterance");
  assert(u.startMs === 100 && u.endMs === 900, "utterance ms preserved");

  // agent-turn round-trips the nested record.
  const at = events.find((e) => e.kind === "agent-turn");
  assert(at.decision === "emit_nudge" && at.nudgeFired === true, "agent-turn fields preserved");
  assert(at.latencyMs === 42, "agent-turn latency preserved");

  // A rendered .md sibling exists with the call header + timeline.
  const mdFile = join(debugDirPath, files[0]!.replace(/\.jsonl$/, ".md"));
  assert(existsSync(mdFile), `expected rendered .md at ${mdFile}`);
  const md = readFileSync(mdFile, "utf8");
  assert(md.includes("# Prompty debug — call session"), "md call-session header");
  assert(md.includes("💡 **nudge**"), "md should render a nudge in the timeline");

  console.log(`[smoke-debug-capture] captured ${events.length} events: ${[...new Set(kinds)].join(", ")}`);

  // ---- Toggle OFF mid-life starts a fresh session; verify setDebug closes ----
  const s2 = await startSession(setup, { debug: false, agentFactory: debugAgentFactory });
  // Off at start: no file opened yet.
  const countJsonl = () =>
    readdirSync(debugDirPath).filter((f) => f.startsWith("call-") && f.endsWith(".jsonl")).length;
  const before = countJsonl();
  s2.setDebug(true); // toggle ON mid-session → opens a new file (different startedAt)
  s2.injectUtterance(utt("them", "later utterance"));
  await new Promise((r) => setTimeout(r, 150));
  s2.setDebug(false); // toggle OFF → closes
  await s2.end("user");
  const after = countJsonl();
  assert(after === before + 1, `mid-session setDebug(true) should open exactly one new file (before=${before}, after=${after})`);

  console.log("[smoke-debug-capture] PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
