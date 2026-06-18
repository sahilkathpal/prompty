import { openPrepAgent } from "../src/main-process/prep-agent";

/**
 * Real-agent smoke for the NEW opening turn (PrepAgent.open()). Spawns the real
 * `claude` CLI. Verifies, against the live model:
 *   1. FRESH: open() produces a reflect-and-fork opening that does NOT rewrite the
 *      direction (no Focus: fold) and does NOT pin/offer components on turn 1.
 *   2. RESUME: open() with components already attached acknowledges them.
 * Prints the actual replies so a human can judge the content quality too.
 */

type Caps = {
  replies: string[];
  directions: string[];
  componentSets: unknown[][];
  errors: Error[];
};

function events(c: Caps) {
  return {
    onAssistantDelta: () => {},
    onAssistant: (text: string) => c.replies.push(text),
    onDirection: (d: string) => c.directions.push(d),
    onComponents: (comp: unknown[]) => c.componentSets.push(comp),
    onError: (e: Error) => c.errors.push(e),
  };
}

async function main() {
  if (process.env.PROMPTY_MOCK_AGENT === "1") {
    console.log("[smoke-open-turn] skipped (PROMPTY_MOCK_AGENT=1)");
    process.exit(0);
  }

  // ===== Case 1: FRESH opening turn =====
  const c1: Caps = { replies: [], directions: [], componentSets: [], errors: [] };
  const brief = "Discovery call with Acme about their renewal";
  console.log(`[smoke-open-turn] FRESH open() with brief: "${brief}"`);
  const a1 = await openPrepAgent(brief, events(c1));
  const t0 = Date.now();
  await a1.open();
  await a1.close();
  console.log(`[smoke-open-turn] opening turn in ${Date.now() - t0}ms`);
  for (const r of c1.replies) console.log(`[smoke-open-turn] RUBY (fresh): ${r}`);

  const opening = c1.replies.join(" ").toLowerCase();
  const fresh = {
    gotReply: c1.replies.length >= 1,
    asksFork: /(flesh|expand|dig|go deeper|more)/.test(opening) && /(start|go|ready|listen)/.test(opening),
    noFold: c1.directions.length === 0,
    noComponents: c1.componentSets.length === 0,
    noError: c1.errors.length === 0,
  };
  console.log(`[smoke-open-turn] FRESH checks: ${JSON.stringify(fresh)}`);

  // ===== Case 2: RESUME opening turn (components already pinned) =====
  const c2: Caps = { replies: [], directions: [], componentSets: [], errors: [] };
  const pinned = [
    { type: "goal", id: "g1", text: "Get a clear read on renewal risk" },
    {
      type: "checklist",
      id: "c1",
      title: "Cover",
      items: [
        { id: "i1", text: "Their value realization so far", done: false },
        { id: "i2", text: "Who owns the renewal budget", done: false },
      ],
    },
  ];
  console.log(`\n[smoke-open-turn] RESUME open() with a goal + checklist pinned`);
  const a2 = await openPrepAgent(brief, events(c2), pinned as never);
  await a2.open();
  await a2.close();
  for (const r of c2.replies) console.log(`[smoke-open-turn] RUBY (resume): ${r}`);
  const resumeText = c2.replies.join(" ").toLowerCase();
  const resume = {
    gotReply: c2.replies.length >= 1,
    acknowledgesPinned: /(goal|checklist|pinned|already|still)/.test(resumeText),
    noError: c2.errors.length === 0,
  };
  console.log(`[smoke-open-turn] RESUME checks: ${JSON.stringify(resume)}`);

  const pass =
    fresh.gotReply && fresh.noFold && fresh.noComponents && fresh.noError &&
    resume.gotReply && resume.noError;
  // asksFork / acknowledgesPinned are content-quality signals — reported, not
  // hard-failed (the heuristic regex can miss a valid phrasing).
  console.log(`\n[smoke-open-turn] structural ${pass ? "PASS" : "FAIL"}`);
  console.log(`[smoke-open-turn] content signals — fresh asksFork=${fresh.asksFork}, resume acknowledgesPinned=${resume.acknowledgesPinned} (judge from the printed replies)`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
