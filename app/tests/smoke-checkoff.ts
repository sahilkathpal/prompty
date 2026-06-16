// Smoke test for the in-call agent's mark_covered tool (RUBY B3 phase 3c).
// The E2E suite exercises check-off only via the deterministic mock agent; this
// hits the REAL `claude` model with a real checklist and a transcript that
// plainly covers items, asserting the agent actually decides to tick them off.
//
// Consumes a small amount of subscription quota. Skipped under
// PROMPTY_MOCK_AGENT=1 (the mock would make this trivially pass).
//
// Pass criteria: no errors, and at least one checklist item gets marked covered
// across the windows (each of which unambiguously addresses one item).

import { openAgent } from "../src/main-process/agent";
import type { CallSetup, TranscriptUtterance } from "../src/main-process/types";

const ITEMS = [
  { id: "ci-teamsize", text: "Confirm how many engineers are on the platform team", done: false },
  { id: "ci-scale", text: "Establish their current Kafka scale (brokers/topics/traffic)", done: false },
  { id: "ci-pain", text: "Surface the operational / on-call pain", done: false },
];
const ITEM_LABEL = new Map(ITEMS.map((i) => [i.id, i.text]));

const setup: CallSetup = {
  direction:
    "Discovery call about whether the prospect needs managed Kafka. Work through the checklist as the conversation covers each point.",
  context: { attendee: { name: "Dana", company: "Acme" } },
  components: [
    { type: "goal", id: "g1", text: "Decide whether they're a fit for managed Kafka" },
    { type: "checklist", id: "cl1", title: "Cover", items: ITEMS.map((i) => ({ ...i })) },
  ],
};

function utt(speaker: "me" | "them", text: string): TranscriptUtterance {
  return { speaker, text, startMs: 0, endMs: 1000, isFinal: true };
}

// Each window plainly resolves one checklist item.
const windows: TranscriptUtterance[][] = [
  [
    utt("me", "How's the platform team set up?"),
    utt("them", "We're five engineers, and honestly Kafka eats a big chunk of our week."),
  ],
  [
    utt("me", "What does your current scale look like?"),
    utt("them", "About eight brokers, a few hundred topics, and traffic's been climbing fast."),
  ],
  [
    utt("me", "How's that been to operate?"),
    utt("them", "Rough — last month a broker fell over at 2am during a rebalance and two of us scrambled. It's not sustainable."),
  ],
];

async function main() {
  let failures = 0;
  const covered = new Set<string>();
  const errors: Error[] = [];

  console.log("[smoke-checkoff] opening agent with a checklist…");
  const agent = await openAgent(setup, {
    onNudge: (n) => console.log(`[smoke-checkoff] nudge (${n.urgency}): ${n.text}`),
    onStayQuiet: (r) => console.log(`[smoke-checkoff] quiet: ${r}`),
    onItemCovered: (id) => {
      covered.add(id);
      console.log(`[smoke-checkoff] MARKED COVERED: ${id} — ${ITEM_LABEL.get(id) ?? "(unknown id)"}`);
    },
    onError: (e) => {
      errors.push(e);
      console.log(`[smoke-checkoff] ERROR: ${e.message}`);
    },
  });

  for (let i = 0; i < windows.length; i++) {
    console.log(`\n[smoke-checkoff] consider window ${i + 1}…`);
    const t0 = Date.now();
    await agent.consider(windows[i]!, "auto");
    console.log(`[smoke-checkoff] window ${i + 1} done in ${Date.now() - t0}ms`);
  }

  await agent.close();

  console.log("\n[smoke-checkoff] summary:");
  console.log(`  items covered: ${covered.size}/${ITEMS.length} [${[...covered].join(", ") || "none"}]`);
  console.log(`  errors: ${errors.length}`);

  if (errors.length > 0) failures++;
  if (covered.size < 1) {
    console.error("[smoke-checkoff] FAIL — the agent never called mark_covered despite items being plainly addressed");
    failures++;
  }

  console.log(`\n[smoke-checkoff] ${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
