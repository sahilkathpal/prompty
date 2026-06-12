// Deterministic smoke test for direct rail editing + state re-injection.
// No quota: uses the MOCK prep session for the handle-method/trace checks and
// the exported pure `buildPrepStatePreamble` for the preamble-shape checks.
//
// Pass criteria:
//   - setGoal / add / edit / removeChecklistItem mutate state correctly
//   - each direct edit pushes a `You …` role:tool trace with the right toolName
//   - buildPrepStatePreamble renders goal/skill/items, with (not set yet) /
//     (none yet) / (none) placeholders, and is clearly fenced as [current-state]

process.env.PROMPTY_MOCK_PREP = "1";

import assert from "node:assert";
import {
  openPrepSession,
  buildPrepStatePreamble,
} from "../src/main-process/prep-session";
import type { CalendarEvent } from "../src/main-process/calendar-arm";

const fakeEvent: CalendarEvent = {
  id: "edit-smoke-1",
  title: "Edit smoke",
  startsAt: Date.now() + 10 * 60_000,
  attendees: [],
};

function lastTrace(session: Awaited<ReturnType<typeof openPrepSession>>) {
  const s = session.getState();
  return [...s.messages].reverse().find((m) => m.role === "tool");
}

async function main() {
  const session = await openPrepSession(fakeEvent);

  // --- setGoal ---------------------------------------------------------------
  session.setGoal("Get Alex to commit to a 2-week pilot");
  let s = session.getState();
  assert.equal(s.goal, "Get Alex to commit to a 2-week pilot", "goal set");
  let tr = lastTrace(session);
  assert.equal(tr?.toolName, "set_goal", "setGoal trace toolName");
  assert.ok(tr?.text.startsWith("You set goal:"), "setGoal trace says 'You …'");

  // --- setDirection ----------------------------------------------------------
  session.setDirection(
    "Explore how Alex runs ingestion today; stay curious, gauge fit before pitching.",
  );
  s = session.getState();
  assert.equal(
    s.direction,
    "Explore how Alex runs ingestion today; stay curious, gauge fit before pitching.",
    "direction set",
  );
  assert.equal(
    session.snapshot().direction,
    "Explore how Alex runs ingestion today; stay curious, gauge fit before pitching.",
    "snapshot carries direction",
  );
  tr = lastTrace(session);
  assert.equal(tr?.toolName, "set_direction", "setDirection trace toolName");
  assert.ok(
    tr?.text.startsWith("You set direction:"),
    "setDirection trace says 'You …'",
  );

  // --- addChecklistItem (×3) -------------------------------------------------
  const a = session.addChecklistItem("Current Kafka spend");
  session.addChecklistItem("Who signs off on budget");
  const c = session.addChecklistItem("Decision timeline");
  s = session.getState();
  assert.equal(s.checklist.length, 3, "3 items added");
  assert.equal(s.checklist[0]!.text, "Current Kafka spend", "first item text");
  assert.equal(s.checklist[0]!.id, a.id, "addChecklistItem returns the item");
  tr = lastTrace(session);
  assert.equal(tr?.toolName, "add_checklist_item", "add trace toolName");
  assert.ok(tr?.text.startsWith("You added:"), "add trace says 'You …'");

  // --- editChecklistItem -----------------------------------------------------
  session.editChecklistItem(a.id, "Current Kafka monthly spend");
  s = session.getState();
  assert.equal(
    s.checklist.find((x) => x.id === a.id)?.text,
    "Current Kafka monthly spend",
    "item edited",
  );
  tr = lastTrace(session);
  assert.equal(tr?.toolName, "update_checklist_item", "edit trace toolName");
  assert.ok(tr?.text.startsWith("You edited:"), "edit trace says 'You …'");

  // --- removeChecklistItem ---------------------------------------------------
  session.removeChecklistItem(c.id);
  s = session.getState();
  assert.equal(s.checklist.length, 2, "1 item removed");
  assert.ok(
    !s.checklist.some((x) => x.id === c.id),
    "removed item is gone",
  );
  tr = lastTrace(session);
  assert.equal(tr?.toolName, "remove_checklist_item", "remove trace toolName");
  assert.ok(
    tr?.text.startsWith("You removed: Decision timeline"),
    "remove trace names the removed text",
  );

  // --- setNotes --------------------------------------------------------------
  session.setNotes("Skeptical CTO — mention SOC2.");
  s = session.getState();
  assert.equal(s.notes, "Skeptical CTO — mention SOC2.", "notes set");
  assert.equal(
    session.snapshot().notes,
    "Skeptical CTO — mention SOC2.",
    "snapshot carries notes",
  );
  tr = lastTrace(session);
  assert.equal(tr?.toolName, "set_notes", "setNotes trace toolName");

  // --- setSkill (and clearing it) -------------------------------------------
  session.setSkill("discovery");
  s = session.getState();
  assert.equal(s.skill, "discovery", "skill set");
  tr = lastTrace(session);
  assert.equal(tr?.toolName, "set_skill", "setSkill trace toolName");
  assert.ok(tr?.text.startsWith("Set skill: discovery"), "setSkill trace text");
  session.setSkill(""); // empty clears it — the resting state
  assert.equal(session.getState().skill, "", "skill cleared");
  assert.throws(() => session.setSkill("not-a-real-skill"), "unknown skill rejected");

  // --- empty input is rejected ----------------------------------------------
  assert.throws(() => session.setGoal("   "), "empty goal rejected");
  assert.throws(() => session.setDirection("   "), "empty direction rejected");
  assert.throws(() => session.addChecklistItem(""), "empty item rejected");

  await session.close();

  // --- preamble shape (pure helper) -----------------------------------------
  const full = buildPrepStatePreamble(
    "Get Alex to commit",
    "Explore ingestion pain; stay curious, gauge fit before pitching.",
    [
      { id: "1", text: "Current Kafka spend", status: "open" },
      { id: "2", text: "Decision timeline", status: "open" },
    ],
    "discovery",
    "Skeptical CTO — mention SOC2.",
  );
  assert.ok(full.startsWith("[current-state]"), "preamble is fenced");
  assert.ok(full.includes("[/current-state]"), "preamble closes the fence");
  assert.ok(full.includes("goal: Get Alex to commit"), "preamble has goal");
  assert.ok(
    full.includes("direction: Explore ingestion pain"),
    "preamble has direction",
  );
  assert.ok(full.includes("skill: discovery"), "preamble has skill");
  assert.ok(full.includes("- Current Kafka spend"), "preamble lists item 1");
  assert.ok(full.includes("- Decision timeline"), "preamble lists item 2");
  assert.ok(full.includes("notes: Skeptical CTO"), "preamble has notes");

  const empty = buildPrepStatePreamble("", "", [], "");
  assert.ok(empty.includes("goal: (not set yet)"), "empty goal placeholder");
  assert.ok(
    empty.includes("direction: (not set yet)"),
    "empty direction placeholder",
  );
  assert.ok(empty.includes("skill: (none)"), "empty skill placeholder");
  assert.ok(empty.includes("(none yet)"), "empty checklist placeholder");
  assert.ok(empty.includes("notes: (none)"), "empty notes placeholder");

  console.log("[smoke-prep-edit] PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("[smoke-prep-edit] FAIL");
  console.error(e);
  process.exit(1);
});
