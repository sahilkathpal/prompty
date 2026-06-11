// Post-call summary: one-shot agent pass over the final transcript + setup.
//
// Output shape lands directly on the call log JSON so the home screen's
// "completed call detail" view can render checklist items with the answers
// the model mined from the conversation.

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

import type { CallSetup, ChecklistItem, TranscriptUtterance } from "./types";
import { agentCwd, resolveClaudeCli } from "./claude-cli";
import { modelFor } from "./models";

export interface CallSummaryItem {
  id: string;
  text: string;
  status: ChecklistItem["status"];
  answer: string;
}

export interface CallSummary {
  goalRecap: string;
  items: CallSummaryItem[];
}

function buildPrompt(setup: CallSetup, transcript: TranscriptUtterance[]): string {
  const checklistBlock = setup.checklist
    .map((c) => `- [${c.id}] (${c.status}) ${c.text}`)
    .join("\n");
  const transcriptBlock =
    transcript.length === 0
      ? "(no transcript recorded)"
      : transcript.map((u) => `[${u.speaker}] ${u.text}`).join("\n");
  return `You are summarising a just-ended conversation. The user prepped with a goal and a checklist of things to ASK or VERIFY during the call. You now have the full transcript.

Produce a structured summary the user can review later.

## Goal
${setup.goal}

## Checklist
${checklistBlock}

## Transcript
${transcriptBlock}

## Output

Reply with ONLY a single fenced JSON block. No prose before or after.

\`\`\`json
{
  "goalRecap": "<2-3 sentences: was the goal achieved? what's the headline outcome?>",
  "items": [
    {
      "id": "<checklist id>",
      "text": "<original checklist text>",
      "status": "<open|covered|skipped — your assessment of whether this was actually covered in the transcript, NOT just what the agent toggled mid-call>",
      "answer": "<what was learned about this item during the call, in 1-3 sentences. If nothing was learned, say 'Not discussed.'>"
    }
  ]
}
\`\`\`

Rules:
- Include EVERY checklist item, in the original order, with its original id and text.
- Be concrete. Quote a phrase from the transcript when useful.
- Do not invent answers that aren't supported by the transcript.`;
}

function extractJson(text: string): string | null {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const obj = text.match(/\{[\s\S]*\}/);
  return obj ? obj[0] : null;
}

export async function summarizeCall(
  setup: CallSetup,
  transcript: TranscriptUtterance[],
): Promise<CallSummary | null> {
  try {
    const { query } = await loadSdk();
    const prompt = buildPrompt(setup, transcript);
    const q = query({
      prompt,
      options: {
        model: modelFor("recap"),
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
    const json = extractJson(collected);
    if (!json) {
      console.error("[summary] no JSON block in response");
      return null;
    }
    const parsed = JSON.parse(json) as CallSummary;
    if (!parsed.goalRecap || !Array.isArray(parsed.items)) {
      console.error("[summary] malformed payload");
      return null;
    }
    return parsed;
  } catch (e) {
    console.error("[summary] failed:", (e as Error).message);
    return null;
  }
}
