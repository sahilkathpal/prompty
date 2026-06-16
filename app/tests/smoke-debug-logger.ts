// Smoke test for the verbose debug logger — no claude, no electron runtime.

import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "prompty-debug-log-"));
process.env.PROMPTY_DEBUG_LOG_DIR = dir;

import {
  openDebugLog,
  debugDir,
  debugFullPrompt,
  renderDebugMarkdown,
} from "../src/main-process/debug-logger";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[smoke-debug-logger] FAIL — ${msg}`);
    process.exit(1);
  }
}

// debugDir honours the env override.
assert(debugDir() === dir, `debugDir should honour env override: ${debugDir()}`);

// debugFullPrompt defaults off.
assert(debugFullPrompt() === false, "debugFullPrompt should default to false");

// A fake monotonic clock so we can assert ts stamping deterministically.
let tick = 1000;
const clock = () => (tick += 10);

const startedAt = 1700000000000;
const log = openDebugLog("call", startedAt, clock);
assert(log !== null, "openDebugLog should return a handle");

const expectedFile = join(dir, `call-${startedAt}.jsonl`);
assert(log!.filePath === expectedFile, `filePath mismatch: ${log!.filePath}`);

log!.write("session-start", { goal: "Win the demo", skill: "discovery" });
log!.write("utterance", { speaker: "them", text: "Tell me about pricing", startMs: 1200, endMs: 3400 });
log!.write("agent-turn", {
  trigger: "auto",
  rawModelResponse: "…",
  toolCalls: [{ name: "emit_nudge", args: { text: "Ask their budget" } }],
  latencyMs: 540,
  nudgeFired: true,
});
log!.write("session-end", { endedAt: startedAt + 60000 });

log!.close();
// Idempotent close + writes after close are no-ops (must not throw).
log!.close();
log!.write("nudge", { nudge: { id: "late" } });

assert(existsSync(expectedFile), `expected file ${expectedFile} to exist`);

const lines = readFileSync(expectedFile, "utf8").trim().split("\n");
assert(lines.length === 4, `expected 4 events (post-close write dropped), got ${lines.length}`);

const events = lines.map((l) => JSON.parse(l));

// Every event carries a wall-clock ts (stamped by the logger, not the caller).
for (const ev of events) {
  assert(typeof ev.ts === "number", `event missing ts: ${JSON.stringify(ev)}`);
  assert(typeof ev.kind === "string", `event missing kind: ${JSON.stringify(ev)}`);
}

// ts is monotonic in write order (proves the injected clock is used).
assert(events[0].ts < events[1].ts, "ts should increase in write order");

// session-start keeps its payload; the caller must NOT pass ts (logger owns it).
assert(events[0].kind === "session-start", "first event kind");
assert(events[0].goal === "Win the demo", "session-start goal preserved");
assert(events[0].skill === "discovery", "session-start skill preserved");

// utterance preserves original stream-relative fields alongside wall-clock ts.
assert(events[1].kind === "utterance", "second event kind");
assert(events[1].startMs === 1200 && events[1].endMs === 3400, "utterance ms preserved");

// agent-turn nested payload round-trips.
assert(events[2].toolCalls[0].name === "emit_nudge", "agent-turn toolCalls preserved");
assert(events[2].nudgeFired === true, "agent-turn nudgeFired preserved");

// close() renders a human-readable .md sibling.
const mdFile = expectedFile.replace(/\.jsonl$/, ".md");
assert(existsSync(mdFile), `expected rendered markdown at ${mdFile}`);
const md = readFileSync(mdFile, "utf8");
assert(md.includes("# Ruby debug — call session"), "md should have a call-session header");
assert(md.includes("**Goal:** Win the demo"), "md header should carry the goal");
assert(md.includes("## Timeline"), "md should have a timeline section");
assert(md.includes("🗣️ **them:** Tell me about pricing"), "md timeline should render the utterance");
assert(md.includes("agent-turn"), "md timeline should render the agent-turn");
assert(md.includes("🏁 **session-end**"), "md timeline should render session-end");
// renderDebugMarkdown is pure / re-runnable over the same file.
assert(renderDebugMarkdown(expectedFile) === md, "renderDebugMarkdown should be deterministic");

// Prep kind namespaces the file separately.
const prep = openDebugLog("prep", startedAt, clock);
assert(prep !== null, "openDebugLog prep should return a handle");
assert(
  prep!.filePath === join(dir, `prep-${startedAt}.jsonl`),
  `prep filePath mismatch: ${prep!.filePath}`,
);
prep!.write("prep-start", { seededFromPending: false });
prep!.close();
assert(existsSync(join(dir, `prep-${startedAt}.jsonl`)), "prep file should exist");

console.log("[smoke-debug-logger] PASS");
process.exit(0);
