import { openAgent } from "../agent.ts";
import type { CallSetup, Nudge, TranscriptUtterance } from "../types.ts";

/**
 * Smoke test for the Agent SDK nudge loop.
 *
 * This actually calls Claude via the Agent SDK — it spawns the `claude` CLI as
 * a subprocess and consumes a small amount of subscription quota. Keep the
 * canned transcript SHORT.
 *
 * Pass criteria:
 *   - At least one tool call across all turns (nudge OR checklist OR quiet).
 *   - At least one stay_quiet OR at least one nudge — i.e. the model is using
 *     the structured tools rather than emitting freeform prose.
 *   - No errors.
 */

const setup: CallSetup = {
  goal: "Learn about the prospect's migration to Kafka and whether they have budget for managed streaming.",
  checklist: [
    { id: "timeline", text: "Ask when the Kafka migration started and finished", status: "open" },
    { id: "team", text: "Ask how big the platform team is", status: "open" },
    { id: "pain", text: "Ask what pain points they're hitting at current scale", status: "open" },
    { id: "budget", text: "Ask if streaming has a dedicated budget line", status: "open" },
  ],
  context: {
    attendee: {
      name: "Alex Chen",
      company: "Linear",
      bio: "Staff engineer leading their data platform team.",
    },
    attioNotes: ["Mentioned in last call they were evaluating Confluent Cloud vs self-hosted."],
  },
};

const windows: { trigger: "auto" | "hotkey"; utterances: TranscriptUtterance[] }[] = [
  {
    trigger: "auto",
    utterances: [
      utt("them", "Hey, good to see you. How's your week going?"),
      utt("me", "Pretty good, thanks. Yours?"),
      utt("them", "Yeah, busy — we're in the middle of a big infra push."),
    ],
  },
  {
    trigger: "auto",
    utterances: [
      utt("them", "So on our side, we finally finished the Kafka rollout last quarter — took us about eight months end to end."),
      utt("me", "Oh nice. That's faster than I expected actually."),
      utt("them", "Yeah, the platform team is only five people so we had to be pretty surgical about it."),
    ],
  },
  {
    trigger: "hotkey",
    utterances: [
      utt("them", "Anyway, that's the lay of the land. What did you want to dig into?"),
    ],
  },
];

function utt(speaker: "me" | "them", text: string): TranscriptUtterance {
  return { speaker, text, startMs: 0, endMs: 1000, isFinal: true };
}

async function main() {
  const nudges: Nudge[] = [];
  const checklistUpdates: { id: string; status: string }[] = [];
  const stayQuiets: string[] = [];
  const errors: Error[] = [];

  console.log("[smoke] opening agent…");
  const agent = openAgent(setup, {
    onNudge: (n) => {
      nudges.push(n);
      console.log(`[smoke] NUDGE (${n.kind}/${n.urgency}): ${n.text}`);
    },
    onChecklistUpdate: (id, status) => {
      checklistUpdates.push({ id, status });
      console.log(`[smoke] CHECKLIST: ${id} → ${status}`);
    },
    onStayQuiet: (reason) => {
      stayQuiets.push(reason);
      console.log(`[smoke] QUIET: ${reason}`);
    },
    onError: (e) => {
      errors.push(e);
      console.log(`[smoke] ERROR: ${e.message}`);
    },
  });

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]!;
    console.log(`\n[smoke] consider window ${i + 1} (trigger=${w.trigger})…`);
    const t0 = Date.now();
    await agent.consider(w.utterances, w.trigger);
    console.log(`[smoke] window ${i + 1} done in ${Date.now() - t0}ms`);
  }

  await agent.close();

  console.log("\n[smoke] summary:");
  console.log(`  nudges: ${nudges.length}`);
  console.log(`  checklist updates: ${checklistUpdates.length}`);
  console.log(`  stay_quiet: ${stayQuiets.length}`);
  console.log(`  errors: ${errors.length}`);

  const totalDecisions = nudges.length + checklistUpdates.length + stayQuiets.length;
  const pass =
    errors.length === 0 &&
    totalDecisions >= 2 &&
    nudges.length >= 1 &&
    // Hotkey window should have produced an 'answer'-kind nudge.
    nudges.some((n) => n.kind === "answer");

  console.log(`\n[smoke] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
