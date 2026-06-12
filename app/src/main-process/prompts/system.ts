import type { CallSetup, ChecklistItem } from "../types";
import { loadBase, loadSkillFragment } from "./loader";

export { listAvailableSkills } from "./loader";

/**
 * Build the in-call agent's system prompt.
 *
 * This is a pure slot-filler: ALL coaching philosophy lives in base.md (the
 * single editable prose file). Here we only stitch the invariant base, an
 * optional skill playbook, and the per-call data into labelled sections. The
 * section headers (`## Direction`, `## Goal`, `## Checklist`,
 * `## Background context`) are the labels base.md tells the coach to read —
 * keep them in sync with base.md's prose, but put no guidance here.
 *
 * Assembly is a list of conditional sections joined with blank lines:
 *   - the invariant base (always present), optionally followed by a skill's
 *     in-call playbook fragment (only when a skill is set)
 *   - `## Direction`, `## Goal`, `## Checklist`, `## Background context` —
 *     each rendered only when its value is present, in priority order.
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

  const direction = setup.direction?.trim();
  if (direction) {
    parts.push(`## Direction\n${direction}`);
  }

  const goal = setup.goal?.trim();
  if (goal) {
    parts.push(`## Goal\n${goal}`);
  }

  if (setup.checklist.length) {
    const checklistBlock = setup.checklist
      .map((c) => `- (${c.status}) [${c.id}] ${c.text}`)
      .join("\n");
    parts.push(`## Checklist\n${checklistBlock}`);
  }

  const contextBlock = formatContext(setup.context);
  if (contextBlock) {
    parts.push(`## Background context\n${contextBlock}`);
  }

  return parts.join("\n\n");
}

function formatContext(ctx: CallSetup["context"]): string {
  const parts: string[] = [];
  if (ctx.attendee) {
    const a = ctx.attendee;
    const lines = [
      a.name && `Name: ${a.name}`,
      a.email && `Email: ${a.email}`,
      a.company && `Company: ${a.company}`,
      a.summary && `Summary: ${a.summary}`,
      a.bio && `Bio: ${a.bio}`,
    ].filter(Boolean);
    if (lines.length) parts.push("### Attendee\n" + lines.join("\n"));
  }
  if (ctx.attioNotes?.length) {
    parts.push(
      "### Prior notes (CRM)\n" + ctx.attioNotes.map((n) => `- ${n}`).join("\n"),
    );
  }
  if (ctx.manualNotes?.trim()) {
    parts.push("### Notes (user's framing for this call)\n" + ctx.manualNotes.trim());
  }
  return parts.join("\n\n");
}

export function describeChecklist(items: ChecklistItem[]): string {
  return items
    .map((c) => `- [${c.id}] (${c.status}) ${c.text}`)
    .join("\n");
}
