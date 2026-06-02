import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CallSetup, Nudge, TranscriptUtterance } from "./types.ts";

export type CallLog = {
  setup: CallSetup;
  transcript: TranscriptUtterance[];
  nudges: Nudge[];
  endedAt: number;
};

export async function writeCallLog(log: CallLog): Promise<string> {
  const dir = join(homedir(), ".prompty", "calls");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(log.endedAt).toISOString().replace(/[:.]/g, "-");
  const attendee = log.setup.context.attendee?.name?.replace(/\s+/g, "_") ?? "unknown";
  const path = join(dir, `${stamp}-${attendee}.json`);
  writeFileSync(path, JSON.stringify(log, null, 2));
  return path;
}
