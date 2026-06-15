// Transcript-replay harness — the fast dev loop for iterating on the in-call
// prompt, WITHOUT running a live call.
//
// Problem it solves: seeing what the coach does normally requires a live call
// (audio sidecar + a real conversation) — minutes per iteration, never
// reproducible. This replays a fixed transcript through the *real* coaching
// session offline, so every prompt edit shows you the exact nudges in seconds.
//
// How it stays honest: it drives the actual production orchestrator
// (startSession from coach-session.ts) with mockAudio — no sidecar, no
// Deepgram, but the real agent, the real running-summary keeper, the real
// auto-consider window, and the real hotkey one-shot (answerNow). So what you
// see here is what a live call would produce, and the harness can't drift from
// production by re-implementing the loop.
//
// Pacing is "settle-between": each utterance is injected, then we await the
// session's waitIdle() before the next one — so every turn gets a fair shot at
// a nudge (no coalescing drops from racing the loop), while a 30-minute call
// replays in a couple of model-bound minutes.
//
// It is a SEEING tool, not an assertion tool: the model is nondeterministic, so
// the same transcript won't reproduce the same nudges run to run. Read the
// timeline with your own judgement; don't build a regression diff on it.
//
// Usage:
//   npm run replay                              # built-in committed fixture
//   npm run replay -- path/to/call-*.jsonl      # one or more recorded sessions
//   npm run replay -- ~/.prompty/calls/x.json   # an old call log (pre-debug-flow)
//   npm run replay -- ~/.prompty/debug          # a directory: all *.jsonl in it
//   npm run replay -- --parse-only [path...]    # load + print, no model
//
// Flags:
//   --limit N            replay only the first N utterances (sample big calls cheaply)
//   --skill <name>       impose a skill playbook the transcript didn't store
//   --direction <text>   impose a direction steer
//   --direction-file <p> like --direction, but read the whole prompt from a file
//                        (the dev loop: edit a scratch prompt.md, re-run, repeat)
// Overrides apply to every transcript in the run, letting you test a NEW skill or
// direction against a real old transcript that was recorded without one.
//
// Fixture sources (one unified debug-JSONL format):
//   1. A debug-logger JSONL (~/.prompty/debug/call-*.jsonl): its `session-start`
//      event reconstructs the CallSetup, its `utterance` events the transcript,
//      and its `agent-turn` events with trigger:"hotkey" mark where a hotkey was
//      pressed. Record one once with debugMode on, then replay it forever. These
//      stay LOCAL — real calls never get committed.
//   2. Hand-authored fixtures under tests/fixtures/transcripts/*.jsonl — same
//      format, committed and shared. Insert a {"kind":"agent-turn",
//      "trigger":"hotkey"} line wherever you want the hotkey exercised.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Keep replay output (journal + call log) out of the user's real ~/.prompty.
process.env.PROMPTY_CALL_LOG_DIR ??= path.join(os.tmpdir(), "prompty-replay");

// Quiet production's internal console.log chatter so the timeline reads clean.
// We only drop known-noisy prefixes; the harness surfaces nudges, quiet reasons
// through its own callbacks. console.error is untouched, so
// real failures still show.
{
  const NOISE = ["[coach-session", "[timing]", "[sidecar"];
  const rawLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && NOISE.some((p) => first.startsWith(p))) return;
    rawLog(...args);
  };
}

import { startSession } from "../src/main-process/coach-session";
import { listAvailableSkills } from "../src/main-process/prompts/system";
import { CONSIDER_WINDOW } from "../src/main-process/windowing";
import type {
  CallSetup,
  Nudge,
  Speaker,
  TranscriptUtterance,
} from "../src/main-process/types";

const DEFAULT_FIXTURE = path.join(
  __dirname,
  "fixtures",
  "transcripts",
  "discovery-kafka.jsonl",
);

// Where replay writes its readable debug artifacts (.jsonl + rendered .md), one
// subfolder per source transcript. Deliberately NOT ~/.prompty/debug, so a later
// `npm run replay -- ~/.prompty/debug` never re-ingests its own output.
const REPLAY_DEBUG_ROOT = path.join(os.homedir(), ".prompty", "replay");

// An ordered replay step: feed an utterance, or press the hotkey.
type Step =
  | { kind: "utterance"; u: TranscriptUtterance }
  | { kind: "hotkey" };

type Loaded = { setup: CallSetup; steps: Step[]; label: string };

// ---- CLI options -------------------------------------------------------------
interface Opts {
  parseOnly: boolean;
  /** Replay only the first N utterances of each transcript (Infinity = all). */
  limit: number;
  /** Setup overrides — impose a skill/direction the transcript didn't store. */
  skill?: string;
  direction?: string;
  paths: string[];
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = { parseOnly: false, limit: Infinity, paths: [] };
  // Pull the value of a flag given either `--flag value` or `--flag=value`.
  const val = (a: string, i: number): [string, number] =>
    a.includes("=") ? [a.slice(a.indexOf("=") + 1), i] : [argv[i + 1] ?? "", i + 1];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--parse-only") opts.parseOnly = true;
    else if (a === "--limit" || a.startsWith("--limit=")) {
      const [v, ni] = val(a, i);
      opts.limit = Number(v) > 0 ? Number(v) : Infinity;
      i = ni;
    } else if (a === "--skill" || a.startsWith("--skill=")) {
      const [v, ni] = val(a, i);
      opts.skill = v;
      i = ni;
    } else if (a === "--direction-file" || a.startsWith("--direction-file=")) {
      const [v, ni] = val(a, i);
      try {
        opts.direction = fs.readFileSync(v, "utf8");
      } catch {
        console.error(`[replay] --direction-file: cannot read ${v}`);
      }
      i = ni;
    } else if (a === "--direction" || a.startsWith("--direction=")) {
      const [v, ni] = val(a, i);
      opts.direction = v;
      i = ni;
    } else if (a.startsWith("--")) {
      console.error(`[replay] ignoring unknown flag: ${a}`);
    } else {
      opts.paths.push(a);
    }
  }
  return opts;
}

/** Apply setup overrides and the utterance limit to a loaded transcript. */
function applyOpts(l: Loaded, o: Opts): Loaded {
  const setup: CallSetup = { ...l.setup };
  if (o.skill !== undefined) setup.skill = o.skill;
  if (o.direction !== undefined) setup.direction = o.direction;

  let steps = l.steps;
  if (Number.isFinite(o.limit)) {
    const kept: Step[] = [];
    let n = 0;
    for (const s of steps) {
      if (s.kind === "utterance") {
        if (n >= o.limit) break;
        n++;
      }
      kept.push(s);
    }
    steps = kept;
  }
  return { setup, steps, label: l.label };
}

// ---- JSONL loader (handles both recordings and hand-authored fixtures) -------
function loadJsonl(file: string): Loaded {
  const raw = fs.readFileSync(file, "utf8");
  const events: Record<string, any>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A crash mid-write only corrupts the final line — skip it.
    }
  }

  const start = events.find((e) => e.kind === "session-start");
  const setup: CallSetup = {
    direction: start?.direction,
    context: { attendee: start?.attendee },
    skill: start?.skill,
  };

  // Build the ordered timeline. We keep only what we *re-drive*:
  //   - "utterance" finals → injected into the session
  //   - "agent-turn" with trigger:"hotkey" → a hotkey press point
  // Everything else (auto agent-turns, recorded nudges, interims, status,
  // summary-update, session start/end) is ignored — the harness regenerates
  // all of that live through the real session.
  const steps: Step[] = [];
  for (const e of events) {
    if (e.kind === "utterance") {
      const text = String(e.text ?? "");
      if (!text.trim()) continue;
      steps.push({
        kind: "utterance",
        u: {
          speaker: (e.speaker as Speaker) ?? "them",
          text,
          startMs: Number(e.startMs ?? 0),
          endMs: Number(e.endMs ?? 0),
          isFinal: true,
        },
      });
    } else if (e.kind === "agent-turn" && e.trigger === "hotkey") {
      steps.push({ kind: "hotkey" });
    }
  }

  return { setup, steps, label: path.basename(file) };
}

// ---- Call-log loader (old ~/.prompty/calls/*.json, pre-debug-flow) ----------
// These predate the debug logger: a single JSON object (CallLog), not JSONL.
// The transcript is all there, so we can still replay them — minus hotkey
// markers (didn't exist) and direction (call logs never persisted it).
function loadCallLog(file: string): Loaded {
  const log = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
  // Legacy: pre-rename logs stored `mode`; "default" mode meant "no skill".
  const skill =
    log.skill ?? (log.mode && log.mode !== "default" ? String(log.mode) : undefined);
  const setup: CallSetup = {
    direction: log.direction ?? undefined,
    context: { attendee: log.attendee },
    skill,
  };
  const steps: Step[] = (Array.isArray(log.transcript) ? log.transcript : [])
    .filter((u: any) => String(u?.text ?? "").trim())
    .map((u: any) => ({
      kind: "utterance" as const,
      u: {
        speaker: (u.speaker as Speaker) ?? "them",
        text: String(u.text ?? ""),
        startMs: Number(u.startMs ?? 0),
        endMs: Number(u.endMs ?? 0),
        isFinal: true,
      },
    }));
  return { setup, steps, label: path.basename(file) };
}

/** Dispatch by extension: .json = old call log, anything else = debug JSONL. */
function load(file: string): Loaded {
  return file.endsWith(".json") ? loadCallLog(file) : loadJsonl(file);
}

// ---- Input resolution: files, directories (→ *.jsonl), or the default -------
function resolveInputs(paths: string[]): string[] {
  if (paths.length === 0) return [DEFAULT_FIXTURE];

  const files: string[] = [];
  for (const p of paths) {
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      console.error(`[replay] skip (not found): ${p}`);
      continue;
    }
    if (st.isDirectory()) {
      const jsonls = fs
        .readdirSync(p)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
        .map((f) => path.join(p, f));
      if (!jsonls.length) console.error(`[replay] no .jsonl files in ${p}`);
      files.push(...jsonls);
    } else {
      files.push(p);
    }
  }
  return files;
}

// ---- Pretty-printing ---------------------------------------------------------
function printSetup(l: Loaded): void {
  const s = l.setup;
  const hotkeys = l.steps.filter((e) => e.kind === "hotkey").length;
  const utterances = l.steps.length - hotkeys;
  console.log(`\n=== fixture: ${l.label} ===`);
  if (s.direction) console.log(`direction: ${s.direction}`);
  if (s.skill) console.log(`skill:     ${s.skill}`);
  if (s.context.attendee?.name) {
    const a = s.context.attendee;
    console.log(`attendee:  ${a.name}${a.company ? ` (${a.company})` : ""}`);
  }
  console.log(
    `steps: ${utterances} utterance(s), ${hotkeys} hotkey press(es), window: ${CONSIDER_WINDOW}`,
  );
}

// ---- One transcript through the real session --------------------------------
async function replayOne(
  file: string,
  opts: Opts,
): Promise<{ nudges: number; errors: number }> {
  const loaded = applyOpts(load(file), opts);
  printSetup(loaded);

  // Capture a full debug log + rendered .md for this replayed session, under
  // ~/.prompty/replay/<source-stem>/. Set before startSession so openDebugLog
  // (which reads PROMPTY_DEBUG_LOG_DIR fresh) lands the files here.
  const stem = path.basename(file).replace(/\.jsonl$/i, "");
  const outDir = path.join(REPLAY_DEBUG_ROOT, stem);
  process.env.PROMPTY_DEBUG_LOG_DIR = outDir;

  // Per-step output buffer. onNudge / onStayQuiet / onError fire during
  // the await; we collect them, then print under the step that triggered them.
  let buffer: string[] = [];
  let errorCount = 0;

  const handle = await startSession(loaded.setup, {
    mockAudio: true,
    debug: true,
    onNudge: (n: Nudge) => buffer.push(`      💡 ${n.urgency}: ${n.text}`),
    onStayQuiet: (reason) => buffer.push(`      · quiet: ${reason}`),
    onError: (e) => {
      errorCount++;
      buffer.push(`      ❌ ${e.message}`);
    },
  });

  console.log("\n--- replay timeline ---");
  console.log("(real session via mockAudio: auto-nudges fire on each utterance,");
  console.log(" ⌨️ marks a hotkey press → answerNow(). Settle-between pacing:");
  console.log(" each step awaits waitIdle() before the next.)\n");

  let nudgeCount = 0;
  let utterNo = 0;
  for (const step of loaded.steps) {
    buffer = [];
    if (step.kind === "utterance") {
      utterNo++;
      handle.injectUtterance(step.u);
      await handle.waitIdle();
      console.log(`#${String(utterNo).padStart(2, "0")} [${step.u.speaker}] ${step.u.text}`);
    } else {
      handle.requestNudge();
      await handle.waitIdle();
      console.log("⌨️  hotkey pressed");
    }
    for (const line of buffer) {
      console.log(line);
      if (line.includes("💡")) nudgeCount++;
    }
  }

  await handle.end();

  // debug-logger renders the .md sibling on close. Surface the newest one in
  // outDir so the user can open it straight away.
  let mdPath: string | null = null;
  try {
    const mds = fs
      .readdirSync(outDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(outDir, f));
    mdPath = mds.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
  } catch {
    // No debug dir (e.g. capture failed) — just skip the pointer.
  }

  console.log(
    `\n[replay] ${loaded.label} — ${utterNo} turns, ${nudgeCount} nudge(s), ${errorCount} error(s).`,
  );
  if (mdPath) console.log(`[replay] readable log → ${mdPath}`);
  return { nudges: nudgeCount, errors: errorCount };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const files = resolveInputs(opts.paths);

  if (files.length === 0) {
    console.error("[replay] no transcripts to replay.");
    process.exit(1);
  }

  // Warn on a likely-typo'd skill override — it would silently run base-only.
  if (opts.skill) {
    const known = listAvailableSkills().map((s) => s.name);
    if (!known.includes(opts.skill)) {
      console.error(
        `[replay] warning: --skill "${opts.skill}" is not a known skill (${known.join(", ") || "none"}). The call will run on base.md alone.`,
      );
    }
  }

  if (opts.parseOnly) {
    for (const file of files) {
      const loaded = applyOpts(load(file), opts);
      printSetup(loaded);
      console.log("\n--- steps (parse-only) ---");
      let n = 0;
      for (const step of loaded.steps) {
        if (step.kind === "utterance") {
          n++;
          console.log(`#${String(n).padStart(2, "0")} [${step.u.speaker}] ${step.u.text}`);
        } else {
          console.log("⌨️  hotkey pressed");
        }
      }
    }
    console.log("\n[replay] parse-only: fixtures loaded OK, session not started.");
    process.exit(0);
  }

  let totalNudges = 0;
  let totalErrors = 0;
  for (const file of files) {
    const { nudges, errors } = await replayOne(file, opts);
    totalNudges += nudges;
    totalErrors += errors;
  }

  if (files.length > 1) {
    console.log(
      `\n[replay] all done — ${files.length} transcript(s), ${totalNudges} nudge(s), ${totalErrors} error(s).`,
    );
  }
  process.exit(totalErrors ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
