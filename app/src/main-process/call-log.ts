import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CallContextAttendee,
  Nudge,
  TranscriptUtterance,
} from "./types";
import type { CallSummary } from "./summary";

export interface CallLog {
  // Playground branch: calls are direction-only. The direction (the whole
  // coaching prompt) is what's worth recording; goal/checklist were dropped.
  direction?: string;
  skill?: string;
  /** Legacy field — only present on logs written before the mode→skill rename. */
  mode?: string;
  /** The call's display title (editable). Defaults to the summary's title, then
   *  the first line of the direction. Single source of truth for the Past Calls
   *  label — renaming a call rewrites this field. */
  title?: string;
  transcript: TranscriptUtterance[];
  nudges: Nudge[];
  attendee?: CallContextAttendee;
  startedAt: number;
  endedAt: number;
  summary?: CallSummary;
}

/** The effective title for a call: an explicit title wins, then the summary's,
 *  then the first line of the direction. Empty when nothing is known (the UI
 *  renders that as "Untitled call"). */
export function deriveCallTitle(
  title: string | undefined,
  summaryTitle: string | undefined,
  direction: string | undefined,
): string {
  const explicit = title?.trim();
  if (explicit) return explicit;
  const fromSummary = summaryTitle?.trim();
  if (fromSummary) return fromSummary;
  const firstLine = (direction ?? "").split(/[.\n]/)[0].trim();
  if (firstLine) return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
  return "";
}

/** Filesystem-safe slug for a title, used in the call-log filename. */
function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "call";
}

export async function writeCallLog(
  log: CallLog,
  opts: { suffix?: string } = {},
): Promise<string> {
  const dir =
    process.env.PROMPTY_CALL_LOG_DIR ?? join(homedir(), ".prompty", "calls");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(log.endedAt).toISOString().replace(/[:.]/g, "-");
  // Filename slug from the title (falls back to attendee, then "call") — no
  // more "-unknown" tails.
  const label =
    deriveCallTitle(log.title, log.summary?.title, log.direction) ||
    log.attendee?.name ||
    "";
  const suffix = opts.suffix ? `-${opts.suffix}` : "";
  const path = join(dir, `${stamp}-${slugify(label)}${suffix}.json`);
  writeFileSync(path, JSON.stringify(log, null, 2));
  return path;
}
