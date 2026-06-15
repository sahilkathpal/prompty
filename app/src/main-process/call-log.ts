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
  transcript: TranscriptUtterance[];
  nudges: Nudge[];
  attendee?: CallContextAttendee;
  startedAt: number;
  endedAt: number;
  summary?: CallSummary;
}

export async function writeCallLog(
  log: CallLog,
  opts: { suffix?: string } = {},
): Promise<string> {
  const dir =
    process.env.PROMPTY_CALL_LOG_DIR ?? join(homedir(), ".prompty", "calls");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(log.endedAt).toISOString().replace(/[:.]/g, "-");
  const attendee = log.attendee?.name?.replace(/\s+/g, "_") ?? "unknown";
  const suffix = opts.suffix ? `-${opts.suffix}` : "";
  const path = join(dir, `${stamp}-${attendee}${suffix}.json`);
  writeFileSync(path, JSON.stringify(log, null, 2));
  return path;
}
