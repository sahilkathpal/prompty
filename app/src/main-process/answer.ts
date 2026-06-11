// Hotkey one-shot — "What should I ask/say right now?"
//
// The persistent nudging session (agent.ts) calls its tools lazily and can land
// an answer a turn late. The hotkey is the one moment the user is actively
// waiting, so it gets its own dedicated pass instead: a fresh single-turn query
// over the live call context, returning one concrete line.
//
// Context = goal + checklist(status) + the background running summary (long-
// range arc) + the last ~60 utterances verbatim (the immediate thread the
// answer must fit) + recent nudge texts (so it won't repeat itself). Plain-text
// reply, no MCP tool round-trip — the fastest path to an in-turn answer.

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

import type { CallSetup, Nudge, TranscriptUtterance } from "./types";
import { agentCwd, resolveClaudeCli } from "./claude-cli";
import { modelFor } from "./models";

const SYSTEM_PROMPT = `You are a real-time meeting copilot. The user is mid-call and just pressed a hotkey meaning: "What should I say or ask RIGHT NOW?"

Reply with exactly ONE thing the user can say or ask next:
- concrete and in their voice — something they can say close to verbatim
- ≤15 words
- it must fit the current moment of the conversation and move the user's goal forward
- never repeat anything already covered or already suggested

Output only that single line. No preamble, no quotes, no explanation.`;

function buildPrompt(input: AnswerInput): string {
  const { setup, summary, recent, recentNudges } = input;
  const checklistBlock =
    setup.checklist.length === 0
      ? "(none)"
      : setup.checklist.map((c) => `- [${c.id}] (${c.status}) ${c.text}`).join("\n");
  const transcriptBlock =
    recent.length === 0
      ? "(nothing said yet)"
      : recent.map((u) => `[${u.speaker}] ${u.text}`).join("\n");
  const summaryBlock = summary.trim() || "(call just started)";
  const nudgeBlock =
    recentNudges.length === 0
      ? "(none yet)"
      : recentNudges.map((t) => `- ${t}`).join("\n");
  return `## Goal
${setup.goal}

## Checklist (things to ask or verify)
${checklistBlock}

## Call so far (running brief)
${summaryBlock}

## Recent transcript (most recent last)
${transcriptBlock}

## Already suggested (do not repeat)
${nudgeBlock}

What should the user say or ask right now? One line, ≤15 words.`;
}

function cleanLine(text: string): string {
  // First non-empty line, stripped of surrounding quotes / leading bullet.
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  return line.replace(/^["'“”\-•*\s]+|["'“”\s]+$/g, "").trim();
}

export interface AnswerInput {
  setup: CallSetup;
  summary: string;
  /** Last ~60 utterances, oldest first. */
  recent: TranscriptUtterance[];
  /** Texts of the last few emitted nudges, to avoid repeats. */
  recentNudges: string[];
}

export async function answerNow(input: AnswerInput): Promise<Nudge | null> {
  try {
    const { query } = await loadSdk();
    const q = query({
      prompt: buildPrompt(input),
      options: {
        model: modelFor("hotkey"),
        systemPrompt: SYSTEM_PROMPT,
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
    const text = cleanLine(collected);
    if (!text) {
      console.error("[answer] empty reply");
      return null;
    }
    return {
      id: `n_${Date.now()}_ans`,
      kind: "answer",
      text,
      urgency: "high",
      createdAt: Date.now(),
    };
  } catch (e) {
    console.error("[answer] failed:", (e as Error).message);
    return null;
  }
}
