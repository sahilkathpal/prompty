// Post-call summary card (RUBY_MVP decision #9).
//
// One post-call model pass over { full transcript with [me]/[them], the list of
// nudges Ruby surfaced with timestamps } produces a card with exactly three
// sections + a stat, landed on the call log JSON for the past-calls view to
// render:
//   1. recap            — a few lines of what was discussed.
//   2. insights         — notable takeaways/quotes; Ruby-assisted ones marked
//                          assisted:true with a short `via` clause.
//   3. questionsNotAsked — nudges Ruby surfaced that [me] never picked up.
//   + stat              — surfaced N (= nudges Ruby surfaced), used M (inferred).
//
// Attribution is INFERRED here, not tracked live: Ruby surfaced X at time t; if
// shortly after [me] asked something close and [them] revealed Y, that insight
// is "assisted". The pass is told to UNDER-CLAIM — a false claim of credit is
// worse than no claim, so a fuzzy match is left unmarked. M (used count) is
// derived from how many surfaced nudges the model attributes (assisted insights
// + any nudge it judges the user clearly acted on), so it can never exceed N.

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

/** One notable takeaway/quote. `assisted` flags a Ruby-credited one. */
export interface CallInsight {
  /** The takeaway or quote, 1-2 lines. */
  text: string;
  /** True only when the pass is confident Ruby's nudge led here. */
  assisted: boolean;
  /** Short trailing clause for assisted ones, e.g. "after Ruby's nudge to ask
   *  what they tried before". Empty for unassisted. */
  via: string;
}

/** A nudge Ruby surfaced that [me] never picked up. */
export interface UnaskedQuestion {
  /** The question/nudge Ruby surfaced, paraphrased or verbatim. */
  text: string;
}

export interface CallSummary {
  /** A few lines on what was discussed. */
  recap: string;
  insights: CallInsight[];
  questionsNotAsked: UnaskedQuestion[];
  /** Quiet stat. surfaced = nudges Ruby surfaced; used = inferred acted-on. */
  stat: { surfaced: number; used: number };
}

function fmtTime(ms: number, startedAt: number): string {
  // Nudge timestamps are wall-clock (Date.now()); render as mm:ss into the call.
  const rel = Math.max(0, Math.round((ms - startedAt) / 1000));
  const m = Math.floor(rel / 60);
  const s = rel % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildPrompt(
  transcript: TranscriptUtterance[],
  nudges: Nudge[],
  startedAt: number,
): string {
  const transcriptBlock =
    transcript.length === 0
      ? "(no transcript recorded)"
      : transcript.map((u) => `[${u.speaker}] ${u.text}`).join("\n");
  const nudgeBlock =
    nudges.length === 0
      ? "(Ruby surfaced nothing this call)"
      : nudges
          .map((n) => `- [${fmtTime(n.createdAt, startedAt)}] ${n.text}`)
          .join("\n");

  return `You are writing a short post-call card for a conversation that just ended. The user ("me" in the transcript) was the one being coached; the other party is "them". A live assistant named Ruby surfaced follow-up questions during the call. You have the FULL transcript and the list of questions Ruby surfaced, each with a timestamp.

Your job: produce three sections and one stat. ZERO of this is shown to Ruby — it's for the user to review later.

## Transcript ([me] = the user, [them] = the other party)
${transcriptBlock}

## Questions Ruby surfaced (with mm:ss into the call)
${nudgeBlock}

## How to attribute (read carefully)
For each question Ruby surfaced, decide whether the USER actually picked it up:
- Look just AFTER the surfaced timestamp. If [me] then asked something close to it, and [them] revealed something as a result, that insight is Ruby-ASSISTED.
- UNDER-CLAIM. If the match is fuzzy — the user might have gone there anyway, the timing is loose, the phrasing only loosely overlaps — do NOT mark it assisted and do NOT count it as used. A false claim of credit is worse than no claim.
- A surfaced question the user never asked (no close follow-up from [me] after it) belongs in "questions you didn't ask".

## Output
Reply with ONLY a single fenced JSON block. No prose before or after.

\`\`\`json
{
  "recap": "<a few lines (2-4 sentences) on what was discussed and where it landed>",
  "insights": [
    {
      "text": "<a notable takeaway or quote from the call, 1-2 lines>",
      "assisted": <true ONLY if you are confident Ruby's nudge led here; else false>,
      "via": "<if assisted: a short clause like 'after Ruby's nudge to ask what they tried before'; else empty string>"
    }
  ],
  "questionsNotAsked": [
    { "text": "<a question Ruby surfaced that the user never picked up>" }
  ],
  "stat": {
    "surfaced": <integer = number of questions Ruby surfaced, given above>,
    "used": <integer = how many of those the user clearly acted on; must be ≤ surfaced and should match the count of assisted insights unless a surfaced question was clearly acted on without yielding a notable insight>
  }
}
\`\`\`

Rules:
- 3-6 insights is typical; quote a phrase from the transcript when it's sharp.
- Only mark an insight assisted when the evidence is clear — bias toward false.
- "used" can never exceed "surfaced".
- If Ruby surfaced nothing, insights are still fine (just none assisted), questionsNotAsked is empty, and stat is {surfaced:0, used:0}.
- Be concrete and grounded in the transcript; invent nothing.`;
}

function extractJson(text: string): string | null {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const obj = text.match(/\{[\s\S]*\}/);
  return obj ? obj[0] : null;
}

/** Normalize + clamp a parsed payload so the renderer can trust its shape. */
function sanitize(parsed: unknown, surfacedCount: number): CallSummary | null {
  const p = parsed as Partial<CallSummary> & Record<string, unknown>;
  if (typeof p.recap !== "string") return null;
  const insights: CallInsight[] = Array.isArray(p.insights)
    ? p.insights
        .map((i) => {
          const it = i as Partial<CallInsight>;
          if (typeof it.text !== "string" || !it.text.trim()) return null;
          const assisted = it.assisted === true;
          return {
            text: it.text.trim(),
            assisted,
            via: assisted && typeof it.via === "string" ? it.via.trim() : "",
          };
        })
        .filter((x): x is CallInsight => x !== null)
    : [];
  const questionsNotAsked: UnaskedQuestion[] = Array.isArray(p.questionsNotAsked)
    ? p.questionsNotAsked
        .map((q) => {
          const qt = q as Partial<UnaskedQuestion>;
          return typeof qt.text === "string" && qt.text.trim()
            ? { text: qt.text.trim() }
            : null;
        })
        .filter((x): x is UnaskedQuestion => x !== null)
    : [];
  const rawStat = (p.stat ?? {}) as Partial<CallSummary["stat"]>;
  // Trust the real surfaced count over the model's; clamp used into [0, surfaced].
  const surfaced = surfacedCount;
  let used = Number.isFinite(rawStat.used) ? Math.round(Number(rawStat.used)) : 0;
  used = Math.max(0, Math.min(surfaced, used));
  return { recap: p.recap.trim(), insights, questionsNotAsked, stat: { surfaced, used } };
}

export async function summarizeCall(
  _setup: CallSetup,
  transcript: TranscriptUtterance[],
  nudges: Nudge[],
  startedAt: number,
): Promise<CallSummary | null> {
  try {
    const { query } = await loadSdk();
    const prompt = buildPrompt(transcript, nudges, startedAt);
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
    const summary = sanitize(JSON.parse(json), nudges.length);
    if (!summary) {
      console.error("[summary] malformed payload");
      return null;
    }
    return summary;
  } catch (e) {
    console.error("[summary] failed:", (e as Error).message);
    return null;
  }
}
