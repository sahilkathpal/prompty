// Integration: crash-safe journal → recovery round-trip (journal.ts), against a
// temp PROMPTY_CALL_LOG_DIR. A surviving journal is proof of a crash, so the
// next launch turns it back into a normal call log.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openJournal, recoverOrphanedJournals } from "../../src/main-process/journal";
import type { CallSetup, Nudge, TranscriptUtterance } from "../../src/main-process/types";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompty-journal-"));
  process.env.PROMPTY_CALL_LOG_DIR = dir;
});
afterEach(() => {
  delete process.env.PROMPTY_CALL_LOG_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const setup: CallSetup = { direction: "Discovery with Acme" };
const utt = (text: string): TranscriptUtterance => ({
  speaker: "them",
  text,
  startMs: 0,
  endMs: 1000,
  isFinal: true,
});
const nudge = (text: string): Nudge => ({ id: `n_${text}`, text, urgency: "medium", createdAt: 1 });

describe("journal recovery", () => {
  it("recovers a crashed session's utterances + nudges into a 'recovered' call log", async () => {
    const j = openJournal(setup, 12345)!;
    expect(j).not.toBeNull();
    j.appendUtterance(utt("we run eight brokers"));
    j.appendNudge(nudge("Ask about on-call load"));
    // NOTE: no j.delete() — simulates a crash before end() consolidated the log.

    const recovered = await recoverOrphanedJournals();
    expect(recovered).toHaveLength(1);
    expect(path.basename(recovered[0].path)).toContain("recovered");
    // Health metadata for the call_recovered event.
    expect(recovered[0].hadTranscript).toBe(true);
    expect(typeof recovered[0].durationS).toBe("number");
    expect(recovered[0].durationS).toBeGreaterThanOrEqual(0);

    const log = JSON.parse(fs.readFileSync(recovered[0].path, "utf8"));
    expect(log.direction).toBe("Discovery with Acme");
    expect(log.transcript.map((u: TranscriptUtterance) => u.text)).toEqual(["we run eight brokers"]);
    expect(log.nudges.map((n: Nudge) => n.text)).toEqual(["Ask about on-call load"]);

    // The journal is consumed on recovery.
    expect(fs.readdirSync(path.join(dir, ".journal"))).toHaveLength(0);
  });

  it("tolerates a corrupt final line (crash mid-write) and recovers the rest", async () => {
    const j = openJournal(setup, 222)!;
    j.appendUtterance(utt("clean line"));
    // Simulate a torn write by appending a partial JSON line directly.
    fs.appendFileSync(path.join(dir, ".journal", "222.jsonl"), '{"t":"utt","u":{"speaker":"them"');

    const recovered = await recoverOrphanedJournals();
    expect(recovered).toHaveLength(1);
    const log = JSON.parse(fs.readFileSync(recovered[0].path, "utf8"));
    expect(log.transcript.map((u: TranscriptUtterance) => u.text)).toEqual(["clean line"]);
  });

  it("does not recover an empty session, and deleted journals leave nothing behind", async () => {
    // A header-only journal (no content) is not worth recovering.
    openJournal(setup, 333);
    let recovered = await recoverOrphanedJournals();
    expect(recovered).toHaveLength(0);

    // A cleanly-ended session deletes its journal — nothing to recover.
    const j = openJournal(setup, 444)!;
    j.appendUtterance(utt("x"));
    j.delete();
    recovered = await recoverOrphanedJournals();
    expect(recovered).toHaveLength(0);
  });
});
