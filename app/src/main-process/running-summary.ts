// Background running summary of the LIVE call.
//
// The hotkey one-shot (answer.ts) wants the call's long-range arc as context,
// but generating a summary at press time would put a second serial model call
// in front of the thing the user is actively waiting on. So we maintain the
// summary here, off the critical path: every few utterances a cheap Haiku pass
// re-summarises the transcript so far, and the hotkey just reads the latest
// result instantly. Full re-summary each time (not incremental) keeps it
// drift-free; since it runs in the background, its latency is irrelevant.

type ClaudeAgentSdk = typeof import("@anthropic-ai/claude-agent-sdk");
let sdkPromise: Promise<ClaudeAgentSdk> | null = null;
function loadSdk(): Promise<ClaudeAgentSdk> {
  if (!sdkPromise) {
    sdkPromise = (new Function("m", "return import(m)") as (m: string) => Promise<ClaudeAgentSdk>)(
      "@anthropic-ai/claude-agent-sdk",
    );
  }
  return sdkPromise;
}

import type { CallSetup, TranscriptUtterance } from "./types";
import { agentCwd, resolveClaudeCli } from "./claude-cli";
import { modelFor } from "./models";

// Refresh once this many new final utterances have landed since the last pass.
// Short calls never reach it — the hotkey's verbatim window already covers them
// in full, so an empty summary early on loses nothing.
const REFRESH_EVERY = 20;

export interface SummaryKeeper {
  /** Feed the full transcript after each final utterance. Non-blocking; fires a
   *  background refresh when enough new material has accumulated. */
  note(transcript: TranscriptUtterance[]): void;
  /** Latest summary text ("" until the first refresh completes). */
  current(): string;
}

function buildPrompt(setup: CallSetup, transcript: TranscriptUtterance[]): string {
  const checklistBlock =
    setup.checklist.length === 0
      ? "(none)"
      : setup.checklist.map((c) => `- [${c.id}] (${c.status}) ${c.text}`).join("\n");
  const transcriptBlock = transcript.map((u) => `[${u.speaker}] ${u.text}`).join("\n");
  return `You are keeping a running brief of a conversation that is STILL ONGOING. This brief is context for a real-time assistant helping the user — it is not shown to the user.

## Goal
${setup.goal}

## Checklist (things the user wanted to ask or verify)
${checklistBlock}

## Transcript so far
${transcriptBlock}

Write a tight brief (max ~150 words), plain prose, no preamble. Capture:
- what's been established or decided so far
- which checklist items have been answered vs are still open
- the current open thread — what's being discussed right now

Be concrete. Output only the brief.`;
}

async function runSummary(
  setup: CallSetup,
  transcript: TranscriptUtterance[],
): Promise<string> {
  const { query } = await loadSdk();
  const q = query({
    prompt: buildPrompt(setup, transcript),
    options: {
      model: modelFor("summary"),
      pathToClaudeCodeExecutable: resolveClaudeCli(),
      // Keep the CLI's workspace scan out of the user's protected folders.
      cwd: agentCwd(),
      maxTurns: 1,
      permissionMode: "bypassPermissions",
    },
  });
  let collected = "";
  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content ?? []) {
        if ((block as { type?: string }).type === "text") {
          collected += (block as { text?: string }).text ?? "";
        }
      }
    }
  }
  return collected.trim();
}

export function createSummaryKeeper(setup: CallSetup): SummaryKeeper {
  let summary = "";
  let summarizedAt = 0; // transcript length covered by the last kicked refresh
  let inFlight = false;

  const kick = (snapshot: TranscriptUtterance[]) => {
    inFlight = true;
    const target = snapshot.length;
    runSummary(setup, snapshot)
      .then((text) => {
        if (text) {
          summary = text;
          summarizedAt = target;
        }
      })
      .catch((e) => {
        // Non-fatal — keep the previous (stale) summary; try again next window.
        console.error("[running-summary] refresh failed:", (e as Error).message);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  return {
    note(transcript) {
      if (inFlight) return;
      if (transcript.length - summarizedAt < REFRESH_EVERY) return;
      kick(transcript.slice());
    },
    current() {
      return summary;
    },
  };
}
