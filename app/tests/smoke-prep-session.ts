// Smoke test for Stage 4 prep-session — drives a real claude conversation
// with a fake calendar event over ~4 user turns. Consumes a small amount
// of subscription quota.
//
// Pass criteria:
//   - set_goal was called at least once (state.goal non-empty)
//   - add_checklist_item was called ≥ 2 times (state.checklist.length ≥ 2)

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
    "That's enough context, draft the checklist.",
  ];

  for (let i = 0; i < userTurns.length; i++) {
    const t = userTurns[i]!;
    console.log(`\n[smoke-prep] user turn ${i + 1}: ${t}`);
    const t0 = Date.now();
    await session.sendMessage(t);
    const s = session.getState();
    const lastAssistant = [...s.messages].reverse().find((m) => m.role === "assistant");
    console.log(
      `[smoke-prep] turn ${i + 1} done in ${Date.now() - t0}ms — goal="${s.goal.slice(0, 60)}", checklist=${s.checklist.length}`,
    );
    if (lastAssistant) {
      console.log(`[smoke-prep]   assistant: ${lastAssistant.text.slice(0, 160)}…`);
    }
  }

  const final = session.getState();
  await session.close();

  console.log("\n[smoke-prep] final state:");
  console.log(`  goal: "${final.goal}"`);
  console.log(`  checklist: ${final.checklist.length} items`);
  for (const c of final.checklist) {
    console.log(`    - ${c.text}`);
  }

  const validModes = ["default", "discovery", "user-interview", "hiring"];
  if (final.mode && validModes.includes(final.mode)) {
    console.log(`[smoke-prep] mode: "${final.mode}" (valid)`);
  } else {
    console.warn(
      `[smoke-prep] WARN: set_mode was not reliably called (mode="${final.mode}"). ` +
        `Real-LLM behavior is best-effort; mock test covers the mechanical path.`,
    );
  }

  const pass = !!final.goal && final.checklist.length >= 2;
  console.log(`\n[smoke-prep] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
