import type { CallSetup, ChecklistItem } from "../types";
import { DEFAULT_MODE, loadBase, loadModeFragment } from "./loader";

export { listAvailableModes } from "./loader";

/**
 * Build the in-call agent's system prompt.
 *
 * Assembly is a list of conditional sections, joined with blank lines:
 *   - the invariant base + the mode's in-call flavor fragment (always present)
 *   - `## Goal` — only when a goal was set (it sharpens the fragment's intrinsic
 *     objective; it is not load-bearing)
 *   - `## Tracks` — only when the checklist is non-empty
 *   - `## Background context` — only when there's any context to show
 *
 * Absent optional pieces produce NO section at all (never a "(none)" line that
 * would mis-tell the coach there is nothing to do).
 */
export function buildSystemPrompt(setup: CallSetup): string {
  const mode = (setup.mode || DEFAULT_MODE).trim();
  const parts: string[] = [loadBase(), loadModeFragment(mode, "in-call")];

  const goal = setup.goal?.trim();
  if (goal) {
    parts.push(`## Goal of this call\n${goal}`);
  }

  if (setup.checklist.length) {
    const checklistBlock = setup.checklist
      .map((c) => `- (${c.status}) [${c.id}] ${c.text}`)
      .join("\n");
    parts.push(
      "## Tracks to listen for (checklist)\n" +
        "Treat these as parallel themes the user wants to learn about. They are " +
        "directional, not sequential. The status markers tell you what's already " +
        "been touched.\n\n" +
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
