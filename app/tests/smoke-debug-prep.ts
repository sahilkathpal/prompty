// Smoke test for debug-mode CAPTURE in prep sessions — uses the MOCK prep
// session (no claude quota) with debug enabled, then asserts the prep-*.jsonl
// event stream and the mid-session setDebug() toggle.

process.env.PROMPTY_MOCK_PREP = "1";

import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const debugDirPath = mkdtempSync(join(tmpdir(), "prompty-dbgprep-"));
process.env.PROMPTY_DEBUG_LOG_DIR = debugDirPath;

import { openPrepSession } from "../src/main-process/prep-session";
import type { CalendarEvent } from "../src/main-process/calendar-arm";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[smoke-debug-prep] FAIL — ${msg}`);
    process.exit(1);
  }
}

const fakeEvent: CalendarEvent = {
  id: "dbg-prep-1",
  title: "Debug prep smoke",
  startsAt: Date.now() + 10 * 60_000,
  attendees: [],
};

function prepFiles(): string[] {
  return readdirSync(debugDirPath).filter((f) => f.startsWith("prep-") && f.endsWith(".jsonl"));
}

async function main() {
  const session = await openPrepSession(fakeEvent, undefined, { debug: true });

  // Drive a few turns + a rail edit so we exercise the event taxonomy.
  await session.sendMessage("I want to learn if they need managed Kafka.");
  await session.sendMessage("They run 8 brokers, team of 5.");
  session.setGoal("Confirm managed-Kafka fit and agree a next step");
  session.noteSave(true);

  // ---- Assert the prep file is well-formed ----
  const files = prepFiles();
  assert(files.length === 1, `expected one prep-*.jsonl, got ${files.length}`);

  const events = readFileSync(join(debugDirPath, files[0]!), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const kinds = events.map((e) => e.kind);

  assert(kinds[0] === "prep-start", `first event should be prep-start, got ${kinds[0]}`);
  assert(kinds.includes("prep-user-turn"), "should capture prep-user-turn");
  assert(kinds.includes("prep-agent-turn"), "should capture prep-agent-turn");
  assert(kinds.includes("prep-state-change"), "should capture prep-state-change");
  assert(kinds.includes("prep-save"), "should capture prep-save");

  // prep-start carries the resolved prep system prompt + event info, once.
  const start = events.find((e) => e.kind === "prep-start");
  assert(typeof start.systemPrompt === "string" && start.systemPrompt.length > 0, "prep-start systemPrompt");
  assert(start.event?.id === "dbg-prep-1", "prep-start event id preserved");
  assert(start.seededFromPending === false, "prep-start not seeded");
  assert(events.filter((e) => e.kind === "prep-start").length === 1, "prep-start logged once");

  // user-turn captures the visible text.
  const ut = events.find((e) => e.kind === "prep-user-turn");
  assert(typeof ut.text === "string" && ut.text.length > 0, "prep-user-turn text");

  // state-change distinguishes tool vs rail edits, and the rail edit carries the goal.
  const railChange = events.find((e) => e.kind === "prep-state-change" && e.source === "rail");
  assert(!!railChange, "should capture a rail-sourced state change");
  assert(railChange.state.goal === "Confirm managed-Kafka fit and agree a next step", "rail state goal preserved");
  assert(events.some((e) => e.kind === "prep-state-change" && e.source === "tool"), "should capture a tool-sourced state change");

  // prep-save carries the snapshot + chainedToCall.
  const save = events.find((e) => e.kind === "prep-save");
  assert(save.chainedToCall === true, "prep-save chainedToCall preserved");
  assert(typeof save.snapshot?.direction === "string", "prep-save snapshot has direction");

  // Every event has a wall-clock ts.
  for (const e of events) assert(typeof e.ts === "number", `event missing ts: ${e.kind}`);

  await session.close();

  // close() renders a .md sibling with the prep header + timeline.
  const mdFile = join(debugDirPath, files[0]!.replace(/\.jsonl$/, ".md"));
  assert(readFileSync(mdFile, "utf8").includes("# Prompty debug — prep session"), "prep .md header");

  console.log(`[smoke-debug-prep] captured ${events.length} events: ${[...new Set(kinds)].join(", ")}`);

  // ---- Mid-session toggle: start OFF, flip ON, expect a new file ----
  const s2 = await openPrepSession(fakeEvent, undefined, { debug: false });
  const before = prepFiles().length;
  s2.setDebug(true); // opens a new prep file (different startedAt)
  await s2.sendMessage("hello");
  s2.setDebug(false); // closes
  await s2.close();
  const after = prepFiles().length;
  assert(after === before + 1, `mid-session setDebug(true) should add one file (before=${before}, after=${after})`);

  console.log("[smoke-debug-prep] PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
