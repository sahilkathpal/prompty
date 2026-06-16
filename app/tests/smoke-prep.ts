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
  const errors: Error[] = [];

  console.log("[smoke-prep] opening prep agent…");
  const prep = await openPrepAgent("", {
    onAssistant: (text) => {
      assistantReplies.push(text);
      console.log(`[smoke-prep] RUBY: ${text}`);
    },
    onDirection: (direction) => {
      directions.push(direction);
      console.log(`[smoke-prep] DIRECTION (${direction.length} chars):\n${direction}\n`);
    },
    onError: (e) => {
      errors.push(e);
      console.log(`[smoke-prep] ERROR: ${e.message}`);
    },
  });

  const turns = [
    "I've got a discovery call with a fintech startup in 20 minutes. I want to figure out if they're a real fit for us.",
    "It's a Series A, ~30 people. I mainly need to know their current tooling and whether they have budget this quarter. Please write the direction.",
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
  console.log(`  direction rewrites: ${directions.length}`);
  console.log(`  errors: ${errors.length}`);

  const pass =
    errors.length === 0 &&
    assistantReplies.length >= 1 &&
    directions.length >= 1;

  console.log(`\n[smoke-prep] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
