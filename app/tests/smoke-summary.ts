// Smoke test for the post-call summary pass (summary.ts) against the REAL model.
// The unit/e2e suites only exercise sanitize() on fixtures; this hits the actual
// `claude` model with a real transcript + nudges and checks the redesigned shape:
//   - every insight LEADS with a non-empty takeaway (never a bare quote)
//   - quotes lean common (the prompt biases toward including them)
//   - a nudge the user plainly acts on yields an assisted insight with a `via`
//   - the dropped fields (questionsNotAsked / stat) are truly gone
//
// Consumes a small amount of subscription quota.
//
// Pass criteria: summary returns, >=2 insights, every takeaway non-empty, and the
// shape carries no legacy fields. Quote-coverage and the assisted credit are
// printed and softly checked (the model is told to UNDER-claim credit, so a miss
// there is a warning, not a hard failure).

import { summarizeCall } from "../src/main-process/summary";
import type { CallSetup, Nudge, TranscriptUtterance } from "../src/main-process/types";

const startedAt = 1_700_000_000_000;
const at = (sec: number) => startedAt + sec * 1000;
const utt = (speaker: "me" | "them", text: string): TranscriptUtterance => ({
  speaker,
  text,
  startMs: 0,
  endMs: 1000,
  isFinal: true,
});

const setup: CallSetup = {
  direction: "Discovery call with Northwind Logistics about replacing their legacy TMS.",
};

// A transcript where: (a) peak-season pain is vivid, (b) Ruby nudges about the
// contract renewal at 2:00 and the user PLAINLY picks it up, (c) Ruby nudges
// about competitors at 5:00 and the user never touches it, (d) a CFO reporting
// gate surfaces organically.
const transcript: TranscriptUtterance[] = [
  utt("me", "Thanks for making the time, Maya. Where does the current setup hurt most?"),
  utt("them", "Honestly the current system breaks every peak season — we lost two days over the holidays."),
  utt("me", "That's rough. Is this on-prem today?"),
  utt("them", "Yeah, a legacy on-prem stack. We're trying to get off it by Q4."),
  // --- Ruby surfaced the renewal-timing nudge here (~2:00); the user acts on it ---
  utt("me", "Before we go further — when's your current contract actually up for renewal?"),
  utt("them", "It renews in March, so realistically we'd need to have moved before then."),
  utt("me", "Good to know. And who signs off on a change like this?"),
  utt("them", "I own ops, but budget sign-off sits with our CFO."),
  utt("them", "And one hard line from him — if it touches our existing reporting, that's a non-starter."),
  utt("me", "Understood. We can map onto your reporting so nothing breaks there."),
];

const nudges: Nudge[] = [
  { id: "n1", urgency: "medium", text: "Ask when their current contract is up for renewal", createdAt: at(115) },
  { id: "n2", urgency: "medium", text: "Ask whether they've evaluated competing vendors", createdAt: at(300) },
];

async function main() {
  let failures = 0;
  const warn = (m: string) => console.log(`[smoke-summary] ⚠︎ ${m}`);

  console.log("[smoke-summary] summarizing a real transcript via the model…");
  const t0 = Date.now();
  const summary = await summarizeCall(setup, transcript, nudges, startedAt);
  console.log(`[smoke-summary] done in ${Date.now() - t0}ms`);

  if (!summary) {
    console.error("[smoke-summary] FAIL — summarizeCall returned null");
    process.exit(1);
  }

  console.log(`\n[smoke-summary] title: ${summary.title}`);
  console.log(`[smoke-summary] recap:  ${summary.recap}\n`);
  summary.insights.forEach((ins, i) => {
    console.log(`  ${i + 1}. takeaway: ${ins.takeaway}`);
    if (ins.quote) console.log(`     quote:    "${ins.quote}"`);
    if (ins.assisted) console.log(`     ↳ ${ins.via}`);
  });

  // --- Hard checks: shape the renderer depends on ---
  if (summary.insights.length < 2) {
    console.error(`[smoke-summary] FAIL — expected >=2 insights, got ${summary.insights.length}`);
    failures++;
  }
  const emptyTakeaway = summary.insights.filter((i) => !i.takeaway || !i.takeaway.trim());
  if (emptyTakeaway.length > 0) {
    console.error(`[smoke-summary] FAIL — ${emptyTakeaway.length} insight(s) have an empty takeaway`);
    failures++;
  }
  const leaked = Object.keys(summary as Record<string, unknown>).filter((k) =>
    ["stat", "questionsNotAsked"].includes(k),
  );
  if (leaked.length > 0) {
    console.error(`[smoke-summary] FAIL — legacy field(s) present: ${leaked.join(", ")}`);
    failures++;
  }

  // --- Soft checks: the design intent (printed, warned, never hard-fail) ---
  const withQuote = summary.insights.filter((i) => i.quote && i.quote.trim()).length;
  console.log(`\n[smoke-summary] quote coverage: ${withQuote}/${summary.insights.length}`);
  if (withQuote === 0) warn("no insight carried a quote — prompt should lean quote-heavy");

  const assisted = summary.insights.filter((i) => i.assisted);
  console.log(`[smoke-summary] assisted insights: ${assisted.length}`);
  if (assisted.length === 0) {
    warn("no insight credited Ruby — the renewal nudge was plainly acted on; check under-claiming");
  } else if (assisted.some((i) => !i.via || !i.via.trim())) {
    warn("an assisted insight is missing its `via` clause");
  }

  console.log(`\n[smoke-summary] ${failures === 0 ? "PASS" : "FAIL"} (${failures} hard failure(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
