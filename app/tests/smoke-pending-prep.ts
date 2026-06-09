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
assert(read!.checklist.length === 2, "checklist length mismatch");
assert(read!.checklist[0]!.id === "c1", "checklist content mismatch");
assert(read!.eventId === "ev1", "eventId mismatch");

clearPendingPrep();
const after = getPendingPrep();
assert(after === null, "expected null after clear");

// Round-trip with mode set.
const ppWithMode: PendingPrep = {
  goal: "Test goal w/ mode",
  checklist: [{ id: "c1", text: "Ask budget", status: "open" }],
  mode: "discovery",
  eventId: "ev2",
  eventTitle: "Discovery call",
  savedAt: Date.now(),
};
setPendingPrep(ppWithMode);
const readMode = getPendingPrep();
assert(readMode !== null, "expected pending prep w/ mode after set");
assert(readMode!.mode === "discovery", `mode round-trip mismatch: ${readMode!.mode}`);
clearPendingPrep();
assert(getPendingPrep() === null, "expected null after clear (mode case)");

console.log("[smoke-pending-prep] PASS");
process.exit(0);
