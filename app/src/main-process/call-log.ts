import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Nudge, PrepComponent, TranscriptUtterance } from "./types";
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
  /** Prep components (goal/checklist) used on the call, with checklist `done`
   *  reflecting what the coach marked covered (RUBY B3 phase 3c). */
  components?: PrepComponent[];
  startedAt: number;
  endedAt: number;
  summary?: CallSummary;
  /** True between the fast end (log persisted) and the background summary pass
   *  landing. The Past Calls UI shows a "Summarizing…" placeholder while set. */
  summaryPending?: boolean;
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
export function slugify(s: string): string {
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
  // Filename slug from the title (falls back to "call") — no more "-unknown"
  // tails.
  const label =
    deriveCallTitle(log.title, log.summary?.title, log.direction) || "";
  const suffix = opts.suffix ? `-${opts.suffix}` : "";
  const path = join(dir, `${stamp}-${slugify(label)}${suffix}.json`);
  writeFileSync(path, JSON.stringify(log, null, 2));
  return path;
}

/**
 * Patch an already-written log in place once the background summary pass lands.
 * Keeps the filename (the stable id) and any user-applied rename: the title is
 * upgraded to the summary's only when the stored title is still the auto-derived
 * default. `summaryPending` is cleared either way (success or empty summary), so
 * the UI can stop showing the "Summarizing…" placeholder.
 */
export function updateCallLogSummary(
  filePath: string,
  summary: CallSummary | undefined,
): void {
  let log: CallLog;
  try {
    log = JSON.parse(readFileSync(filePath, "utf8")) as CallLog;
  } catch {
    return; // log vanished or is corrupt — nothing to patch.
  }
  if (summary) log.summary = summary;
  const autoDefault = deriveCallTitle(undefined, undefined, log.direction);
  const userRenamed = !!log.title?.trim() && log.title.trim() !== autoDefault;
  if (!userRenamed) {
    log.title = deriveCallTitle(undefined, summary?.title, log.direction);
  }
  log.summaryPending = false;
  writeFileSync(filePath, JSON.stringify(log, null, 2));
}
