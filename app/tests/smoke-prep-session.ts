// Smoke test for Stage 4 prep-session — drives a real claude conversation
// with a fake calendar event over ~4 user turns. Consumes a small amount
// of subscription quota.
//
// Pass criteria:
//   - set_direction was called (state.direction non-empty) — the required
//     primary artifact. Goal and checklist are now optional, so we no longer
//     assert on them (a zero-item checklist is a healthy, normal outcome).

// Ensure we use the REAL prep session, not the mock.
delete process.env.PROMPTY_MOCK_PREP;

import { openPrepSession } from "../src/main-process/prep-session";
import type { CalendarEvent } from "../src/main-process/calendar-arm";

const fakeEvent: CalendarEvent = {
  id: "smoke-1",
  title: "Discovery call with Linear about Kafka",
  startsAt: Date.now() + 12 * 60_000,
  attendees: [{ name: "Alex Chen", email: "alex@linear.app" }],
};

async function main() {
  console.log("[smoke-prep] opening prep session…");
  const session = await openPrepSession(fakeEvent);

  session.on("assistant-chunk", () => {
    // swallow streaming chunks
  });
  session.on("error", (e) => {
    console.error("[smoke-prep] session error:", e.message);
  });

  const userTurns = [
    "Hi — this is a discovery call with Linear. I want to figure out if they need our managed Kafka product.",
    "Their platform team is around 5 engineers. They're using self-hosted Kafka right now and complaining about operational overhead.",
    "Budget — I want to confirm they have a real budget line for streaming infra, and figure out their timeline for switching.",
    "That's enough context — lock in the direction.",
  ];

  for (let i = 0; i < userTurns.length; i++) {
    const t = userTurns[i]!;
    console.log(`\n[smoke-prep] user turn ${i + 1}: ${t}`);
    const t0 = Date.now();
    await session.sendMessage(t);
    const s = session.getState();
    const lastAssistant = [...s.messages].reverse().find((m) => m.role === "assistant");
    console.log(
      `[smoke-prep] turn ${i + 1} done in ${Date.now() - t0}ms — goal="${s.goal.slice(0, 60)}", direction=${s.direction.length}ch, checklist=${s.checklist.length}`,
    );
    if (lastAssistant) {
      console.log(`[smoke-prep]   assistant: ${lastAssistant.text.slice(0, 160)}…`);
    }
  }

  const final = session.getState();
  await session.close();

  console.log("\n[smoke-prep] final state:");
  console.log(`  goal: "${final.goal}"`);
  console.log(`  direction: "${final.direction}"`);
  console.log(`  checklist: ${final.checklist.length} items`);
  for (const c of final.checklist) {
    console.log(`    - ${c.text}`);
  }

  // Skill is now OPTIONAL — empty is a healthy, normal outcome. When set, it
  // must be a known skill; set_skill should only fire when the call clearly
  // fits one (this fixture is an obvious discovery call, so it often will).
  const validSkills = ["discovery", "user-interview", "hiring"];
  if (!final.skill) {
    console.log(`[smoke-prep] skill: (none) — valid, no skill is the default`);
  } else if (validSkills.includes(final.skill)) {
    console.log(`[smoke-prep] skill: "${final.skill}" (valid)`);
  } else {
    console.error(`[smoke-prep] FAIL: invalid skill "${final.skill}"`);
    process.exit(1);
  }

  const pass = !!final.direction.trim();
  console.log(`\n[smoke-prep] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
