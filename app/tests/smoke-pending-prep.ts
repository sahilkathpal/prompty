// Smoke test for pending-prep persistence — no claude, no electron runtime.

import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "prompty-pending-prep-"));
process.env.PROMPTY_PENDING_PREP_DIR = dir;

// Stub electron so pending-prep imports don't blow up.
const Module = require("node:module") as {
  _resolveFilename: Function;
  _cache: Record<string, unknown>;
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]) {
  if (request === "electron") {
    return require.resolve("./fixtures/fake-electron.cjs");
  }
  return origResolve.call(this, request, parent, ...rest);
};

import {
  getPendingPrep,
  setPendingPrep,
  clearPendingPrep,
  type PendingPrep,
} from "../src/main-process/pending-prep";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`[smoke-pending-prep] FAIL — ${msg}`);
    process.exit(1);
  }
}

const before = getPendingPrep();
assert(before === null, "expected no pending prep initially");

const pp: PendingPrep = {
  goal: "Test goal",
  direction: "Explore their timeline and budget; stay curious, qualify fit.",
  checklist: [
    { id: "c1", text: "Ask about timeline", status: "open" },
    { id: "c2", text: "Verify budget", status: "open" },
  ],
  eventId: "ev1",
  eventTitle: "Test event",
  savedAt: Date.now(),
};

setPendingPrep(pp);
const file = join(dir, "pending-prep.json");
assert(existsSync(file), `expected file ${file} to exist`);

const read = getPendingPrep();
assert(read !== null, "expected pending prep after set");
assert(read!.goal === pp.goal, "goal mismatch");
assert(read!.direction === pp.direction, "direction round-trip mismatch");
assert(read!.checklist.length === 2, "checklist length mismatch");
assert(read!.checklist[0]!.id === "c1", "checklist content mismatch");
assert(read!.eventId === "ev1", "eventId mismatch");

clearPendingPrep();
const after = getPendingPrep();
assert(after === null, "expected null after clear");

// Round-trip with skill set.
const ppWithSkill: PendingPrep = {
  goal: "Test goal w/ skill",
  checklist: [{ id: "c1", text: "Ask budget", status: "open" }],
  skill: "discovery",
  eventId: "ev2",
  eventTitle: "Discovery call",
  savedAt: Date.now(),
};
setPendingPrep(ppWithSkill);
const readSkill = getPendingPrep();
assert(readSkill !== null, "expected pending prep w/ skill after set");
assert(readSkill!.skill === "discovery", `skill round-trip mismatch: ${readSkill!.skill}`);
clearPendingPrep();
assert(getPendingPrep() === null, "expected null after clear (skill case)");

// Legacy migration: a draft persisted with the old `mode` field maps to `skill`.
const fs = require("node:fs") as typeof import("node:fs");
const { join: pathJoin } = require("node:path") as typeof import("node:path");
const legacyFile = pathJoin(dir, "pending-prep.json");
fs.writeFileSync(
  legacyFile,
  JSON.stringify({ goal: "Legacy goal", mode: "hiring", savedAt: Date.now() }),
  "utf8",
);
const migrated = getPendingPrep();
assert(migrated !== null, "expected legacy draft to load");
assert(migrated!.skill === "hiring", `legacy mode should map to skill: ${migrated!.skill}`);
assert(!("mode" in (migrated as object)), "legacy mode field should be stripped");
// Legacy "default" mode had no playbook — it must drop to no skill.
fs.writeFileSync(
  legacyFile,
  JSON.stringify({ goal: "Legacy default", mode: "default", savedAt: Date.now() }),
  "utf8",
);
const migratedDefault = getPendingPrep();
assert(migratedDefault !== null, "expected legacy default draft to load");
assert(
  migratedDefault!.skill === undefined,
  `legacy "default" mode should drop to no skill: ${migratedDefault!.skill}`,
);
clearPendingPrep();

// Round-trip with notes.
const ppWithNotes: PendingPrep = {
  goal: "Goal with notes",
  checklist: [{ id: "c1", text: "Ask budget", status: "open" }],
  notes: "Skeptical CTO — mention SOC2.",
  skill: "discovery",
  savedAt: Date.now(),
};
setPendingPrep(ppWithNotes);
const readNotes = getPendingPrep();
assert(readNotes !== null, "expected pending prep w/ notes after set");
assert(
  readNotes!.notes === "Skeptical CTO — mention SOC2.",
  `notes round-trip mismatch: ${readNotes!.notes}`,
);
clearPendingPrep();

// Notes-only draft (no goal, no checklist) — the unified-draft path.
const notesOnly: PendingPrep = {
  notes: "Follow-up to last week's demo.",
  savedAt: Date.now(),
};
setPendingPrep(notesOnly);
const readNotesOnly = getPendingPrep();
assert(readNotesOnly !== null, "expected notes-only draft to persist");
assert(readNotesOnly!.goal === undefined, "notes-only draft should have no goal");
assert(
  Array.isArray(readNotesOnly!.checklist) && readNotesOnly!.checklist!.length === 0,
  "notes-only draft checklist should normalize to []",
);
assert(
  readNotesOnly!.notes === "Follow-up to last week's demo.",
  "notes-only notes mismatch",
);
clearPendingPrep();
assert(getPendingPrep() === null, "expected null after clear (notes cases)");

// Direction-only draft (no goal, no checklist) — the new primary-artifact path.
const directionOnly: PendingPrep = {
  direction: "Explore how they run ingestion today; stay curious, gauge fit.",
  savedAt: Date.now(),
};
setPendingPrep(directionOnly);
const readDirOnly = getPendingPrep();
assert(readDirOnly !== null, "expected direction-only draft to persist");
assert(readDirOnly!.goal === undefined, "direction-only draft should have no goal");
assert(
  readDirOnly!.direction === "Explore how they run ingestion today; stay curious, gauge fit.",
  "direction-only direction mismatch",
);
assert(
  Array.isArray(readDirOnly!.checklist) && readDirOnly!.checklist!.length === 0,
  "direction-only draft checklist should normalize to []",
);
clearPendingPrep();
assert(getPendingPrep() === null, "expected null after clear (direction case)");

console.log("[smoke-pending-prep] PASS");
process.exit(0);
