// Smoke test for in-call system-prompt assembly — no claude, no electron.
// Verifies conditional-section composition (base + optional skill fragment +
// optional goal/checklist/notes) and skill-folder resolution.

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
const bare: CallSetup = { goal: "", checklist: [], context: {} };
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
assert(bareP.includes("in-ear coach"), "bare prompt should include the base role");
assert(
  !bareP.includes("## Playbook:"),
  "no-skill prompt should append no playbook section",
);

// 2) Full + skill: direction + goal + checklist + notes + the skill playbook.
const full: CallSetup = {
  goal: "Get them to commit to a 2-week pilot",
  direction:
    "Explore their ingestion pain before pitching; stay curious and qualify fit.",
  checklist: [
    { id: "c1", text: "Budget authority", status: "open" },
    { id: "c2", text: "Current tooling", status: "partial" },
  ],
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
assert(fullP.includes("## Goal\n"), "full prompt missing Goal section");
assert(
  fullP.includes("Get them to commit to a 2-week pilot"),
  "full prompt missing goal text",
);
assert(
  fullP.includes("## Checklist\n"),
  "full prompt missing checklist section",
);
assert(fullP.includes("[c1]") && fullP.includes("Budget authority"), "missing checklist item");
assert(fullP.includes("## Background context"), "full prompt missing context section");
assert(fullP.includes("Skeptical CTO — mention SOC2."), "full prompt missing notes");
assert(
  fullP.includes("sales discovery"),
  "discovery prompt should include the discovery playbook",
);
// Direction must render above the checklist (priority order).
assert(
  fullP.indexOf("## Direction\n") < fullP.indexOf("## Checklist\n"),
  "Direction section should precede the checklist section",
);

// 3) Unknown skill appends no fragment (no throw, no leak).
const unknown: CallSetup = { goal: "", checklist: [], context: {}, skill: "no-such-skill" };
const unknownP = buildSystemPrompt(unknown);
assert(
  !unknownP.includes("## Playbook:"),
  "unknown skill should append no playbook section",
);
assert(unknownP.includes("in-ear coach"), "unknown-skill prompt still has the base");

// 4) prep fragment loads for a known skill; "" for empty/unknown skill (no
//    default fallback exists anymore).
assert(
  loadSkillFragment("user-interview", "prep").includes("Mom Test"),
  "user-interview prep fragment should mention Mom Test",
);
assert(loadSkillFragment("", "prep") === "", "empty skill prep fragment should be ''");
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
