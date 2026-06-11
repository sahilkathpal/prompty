// Smoke test for the hotkey one-shot (answer.ts) + background running summary
// (running-summary.ts). Both are real-model-only paths the E2E/mock suites
// deliberately skip, so they need their own harness.
//
// Hits the user's `claude` binary — consumes a small quota.
//
// Pass criteria:
//   1. answerNow() returns a non-empty kind:"answer" nudge of a sane length.
//   2. createSummaryKeeper() populates current() in the background once enough
//      utterances have been fed.

import { answerNow } from "../src/main-process/answer";
import { createSummaryKeeper } from "../src/main-process/running-summary";
import type { CallSetup, TranscriptUtterance } from "../src/main-process/types";

const setup: CallSetup = {
  goal: "Learn whether the prospect needs managed Kafka and close a follow-up.",
  checklist: [
    { id: "team", text: "Ask about team size", status: "covered" },
    { id: "scale", text: "Ask about current Kafka scale", status: "open" },
    { id: "pain", text: "Ask what's painful about self-managing", status: "open" },
  ],
  context: { attendee: { name: "Dana", company: "Acme" } },
};

function utt(speaker: "me" | "them", text: string): TranscriptUtterance {
  return { speaker, text, startMs: 0, endMs: 1000, isFinal: true };
}

const convo: TranscriptUtterance[] = [
  utt("me", "Thanks for hopping on, Dana. How's the platform team set up?"),
  utt("them", "We're five engineers and honestly Kafka eats a lot of our week."),
  utt("me", "What does your current scale look like?"),
  utt("them", "About eight brokers, a few hundred topics, traffic's been climbing."),
  utt("them", "Last month we had an outage when a broker fell over during a rebalance."),
  utt("me", "Ouch. Who handled the on-call for that?"),
  utt("them", "Two of us, at 2am. It's not sustainable as we grow."),
];

async function main() {
  let failures = 0;

  // ---- 1. Hotkey one-shot ----
  console.log("[smoke] calling answerNow()…");
  const t0 = Date.now();
  const nudge = await answerNow({
    setup,
    summary: "",
    recent: convo,
    recentNudges: [],
  });
  const ms = Date.now() - t0;
  if (!nudge) {
    console.error("[smoke] FAIL — answerNow returned null");
    failures++;
  } else {
    const words = nudge.text.trim().split(/\s+/).length;
    console.log(`[smoke] answer (${ms}ms, kind=${nudge.kind}, ${words}w): ${nudge.text}`);
    if (nudge.kind !== "answer") {
      console.error(`[smoke] FAIL — expected kind "answer", got "${nudge.kind}"`);
      failures++;
    }
    if (nudge.text.trim().length === 0) {
      console.error("[smoke] FAIL — empty answer text");
      failures++;
    }
    if (words > 30) {
      console.error(`[smoke] WARN — answer longer than expected (${words} words)`);
    }
  }

  // ---- 2. Running summary keeper ----
  console.log("[smoke] feeding keeper to trigger a background refresh…");
  const keeper = createSummaryKeeper(setup);
  // REFRESH_EVERY is 20 — build a transcript past the threshold.
  const long: TranscriptUtterance[] = [];
  for (let i = 0; i < 22; i++) {
    long.push(convo[i % convo.length]!);
    keeper.note(long); // note() ignores until the threshold, then kicks once
  }
  // Poll up to 30s for the background pass to land.
  let summary = "";
  for (let i = 0; i < 30; i++) {
    summary = keeper.current();
    if (summary) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!summary) {
    console.error("[smoke] FAIL — keeper.current() never populated");
    failures++;
  } else {
    console.log(`[smoke] summary (${summary.length} chars): ${summary.slice(0, 160)}…`);
  }

  console.log(`[smoke] ${failures === 0 ? "PASS" : "FAIL"} (${failures} failure(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
