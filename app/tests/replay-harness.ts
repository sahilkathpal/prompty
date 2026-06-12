// Transcript-replay harness — the fast dev loop for iterating on the in-call
// prompt.
//
// Problem it solves: seeing what the coach does normally requires a live call
// (audio sidecar + a real conversation) — minutes per iteration, never
// reproducible. This replays a fixed transcript through the *real* agent
// offline, so every prompt edit shows you the exact nudges in seconds.
//
// It is a SEEING tool, not an assertion tool: the model is nondeterministic, so
// the same transcript won't reproduce the same nudges run to run. Read the
// timeline with your own judgement; don't build a regression diff on it.
//
// Usage:
//   npm run replay                        # built-in hand-authored fixture
//   npm run replay -- path/to/call-*.jsonl   # a recorded debug-log session
//   npm run replay -- --parse-only [path]    # load + print the fixture, no model
//
// Fixture sources:
//   1. A debug-logger JSONL (~/.prompty/debug/call-*.jsonl): its `session-start`
//      event reconstructs the CallSetup and its `utterance` events the
//      transcript. Record one once with debugMode on, then replay it forever.
//   2. The built-in hand-authored fixture below — for deliberate edge cases
//      before you have a recording worth replaying.

import fs from "node:fs";
import { openAgent } from "../src/main-process/agent";
import { CONSIDER_WINDOW } from "../src/main-process/windowing";
import type {
  CallSetup,
  ChecklistItem,
  Nudge,
  Speaker,
  TranscriptUtterance,
} from "../src/main-process/types";

type Fixture = { setup: CallSetup; utterances: TranscriptUtterance[]; label: string };

function utt(speaker: Speaker, text: string): TranscriptUtterance {
  return { speaker, text, startMs: 0, endMs: 0, isFinal: true };
}

// ---- Built-in hand-authored fixture -----------------------------------------
// A short discovery call with a couple of gold threads to mine, so a healthy
// prompt should fire at least one deepen/segue nudge.
const BUILT_IN: Fixture = {
  label: "built-in: discovery (Kafka migration)",
  setup: {
    goal: "Learn whether they have budget for managed streaming.",
    direction:
      "Explore their Kafka operational pain before pitching; stay curious, qualify fit, and let them talk.",
    checklist: [
      { id: "team", text: "How big is the platform team?", status: "open" },
      { id: "pain", text: "What pain at current scale?", status: "open" },
      { id: "budget", text: "Is there a dedicated streaming budget?", status: "open" },
    ],
    context: {
      attendee: { name: "Dana", company: "Linear", bio: "Staff engineer, data platform." },
    },
    skill: "discovery",
  },
  utterances: [
    utt("them", "Hey, good to see you. How's the week going?"),
    utt("me", "Good, thanks — yours?"),
    utt("them", "Busy. We're mid-way through a big infra push right now."),
    utt("them", "We finally finished the Kafka rollout last quarter — about eight months end to end."),
    utt("me", "Oh nice, that's faster than I'd have guessed."),
    utt("them", "The platform team is only five people, so we had to be surgical about it."),
    utt("them", "Honestly the operational side is what's killing us now — rebalancing, partition skew, on-call."),
    utt("me", "That sounds painful."),
    utt("them", "Yeah. Two of the five basically babysit the clusters most weeks."),
    utt("them", "Anyway — what did you want to dig into?"),
  ],
};

// ---- JSONL fixture loader ----------------------------------------------------
function loadFromJsonl(path: string): Fixture {
  const raw = fs.readFileSync(path, "utf8");
  const events: Record<string, any>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A crash mid-write only corrupts the final line — skip it.
    }
  }

  const start = events.find((e) => e.kind === "session-start");
  const checklist: ChecklistItem[] = Array.isArray(start?.checklist) ? start!.checklist : [];
  const setup: CallSetup = {
    goal: start?.goal ?? "",
    direction: start?.direction,
    checklist,
    context: { attendee: start?.attendee },
    skill: start?.skill,
  };

  // "utterance" events are finals; "interim" events are ignored (the live loop
  // only ever feeds finals into consider()).
  const utterances: TranscriptUtterance[] = events
    .filter((e) => e.kind === "utterance")
    .map((e) => ({
      speaker: (e.speaker as Speaker) ?? "them",
      text: String(e.text ?? ""),
      startMs: Number(e.startMs ?? 0),
      endMs: Number(e.endMs ?? 0),
      isFinal: true,
    }))
    .filter((u) => u.text.trim().length > 0);

  return { setup, utterances, label: `jsonl: ${path}` };
}

// ---- Pretty-printing ---------------------------------------------------------
function printSetup(f: Fixture): void {
  const s = f.setup;
  console.log(`\n=== fixture: ${f.label} ===`);
  if (s.goal) console.log(`goal:      ${s.goal}`);
  if (s.direction) console.log(`direction: ${s.direction}`);
  if (s.skill) console.log(`skill:     ${s.skill}`);
  if (s.context.attendee?.name) {
    const a = s.context.attendee;
    console.log(`attendee:  ${a.name}${a.company ? ` (${a.company})` : ""}`);
  }
  if (s.checklist.length) {
    console.log("checklist:");
    for (const c of s.checklist) console.log(`  - [${c.id}] (${c.status}) ${c.text}`);
  }
  console.log(`utterances: ${f.utterances.length}, window: ${CONSIDER_WINDOW}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const parseOnly = args.includes("--parse-only");
  const pathArg = args.find((a) => !a.startsWith("--"));

  const fixture = pathArg ? loadFromJsonl(pathArg) : BUILT_IN;
  printSetup(fixture);

  if (parseOnly) {
    console.log("\n--- transcript (parse-only) ---");
    fixture.utterances.forEach((u, i) =>
      console.log(`#${String(i + 1).padStart(2, "0")} [${u.speaker}] ${u.text}`),
    );
    console.log("\n[replay] parse-only: fixture loaded OK, agent not invoked.");
    process.exit(0);
  }

  // Per-turn decision buffer. The session is serial — we await each consider()
  // before the next — so a single mutable buffer is safe.
  let turnLines: string[] = [];
  const errors: Error[] = [];
  const agent = await openAgent(fixture.setup, {
    onNudge: (n: Nudge) => turnLines.push(`      💡 ${n.urgency}: ${n.text}`),
    onChecklistUpdate: (id, status) => turnLines.push(`      ☑ ${id} → ${status}`),
    onStayQuiet: (reason) => turnLines.push(`      · quiet: ${reason}`),
    onError: (e) => {
      errors.push(e);
      turnLines.push(`      ❌ ${e.message}`);
    },
  });

  console.log("\n--- replay timeline ---");
  console.log("(mirrors coach-session.ts: slide a CONSIDER_WINDOW-deep window,");
  console.log(" fire consider() on every final utterance. Unlike production this");
  console.log(" awaits every turn — no debounce/drop — so you see every decision.)\n");

  const window: TranscriptUtterance[] = [];
  let nudgeCount = 0;
  for (let i = 0; i < fixture.utterances.length; i++) {
    const u = fixture.utterances[i]!;
    window.push(u);
    while (window.length > CONSIDER_WINDOW) window.shift();

    turnLines = [];
    await agent.consider([...window], "auto");

    console.log(`#${String(i + 1).padStart(2, "0")} [${u.speaker}] ${u.text}`);
    for (const line of turnLines) {
      console.log(line);
      if (line.includes("💡")) nudgeCount++;
    }
  }

  await agent.close();
  console.log(`\n[replay] done — ${fixture.utterances.length} turns, ${nudgeCount} nudge(s), ${errors.length} error(s).`);
  process.exit(errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
