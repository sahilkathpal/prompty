// Crash-safe transcript journal.
//
// During a live call the transcript and nudges live only in memory and are
// written to disk once, at end() (see coach-session.ts / call-log.ts). That
// means a process crash (kill -9, OOM, unhandled throw, force-quit) before
// end() loses the whole call.
//
// This module append-writes each final utterance and nudge to a per-session
// JSONL journal as it arrives. appendFileSync/writeSync hands the bytes to the
// kernel page cache, which survives a *process* crash (the kernel keeps
// running and flushes to disk on its own). It does NOT survive power loss /
// kernel panic without an fsync per line — deliberately skipped here; see the
// note on appendUtterance.
//
// On clean end() the journal is deleted (the consolidated call log supersedes
// it). On the next app launch, recoverOrphanedJournals() turns any surviving
// journal — proof of a crash — back into a normal call log.

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { writeCallLog, type CallLog } from "./call-log";
import type { CallSetup, Nudge, TranscriptUtterance } from "./types";

function callsDir(): string {
  return (
    process.env.PROMPTY_CALL_LOG_DIR ?? path.join(homedir(), ".prompty", "calls")
  );
}

function journalDir(): string {
  // Hidden subdir so it never shows up in the past-calls *.json listing.
  return path.join(callsDir(), ".journal");
}

export interface JournalHandle {
  appendUtterance(u: TranscriptUtterance): void;
  appendNudge(n: Nudge): void;
  /** Remove the journal — call once the consolidated log is safely written. */
  delete(): void;
}

interface HeaderLine {
  t: "header";
  goal: string;
  mode?: string;
  checklist: CallLog["checklist"];
  attendee?: CallLog["attendee"];
  startedAt: number;
}

/**
 * Open a journal for a session. Returns null (and logs) on any I/O failure so
 * the caller can proceed without journaling rather than failing the call.
 */
export function openJournal(
  setup: CallSetup,
  startedAt: number,
): JournalHandle | null {
  let fd: number;
  let file: string;
  try {
    const dir = journalDir();
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${startedAt}.jsonl`);
    fd = fs.openSync(file, "a");
  } catch (e) {
    console.error("[journal] open failed:", (e as Error).message);
    return null;
  }

  const write = (obj: unknown) => {
    try {
      // writeSync → kernel page cache. Survives a process crash. To also
      // survive power loss, fs.fsyncSync(fd) here — intentionally omitted.
      fs.writeSync(fd, JSON.stringify(obj) + "\n");
    } catch (e) {
      console.error("[journal] write failed:", (e as Error).message);
    }
  };

  const header: HeaderLine = {
    t: "header",
    goal: setup.goal,
    mode: setup.mode,
    checklist: setup.checklist,
    attendee: setup.context.attendee,
    startedAt,
  };
  write(header);

  return {
    appendUtterance(u) {
      write({ t: "utt", u });
    },
    appendNudge(n) {
      write({ t: "nudge", n });
    },
    delete() {
      try {
        fs.closeSync(fd);
      } catch {}
      try {
        fs.unlinkSync(file);
      } catch {}
    },
  };
}

interface ParsedJournal {
  header: HeaderLine | null;
  transcript: TranscriptUtterance[];
  nudges: Nudge[];
}

function parseJournal(filePath: string): ParsedJournal {
  const parsed: ParsedJournal = { header: null, transcript: [], nudges: [] };
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: { t?: string; u?: TranscriptUtterance; n?: Nudge } & Partial<HeaderLine>;
    try {
      obj = JSON.parse(line);
    } catch {
      // A crash mid-write only ever corrupts the final line — skip it.
      continue;
    }
    if (obj.t === "header") parsed.header = obj as HeaderLine;
    else if (obj.t === "utt" && obj.u) parsed.transcript.push(obj.u);
    else if (obj.t === "nudge" && obj.n) parsed.nudges.push(obj.n);
  }
  return parsed;
}

/**
 * Scan for journals left behind by a crash and turn each into a call log.
 * Run once on app startup (no session is active then, so any journal is an
 * orphan). Returns the paths of recovered logs that were written.
 */
export async function recoverOrphanedJournals(): Promise<string[]> {
  const written: string[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(journalDir());
  } catch {
    return written; // No journal dir yet — nothing to recover.
  }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = path.join(journalDir(), f);
    try {
      const { header, transcript, nudges } = parseJournal(fp);
      // Only worth recovering if the call actually produced content.
      if (header && (transcript.length > 0 || nudges.length > 0)) {
        // mtime ≈ when the crash happened (last write to the journal). The
        // utterance ms fields are stream-relative, not wall-clock, so they
        // can't supply a real endedAt.
        const endedAt = fs.statSync(fp).mtimeMs;
        const out = await writeCallLog(
          {
            goal: header.goal,
            mode: header.mode,
            checklist: header.checklist,
            transcript,
            nudges,
            attendee: header.attendee,
            startedAt: header.startedAt,
            endedAt,
          },
          { suffix: "recovered" },
        );
        written.push(out);
        console.log("[journal] recovered crashed call to", out);
      }
      fs.unlinkSync(fp);
    } catch (e) {
      console.error("[journal] recover failed for", fp, (e as Error).message);
    }
  }
  return written;
}
