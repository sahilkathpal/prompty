import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CallSetup, ChecklistItem } from "../types";

const BUNDLED_MODES_DIR = join(__dirname, "modes");
const USER_MODES_DIR = join(homedir(), ".prompty", "modes");

const DEFAULT_MODE = "default";

/**
 * Build the system prompt for the in-call agent.
 *
 * Mode resolution order:
 *   1. `~/.prompty/modes/<mode>.md` — user override
 *   2. `<bundled>/modes/<mode>.md` — repo default
 *   3. `<bundled>/modes/default.md` — final fallback
 */
export function buildSystemPrompt(setup: CallSetup): string {
  const mode = (setup.mode || DEFAULT_MODE).trim();
  const template = loadModeTemplate(mode);
  const checklistBlock = setup.checklist
    .map((c) => `- (${c.status}) [${c.id}] ${c.text}`)
    .join("\n");
  const contextBlock = formatContext(setup.context);
  return template
    .replaceAll("{{goal}}", setup.goal)
    .replaceAll("{{checklist}}", checklistBlock || "(none)")
    .replaceAll("{{context}}", contextBlock);
}

export function listAvailableModes(): { name: string; source: "user" | "bundled" }[] {
  const out = new Map<string, "user" | "bundled">();
  for (const f of safeReaddir(BUNDLED_MODES_DIR)) {
    if (f.endsWith(".md")) out.set(f.slice(0, -3), "bundled");
  }
  for (const f of safeReaddir(USER_MODES_DIR)) {
    if (f.endsWith(".md")) out.set(f.slice(0, -3), "user");
  }
  return [...out].map(([name, source]) => ({ name, source }));
}

function loadModeTemplate(mode: string): string {
  const candidates = [
    join(USER_MODES_DIR, `${mode}.md`),
    join(BUNDLED_MODES_DIR, `${mode}.md`),
    join(BUNDLED_MODES_DIR, `${DEFAULT_MODE}.md`),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf8");
    } catch {}
  }
  throw new Error(`no mode template found (looked for ${mode} and default)`);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
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
  if (ctx.manualNotes) {
    parts.push("### Manual notes (user's framing for this call)\n" + ctx.manualNotes);
  }
  return parts.length ? parts.join("\n\n") : "(none)";
}

export function describeChecklist(items: ChecklistItem[]): string {
  return items
    .map((c) => `- [${c.id}] (${c.status}) ${c.text}`)
    .join("\n");
}
