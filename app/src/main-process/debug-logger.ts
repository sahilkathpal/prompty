// Verbose, opt-in debug logger (gated by the `debugMode` setting).
//
// While the always-on journal (journal.ts) captures only the final transcript
// and emitted nudges — enough to reconstruct a call log after a crash — debug
// mode captures the *model's-eye view*: the resolved system/skill prompt, the
// dynamic per-turn context, raw model responses, tool calls, latencies, interim
// utterances, status pulses and errors. It exists to answer "why did the coach
// say (or not say) that?" after the fact.
//
// One file per session, namespaced by kind:
//   ~/.prompty/debug/prep-{startedAt}.jsonl   (+ .md rendered at close, step 5)
//   ~/.prompty/debug/call-{startedAt}.jsonl
//
// Each line is one JSON event: { ts, kind, ...payload }. `ts` is wall-clock
// epoch ms; payloads preserve any original stream-relative fields (startMs,
// createdAt) untouched, so a turn carries both clocks.
//
// Fidelity is "B" (deltas + once): the static system+skill prompt is logged
// once in the session-start event; per-turn events log only the dynamic delta.
// Set PROMPTY_DEBUG_FULL_PROMPT=1 to escalate to "A" (callers re-dump the full
// prompt every turn) — see debugFullPrompt().
//
// Writes go through writeSync → kernel page cache, matching journal.ts: they
// survive a process crash but not power loss (no per-line fsync, by design).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Resolve the directory where debug logs are written. Mirrors the override
// convention used by call-log.ts / journal.ts (PROMPTY_CALL_LOG_DIR) so tests
// and power users can redirect output.
export function debugDir(): string {
  return (
    process.env.PROMPTY_DEBUG_LOG_DIR ?? path.join(os.homedir(), ".prompty", "debug")
  );
}

// When true, callers should include the full resolved prompt on every turn
// rather than just the dynamic delta. Off by default ("B"); opt in for chasing
// a nasty prompt-construction bug.
export function debugFullPrompt(): boolean {
  return process.env.PROMPTY_DEBUG_FULL_PROMPT === "1";
}

export type DebugSessionKind = "prep" | "call";

// Event taxonomy. The `kind` discriminator is shared across the two session
// types; payload shape varies per kind (kept loose — this is a diagnostic log,
// not a typed wire contract). Expected payloads, for reference:
//
//   call sessions:
//     session-start   { systemPrompt, goal, checklist, skill?, attendee?, startedAt }
//     utterance       { speaker, text, startMs, endMs }
//     interim         { speaker, text, startMs, endMs }
//     agent-turn      { trigger: "auto"|"hotkey", context, rawModelResponse,
//                       toolCalls[], latencyMs, nudgeFired, reason? }
//     nudge           { nudge: Nudge }
//     summary-update  { summary }
//     status          { status, reason? }
//     error           { where, message, stack? }
//     session-end     { endedAt, summary? }
//
//   prep sessions:
//     prep-start        { systemPrompt, event?, attendee?, seededFromPending }
//     prep-user-turn    { text, preamble? }
//     prep-agent-turn   { rawModelResponse, toolCalls[], latencyMs }
//     prep-state-change { state, source: "tool"|"rail" }
//     prep-save         { snapshot, chainedToCall }
//     prep-error        { where, message, stack? }
//     prep-discard      {}
export type DebugEventKind =
  | "session-start"
  | "utterance"
  | "interim"
  | "agent-turn"
  | "nudge"
  | "summary-update"
  | "status"
  | "error"
  | "session-end"
  | "prep-start"
  | "prep-user-turn"
  | "prep-agent-turn"
  | "prep-state-change"
  | "prep-save"
  | "prep-error"
  | "prep-discard";

export interface DebugLog {
  /** Append one event. `ts` (epoch ms) is stamped here; do not pass it in. */
  write(kind: DebugEventKind, payload?: Record<string, unknown>): void;
  /** Flush + close the file. Idempotent. (Renders the .md sibling in step 5.) */
  close(): void;
  /** Absolute path of the .jsonl being written. */
  readonly filePath: string;
}

/**
 * Open a debug log for a session. Returns null (and logs) on any I/O failure so
 * the caller can proceed without debug capture rather than failing the session
 * — same contract as openJournal().
 *
 * `now` is the wall-clock stamp for the very first event; callers pass it so
 * tests can pin time. Subsequent events stamp themselves via the `clock`.
 */
export function openDebugLog(
  kind: DebugSessionKind,
  startedAt: number,
  clock: () => number = Date.now,
): DebugLog | null {
  let fd: number;
  let file: string;
  try {
    const dir = debugDir();
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, `${kind}-${startedAt}.jsonl`);
    fd = fs.openSync(file, "a");
  } catch (e) {
    console.error("[debug-logger] open failed:", (e as Error).message);
    return null;
  }

  let closed = false;

  return {
    filePath: file,
    write(eventKind, payload) {
      if (closed) return;
      try {
        const line = JSON.stringify({ ts: clock(), kind: eventKind, ...payload });
        fs.writeSync(fd, line + "\n");
      } catch (e) {
        console.error("[debug-logger] write failed:", (e as Error).message);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        fs.closeSync(fd);
      } catch {}
      // Render a human-readable .md sibling from the .jsonl. Best-effort: a
      // render failure must never propagate out of close().
      try {
        const md = renderDebugMarkdown(file);
        fs.writeFileSync(file.replace(/\.jsonl$/, ".md"), md);
      } catch (e) {
        console.error("[debug-logger] markdown render failed:", (e as Error).message);
      }
    },
  };
}

// ---- Markdown rendering ------------------------------------------------------

/** Collapse whitespace and truncate for a one-line timeline entry. */
function oneLine(s: unknown, max = 200): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** ms → "MM:SS.mmm" elapsed-since-start. */
function fmtElapsed(ms: number): string {
  const clamped = Math.max(0, ms);
  const mm = Math.floor(clamped / 60000);
  const ss = Math.floor((clamped % 60000) / 1000);
  const mmm = clamped % 1000;
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(mmm).padStart(3, "0")}`;
}

/** Collapsed <details> block with a fenced body (triple-backticks neutralised). */
function detailsBlock(summary: string, body: string): string {
  const safe = String(body ?? "").replace(/```/g, "ʼʼʼ");
  return [
    "",
    `<details><summary>${summary}</summary>`,
    "",
    "```text",
    safe,
    "```",
    "",
    "</details>",
  ].join("\n");
}

function stateSummary(state: Record<string, unknown> | undefined): string {
  if (!state) return "";
  const goal = state.goal ? `goal="${oneLine(state.goal, 60)}"` : "";
  const dir = state.direction ? `dir="${oneLine(state.direction, 60)}"` : "";
  const items = Array.isArray(state.checklist) ? `items=${state.checklist.length}` : "";
  const skill = state.skill ? `skill=${state.skill}` : "";
  return [goal, dir, items, skill].filter(Boolean).join(" ");
}

function formatEvent(e: Record<string, any>, t0: number): string {
  const ts = `\`+${fmtElapsed((e.ts ?? t0) - t0)}\``;
  switch (e.kind) {
    case "session-start":
    case "prep-start":
      return `${ts} ▶️ **${e.kind}**`;
    case "utterance":
      return `${ts} 🗣️ **${e.speaker}:** ${oneLine(e.text)}`;
    case "interim":
      return `${ts} · _${e.speaker} (interim):_ ${oneLine(e.text)}`;
    case "agent-turn": {
      const tools = (e.toolCalls ?? []).map((t: any) => t.name).join(", ") || e.decision || "none";
      const det = detailsBlock(
        "context + response",
        `${e.context ?? ""}\n\n--- response ---\n${e.assistantText ?? ""}`,
      );
      return `${ts} 🤖 **agent-turn** (${e.trigger}, ${e.latencyMs}ms) → ${tools}${e.reason ? ` — ${oneLine(e.reason)}` : ""}${det}`;
    }
    case "prep-agent-turn": {
      const tools = (e.toolCalls ?? []).map((t: any) => t.name).join(", ") || "—";
      const det = detailsBlock(
        "context + response",
        `${e.context ?? ""}\n\n--- response ---\n${e.assistantText ?? ""}`,
      );
      return `${ts} 🤖 **agent-turn** (${e.latencyMs}ms) → ${tools}${det}`;
    }
    case "prep-user-turn":
      return `${ts} 🧑 **user:** ${oneLine(e.text)}${e.preamble ? " _(+state preamble)_" : ""}`;
    case "nudge":
      return `${ts} 💡 **nudge** [${e.nudge?.kind}/${e.nudge?.urgency}]: ${oneLine(e.nudge?.text)}`;
    case "summary-update":
      return `${ts} 📝 **summary** — ${oneLine(e.summary)}`;
    case "status":
      return `${ts} 📶 **status** ${e.status}${e.reason ? ` — ${oneLine(e.reason)}` : ""}`;
    case "prep-state-change":
      return `${ts} 🔧 **state-change** (${e.source}) ${stateSummary(e.state)}`;
    case "prep-save":
      return `${ts} 💾 **prep-save**${e.chainedToCall ? " → started call" : ""}`;
    case "prep-discard":
      return `${ts} 🗑️ **prep-discard**`;
    case "error":
    case "prep-error":
      return `${ts} ❌ **error** (${e.where}) ${oneLine(e.message)}`;
    case "session-end":
      return `${ts} 🏁 **session-end**`;
    default:
      return `${ts} **${e.kind}**`;
  }
}

/**
 * Render a debug `.jsonl` into a human-readable, chronological Markdown doc:
 * a header (goal/skill/attendee or prep event + duration), the resolved system
 * prompt (collapsed, logged once), then a timeline interleaving every event
 * with elapsed timestamps. Pure — exported so it can be unit-tested and re-run
 * over an existing log.
 */
export function renderDebugMarkdown(jsonlPath: string): string {
  const raw = fs.readFileSync(jsonlPath, "utf8");
  const events: Record<string, any>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A crash mid-write only ever corrupts the final line — skip it.
    }
  }

  const base = path.basename(jsonlPath);
  const isPrep = base.startsWith("prep-");
  const t0 = events.length ? events[0]!.ts ?? 0 : 0;
  const tN = events.length ? events[events.length - 1]!.ts ?? t0 : 0;

  const lines: string[] = [];
  lines.push(`# Prompty debug — ${isPrep ? "prep" : "call"} session`);
  lines.push("");
  lines.push(`<!-- source: ${base} -->`);
  lines.push("");

  const start = events.find((e) => e.kind === (isPrep ? "prep-start" : "session-start"));
  if (start) {
    if (isPrep) {
      if (start.event?.title) lines.push(`**Event:** ${start.event.title}`);
      lines.push(`**Seeded from pending:** ${start.seededFromPending ? "yes" : "no"}`);
    } else {
      if (start.goal) lines.push(`**Goal:** ${oneLine(start.goal)}`);
      if (start.direction) lines.push(`**Direction:** ${oneLine(start.direction)}`);
      if (start.skill) lines.push(`**Skill:** ${start.skill}`);
      if (start.attendee?.name) {
        lines.push(
          `**Attendee:** ${start.attendee.name}${start.attendee.company ? ` (${start.attendee.company})` : ""}`,
        );
      }
    }
  }
  if (t0) lines.push(`**Started:** ${new Date(t0).toISOString()}`);
  if (tN > t0) lines.push(`**Duration:** ${((tN - t0) / 1000).toFixed(1)}s`);
  lines.push(`**Events:** ${events.length}`);
  lines.push("");

  if (start?.systemPrompt) {
    lines.push("## System prompt");
    lines.push(detailsBlock("resolved system prompt (logged once)", String(start.systemPrompt)));
    lines.push("");
  }

  lines.push("## Timeline");
  lines.push("");
  // Blank line between entries so each renders as its own line (GFM collapses
  // adjacent non-blank lines into one paragraph) and HTML <details> blocks are
  // recognised.
  for (const e of events) {
    lines.push(formatEvent(e, t0));
    lines.push("");
  }

  return lines.join("\n");
}
