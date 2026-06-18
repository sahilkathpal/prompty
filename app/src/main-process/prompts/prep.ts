// Prep agent system prompt assembly (RUBY B2 phase 2b).
//
// Like system.ts for the in-call agent, this is a thin slot-filler: the prep
// doctrine lives in prep.md (the editable prose), and we append the current
// working direction so the agent knows where the shared draft stands.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrepComponent } from "../types";

function loadPrepBase(): string {
  return readFileSync(join(__dirname, "prep.md"), "utf8");
}

// Render any already-pinned components so the model can SEE them — without this
// the agent has no idea a goal/checklist exists (the tools only carry state), so
// it can't acknowledge them on a resumed prep.
function pinnedSection(components: PrepComponent[]): string {
  if (components.length === 0) return "";
  const lines: string[] = [];
  for (const c of components) {
    if (c.type === "goal") {
      lines.push(`- Goal: ${c.text}`);
    } else {
      const title = c.title?.trim() || "Checklist";
      const items = c.items.map((it) => `  - ${it.done ? "[x]" : "[ ]"} ${it.text}`).join("\n");
      lines.push(`- ${title}:\n${items}`);
    }
  }
  return `\n\n## Already pinned (from an earlier prep)\nThe user already has these pinned from before — acknowledge them in your opening instead of asking to create them:\n${lines.join("\n")}`;
}

export function loadPrepPrompt(
  workingDirection: string,
  components: PrepComponent[] = [],
): string {
  const dir = workingDirection.trim();
  const section = dir
    ? `## Current working direction\n${dir}`
    : "## Current working direction\n(empty — the user hasn't drafted one yet; help them build it from scratch.)";
  return `${loadPrepBase()}\n\n${section}${pinnedSection(components)}`;
}
