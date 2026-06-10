// Stage 4 — Pending prep persistence.
//
// A "pending prep" is the output of a prep-window conversation that hasn't
// yet been turned into a coaching session. Persisted to disk so a crash
// (or quitting the app) doesn't lose the user's work.

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { ChecklistItem } from "./types";

export interface PendingPrepMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  createdAt: number;
  toolName?: string;
}

export interface PendingPrep {
  // goal/checklist are optional: a draft can be just a mode (+ notes) when the
  // user skips prep. The in-call prompt omits whatever is absent.
  goal?: string;
  checklist?: ChecklistItem[];
  /** Free-text framing the user wants the in-call agent to know. */
  notes?: string;
  mode?: string;
  eventId?: string;
  eventTitle?: string;
  /** Full chat thread from the prep session, so resume can re-hydrate. */
  messages?: PendingPrepMessage[];
  savedAt: number;
}

function filePath(): string {
  const dir =
    process.env.PROMPTY_PENDING_PREP_DIR ?? app.getPath("userData");
  return path.join(dir, "pending-prep.json");
}

export function getPendingPrep(): PendingPrep | null {
  try {
    const raw = fs.readFileSync(filePath(), "utf8");
    const parsed = JSON.parse(raw) as PendingPrep;
    if (!parsed || typeof parsed !== "object") return null;
    // goal/checklist are optional (a notes-only or mode-only draft is valid);
    // normalize checklist to an array so callers can always `.length`.
    if (!Array.isArray(parsed.checklist)) parsed.checklist = [];
    return parsed;
  } catch {
    return null;
  }
}

export function setPendingPrep(p: PendingPrep): void {
  const fp = filePath();
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
  } catch {}
  fs.writeFileSync(fp, JSON.stringify(p, null, 2), "utf8");
}

export function clearPendingPrep(): void {
  try {
    fs.unlinkSync(filePath());
  } catch {
    // ignore — already gone
  }
}
