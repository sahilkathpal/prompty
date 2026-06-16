// Prep agent system prompt assembly (RUBY B2 phase 2b).
//
// Like system.ts for the in-call agent, this is a thin slot-filler: the prep
// doctrine lives in prep.md (the editable prose), and we append the current
// working direction so the agent knows where the shared draft stands.

import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadPrepBase(): string {
  return readFileSync(join(__dirname, "prep.md"), "utf8");
}

export function loadPrepPrompt(workingDirection: string): string {
  const dir = workingDirection.trim();
  const section = dir
    ? `## Current working direction\n${dir}`
    : "## Current working direction\n(empty — the user hasn't drafted one yet; help them build it from scratch.)";
  return `${loadPrepBase()}\n\n${section}`;
}
