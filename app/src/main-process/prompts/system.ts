import type { CallSetup } from "../types";
import { loadBase, loadSkillFragment } from "./loader";
import { memoryBlock } from "../memory-store";

export { listAvailableSkills } from "./loader";

/**
 * Build the in-call agent's system prompt.
 *
 * This is a pure slot-filler: ALL coaching philosophy lives in base.md (the
 * single editable prose file). Here we only stitch the invariant base, an
 * optional skill playbook, and the per-call data into labelled sections. The
 * section headers (`## Direction`, `## Goal`, `## Checklist`) are the labels
 * base.md tells the coach to read — keep them in sync with base.md's prose,
 * but put no guidance here.
 *
 * Assembly is a list of conditional sections joined with blank lines:
 *   - the invariant base (always present), optionally followed by a skill's
 *     in-call playbook fragment (only when a skill is set)
 *   - `## What Ruby knows about you`, `## Direction`, and the prep components
 *     `## Goal` / `## Checklist` — each rendered only when its value is present.
 *
 * Goal/Checklist are built during prep (RUBY B3) and folded onto the setup at
 * call start; the direction is still the whole brief when prep is skipped.
 *
 * Absent optional pieces produce NO section at all (never a "(none)" line that
 * would mis-tell the coach there is nothing to do).
 */
export function buildSystemPrompt(setup: CallSetup): string {
  const parts: string[] = [loadBase()];

  const skill = setup.skill?.trim();
  if (skill) {
    const fragment = loadSkillFragment(skill, "in-call").trim();
    if (fragment) parts.push(fragment);
  }

  // The user's standing personalisation (how Ruby should coach them), snapshot
  // onto the setup at session start. Omitted entirely when there are none.
  const memory = memoryBlock(setup.memories ?? []);
  if (memory) {
    parts.push(`## What Ruby knows about you\n${memory}`);
  }

  const direction = setup.direction?.trim();
  if (direction) {
    parts.push(`## Direction\n${direction}`);
  }

  // Composable components built during prep (RUBY B3). The goal names the
  // outcome; the checklist is what's worth covering. Each rendered only when
  // present so a no-prep call shows neither.
  const components = setup.components ?? [];
  const goal = components.find((c) => c.type === "goal");
  if (goal && goal.type === "goal" && goal.text.trim()) {
    parts.push(`## Goal\n${goal.text.trim()}`);
  }
  const checklist = components.find((c) => c.type === "checklist");
  if (checklist && checklist.type === "checklist" && checklist.items.length) {
    const lines = checklist.items
      .map((it) => `- [${it.done ? "x" : " "}] ${it.text} (id: ${it.id})`)
      .join("\n");
    parts.push(`## Checklist\n${lines}`);
  }

  return parts.join("\n\n");
}
