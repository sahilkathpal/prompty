// Smoke test for in-call system-prompt assembly — no claude, no electron.
// Verifies conditional-section composition (base + optional skill fragment +
// optional direction/notes) and skill-folder resolution.
//
// Goal/Checklist were cut from the MVP (RUBY_MVP §4): the direction is the
// whole brief, and goal/checklist were removed from CallSetup. The assembled
// prompt must never render a Goal or Checklist section.

import { buildSystemPrompt } from "../src/main-process/prompts/system";
import { loadSkillFragment, listAvailableSkills } from "../src/main-process/prompts/loader";
import type { CallSetup } from "../src/shared/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[smoke-system-prompt] FAIL — ${msg}`);
    process.exit(1);
  }
}

// 1) No skill, no prep: just base. No optional sections, no playbook, no throw.
const bare: CallSetup = { context: {} };
const bareP = buildSystemPrompt(bare);
assert(!bareP.includes("{{"), "bare prompt still has {{placeholders}}");
assert(
  !bareP.includes("## Direction\n"),
  "bare prompt should omit the Direction section",
);
assert(
  !bareP.includes("## Goal\n"),
  "bare prompt should omit the Goal section",
);
assert(
  !bareP.includes("## Checklist\n"),
  "bare prompt should omit the checklist section",
);
assert(
  !bareP.includes("## Background context"),
  "bare prompt should omit the context section",
);
assert(bareP.includes("real-time call coach"), "bare prompt should include the base role");
assert(
  !bareP.includes("## Playbook:"),
  "no-skill prompt should append no playbook section",
);

// 2) Full + skill: direction + notes + the skill playbook. The MVP prompt has
//    no Goal/Checklist sections (those fields are gone from CallSetup) — the
//    direction is the whole brief.
const full: CallSetup = {
  direction:
    "Explore their ingestion pain before pitching; stay curious and qualify fit.",
  context: { manualNotes: "Skeptical CTO — mention SOC2." },
  skill: "discovery",
};
const fullP = buildSystemPrompt(full);
assert(
  fullP.includes("## Direction\n"),
  "full prompt missing Direction section",
);
assert(
  fullP.includes("Explore their ingestion pain before pitching"),
  "full prompt missing direction text",
);
assert(!fullP.includes("## Goal\n"), "MVP prompt should not render a Goal section");
assert(
  !fullP.includes("## Checklist\n"),
  "MVP prompt should not render a Checklist section",
);
assert(fullP.includes("## Background context"), "full prompt missing context section");
assert(fullP.includes("Skeptical CTO — mention SOC2."), "full prompt missing notes");
assert(
  fullP.includes("sales discovery"),
  "discovery prompt should include the discovery playbook",
);
// Direction must render above the background context (priority order).
assert(
  fullP.indexOf("## Direction\n") < fullP.indexOf("## Background context"),
  "Direction section should precede the Background context section",
);

// 3) Unknown skill appends no fragment (no throw, no leak).
const unknown: CallSetup = { context: {}, skill: "no-such-skill" };
const unknownP = buildSystemPrompt(unknown);
assert(
  !unknownP.includes("## Playbook:"),
  "unknown skill should append no playbook section",
);
assert(unknownP.includes("real-time call coach"), "unknown-skill prompt still has the base");

// 4) in-call fragment loads for a known skill; "" for empty/unknown skill (no
//    default fallback exists anymore). (Prep playbooks were removed in the Ruby
//    MVP strip — prep is a cut feature — so only the in-call fragment remains.)
assert(
  loadSkillFragment("user-interview", "in-call").trim().length > 0,
  "user-interview in-call fragment should be non-empty",
);
assert(loadSkillFragment("", "in-call") === "", "empty skill in-call fragment should be ''");
assert(
  loadSkillFragment("no-such-skill", "in-call") === "",
  "unknown skill in-call fragment should be ''",
);

// 5) listAvailableSkills finds the three bundled skill folders (no `default`).
const skills = listAvailableSkills().map((s) => s.name).sort();
for (const s of ["discovery", "hiring", "user-interview"]) {
  assert(skills.includes(s), `listAvailableSkills missing "${s}" (got ${skills.join(",")})`);
}
assert(!skills.includes("default"), "default skill should have been removed");

console.log("[smoke-system-prompt] PASS");
process.exit(0);
