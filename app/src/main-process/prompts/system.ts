import type { CallSetup, ChecklistItem } from "../types";
import { loadBase, loadSkillFragment } from "./loader";

export { listAvailableSkills } from "./loader";

/**
 * Build the in-call agent's system prompt.
 *
 * Assembly is a list of conditional sections, joined with blank lines:
 *   - the invariant base (always present), optionally followed by a skill's
 *     in-call playbook fragment (only when a skill is set)
 *   - `## Direction` — the synthesized prose paragraph; the PRIMARY driver of
 *     nudges. Rendered first (above goal/checklist) when set.
 *   - `## Goal` — only when a goal was set (it sharpens the direction; it is
 *     optional and not load-bearing)
 *   - `## Checklist` — only when the checklist is non-empty; a secondary
 *     "don't-forget" backstop, NOT the nudge engine
 *   - `## Background context` — only when there's any context to show
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
    parts.push(
      "## Direction (your primary steer)\n" +
        "This is what a good call looks like for the user — what to explore and " +
        "the stance to carry. Let it drive your nudges: surface follow-ups, " +
        "pivots, and reminders that serve this direction as the live conversation " +
        "opens them up.\n\n" +
        direction,
    );
  }

  const goal = setup.goal?.trim();
  if (goal) {
    parts.push(`## Goal of this call\n${goal}`);
  }

  if (setup.checklist.length) {
    const checklistBlock = setup.checklist
      .map((c) => `- (${c.status}) [${c.id}] ${c.text}`)
      .join("\n");
    parts.push(
      "## Checklist (secondary — concrete don't-forget items)\n" +
        "These are specific items the user flagged. They are a backstop, NOT the " +
        "engine — the Direction above drives your nudges. Surface a checklist item " +
        "only when it fits the live thread, or near a wrap-up if it's still open. " +
        "The status markers tell you what's already been touched.\n\n" +
        checklistBlock,
    );
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
