import { openPrepAgent } from "../src/main-process/prep-agent";

/**
 * Smoke test for the prep chat agent (RUBY B2 phase 2b). Spawns the user's
 * `claude` CLI — consumes a small amount of subscription quota. Exercises the
 * REAL path the mock E2E can't: prep.md loading, multi-turn streaming, and the
 * update_direction tool. Pass criteria: at least one assistant reply, at least
 * one direction rewrite, no errors.
 *
 * Skipped automatically under PROMPTY_MOCK_AGENT=1 (the deterministic mock makes
 * the assertions trivially true and defeats the point).
 */

async function main() {
  if (process.env.PROMPTY_MOCK_AGENT === "1") {
    console.log("[smoke-prep] skipped (PROMPTY_MOCK_AGENT=1)");
    process.exit(0);
  }

  const assistantReplies: string[] = [];
  const directions: string[] = [];
  const componentSets: unknown[][] = [];
  const errors: Error[] = [];
  let deltaCount = 0;

  console.log("[smoke-prep] opening prep agent…");
  const prep = await openPrepAgent("", {
    onAssistantDelta: () => {
      deltaCount++;
    },
    onAssistant: (text) => {
      assistantReplies.push(text);
      console.log(`[smoke-prep] RUBY: ${text}`);
    },
    onDirection: (direction) => {
      directions.push(direction);
      console.log(`[smoke-prep] DIRECTION (${direction.length} chars):\n${direction}\n`);
    },
    onComponents: (components) => {
      componentSets.push(components);
      console.log(`[smoke-prep] COMPONENTS: ${JSON.stringify(components)}`);
    },
    onError: (e) => {
      errors.push(e);
      console.log(`[smoke-prep] ERROR: ${e.message}`);
    },
  });

  // We sell Revise, an AI call-coach. The context is spelled out so the model
  // has no reason to keep interviewing, and the last turn forces the write.
  const turns = [
    "I sell Revise, an AI real-time call coach for sales teams. I've got a discovery call with a fintech startup in 20 minutes and want to qualify fit.",
    "They're Series A, ~30 people, and their reps do a lot of live calls. I need to learn their current tooling and whether they have budget this quarter.",
    "That's all the context. Call set_goal and set_checklist and write the direction now with update_direction — don't ask any more questions.",
  ];
  for (let i = 0; i < turns.length; i++) {
    console.log(`\n[smoke-prep] turn ${i + 1}…`);
    const t0 = Date.now();
    await prep.send(turns[i]!);
    console.log(`[smoke-prep] turn ${i + 1} done in ${Date.now() - t0}ms`);
  }

  await prep.close();

  console.log("\n[smoke-prep] summary:");
  console.log(`  assistant replies: ${assistantReplies.length}`);
  console.log(`  streamed deltas: ${deltaCount}`);
  console.log(`  direction rewrites: ${directions.length}`);
  console.log(`  component updates: ${componentSets.length}`);
  console.log(`  errors: ${errors.length}`);

  const pass =
    errors.length === 0 &&
    assistantReplies.length >= 1 &&
    deltaCount > 0 &&
    directions.length >= 1;

  console.log(`\n[smoke-prep] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
