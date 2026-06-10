// Smoke test for in-call system-prompt assembly — no claude, no electron.
// Verifies conditional-section composition (base + mode fragment + optional
// goal/checklist/notes) and mode-folder resolution.

import { buildSystemPrompt } from "../src/main-process/prompts/system";
import { loadModeFragment, listAvailableModes } from "../src/main-process/prompts/loader";
import type { CallSetup } from "../src/shared/types";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[smoke-system-prompt] FAIL — ${msg}`);
    process.exit(1);
  }
}

// 1) Mode-only (no prep): no goal/checklist/context → no optional sections,
//    no leftover placeholders.
const bare: CallSetup = { goal: "", checklist: [], context: {}, mode: "default" };
const bareP = buildSystemPrompt(bare);
assert(!bareP.includes("{{"), "bare prompt still has {{placeholders}}");
assert(
  !bareP.includes("## Goal of this call"),
  "bare prompt should omit the Goal section",
);
assert(
  !bareP.includes("## Tracks to listen for"),
  "bare prompt should omit the checklist section",
);
assert(
  !bareP.includes("## Background context"),
  "bare prompt should omit the context section",
);
assert(bareP.includes("in-ear coach"), "bare prompt should include the base role");
assert(
  bareP.includes("general conversation"),
  "bare prompt should include the default mode fragment",
);

// 2) Full: goal + checklist + notes → all three sections present.
const full: CallSetup = {
  goal: "Get them to commit to a 2-week pilot",
  checklist: [
    { id: "c1", text: "Budget authority", status: "open" },
    { id: "c2", text: "Current tooling", status: "partial" },
  ],
  context: { manualNotes: "Skeptical CTO — mention SOC2." },
  mode: "discovery",
};
const fullP = buildSystemPrompt(full);
assert(fullP.includes("## Goal of this call"), "full prompt missing Goal section");
assert(
  fullP.includes("Get them to commit to a 2-week pilot"),
  "full prompt missing goal text",
);
assert(
  fullP.includes("## Tracks to listen for (checklist)"),
  "full prompt missing checklist section",
);
assert(fullP.includes("[c1]") && fullP.includes("Budget authority"), "missing checklist item");
assert(fullP.includes("## Background context"), "full prompt missing context section");
assert(fullP.includes("Skeptical CTO — mention SOC2."), "full prompt missing notes");
assert(
  fullP.includes("sales discovery"),
  "discovery prompt should include the discovery fragment",
);

// 3) Unknown mode resolves to default in-call (no throw).
const unknown: CallSetup = { goal: "", checklist: [], context: {}, mode: "no-such-mode" };
const unknownP = buildSystemPrompt(unknown);
assert(
  unknownP.includes("general conversation"),
  "unknown mode should fall back to default in-call fragment",
);

// 4) prep fragment loads for a known mode; "" for an unknown mode (no default
//    leak is fine — it falls back to default/prep.md which is non-empty, but a
//    nonexistent fragment name returns "" only when default also lacks it).
assert(
  loadModeFragment("user-interview", "prep").includes("Mom Test"),
  "user-interview prep fragment should mention Mom Test",
);

// 5) listAvailableModes finds the four bundled mode folders.
const modes = listAvailableModes().map((m) => m.name).sort();
for (const m of ["default", "discovery", "hiring", "user-interview"]) {
  assert(modes.includes(m), `listAvailableModes missing "${m}" (got ${modes.join(",")})`);
}

console.log("[smoke-system-prompt] PASS");
process.exit(0);
