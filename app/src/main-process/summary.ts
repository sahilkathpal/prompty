// Post-call summary card (RUBY_MVP decision #9).
//
// One post-call model pass over { full transcript with [me]/[them], the list of
// nudges Ruby surfaced with timestamps } produces a card landed on the call log
// JSON for the past-calls view to render:
//   1. title    — a short label for the call.
//   2. recap    — the gist: a few lines of what was discussed.
//   3. insights — each LEADS with a derived takeaway; a verbatim `quote` is
//                  attached when it grounds or sharpens the point. Ruby-assisted
//                  insights are marked assisted:true with a short `via` clause.
//
// Attribution is INFERRED here, not tracked live: Ruby surfaced X at time t; if
// shortly after [me] asked something close and [them] revealed Y, that insight
// is "assisted". The pass is told to UNDER-CLAIM — a false claim of credit is
// worse than no claim, so a fuzzy match is left unmarked.

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
import { toolPolicy } from "./agent-guard";
import { modelFor } from "./models";

/** One insight: a derived takeaway, optionally backed by a verbatim quote. */
export interface CallInsight {
  /** The point — what this means for the user, as a sharp claim. Always present. */
  takeaway: string;
  /** A verbatim line from the transcript that grounds or sharpens the takeaway.
   *  Omitted when no quote adds anything. */
  quote?: string;
  /** True only when the pass is confident Ruby's nudge led here. */
  assisted: boolean;
  /** Short trailing clause for assisted ones, e.g. "after Ruby flagged the
   *  renewal date". Empty for unassisted. */
  via: string;
}

export interface CallSummary {
  /** A short label for the call: the other party's name (if introduced) + the
   *  topic, e.g. "Arjun — agent code review". Used as the call's title. */
  title: string;
  /** The gist — a few lines on what was discussed and where it landed. */
  recap: string;
  insights: CallInsight[];
}

export function fmtTime(ms: number, startedAt: number): string {
  // Nudge timestamps are wall-clock (Date.now()); render as mm:ss into the call.
  const rel = Math.max(0, Math.round((ms - startedAt) / 1000));
  const m = Math.floor(rel / 60);
  const s = rel % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function buildPrompt(
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

  return `You are writing a short post-call card for a conversation that just ended. The user ("me" in the transcript) ran the call; the other party is "them". Ruby, a live assistant, surfaced follow-up questions during the call. You have the FULL transcript and the list of questions Ruby surfaced, each with a timestamp.

Your job: a short title, a gist, and a handful of insights. ZERO of this is shown to Ruby — it's for the user to review later.

## Transcript ([me] = the user, [them] = the other party)
${transcriptBlock}

## Questions Ruby surfaced (with mm:ss into the call)
${nudgeBlock}

## What an insight is
Each insight LEADS with a takeaway: the synthesized point — what it means for the user — written as one sharp claim, not a transcription of what was said. Back it with a verbatim quote whenever the call gives you one that grounds or sharpens the point — which is most of the time. Drop the quote only when it would merely restate the takeaway in the speaker's own words and add nothing.

An insight is something the user LEARNED — a fact, signal, or implication from what was actually said. A question the user never asked is NOT an insight: do not surface unaddressed nudges as insights, and do not grade what the user failed to ask or cover.

## How to credit Ruby (read carefully)
For each question Ruby surfaced, decide whether the USER actually picked it up:
- Look just AFTER the surfaced timestamp. If [me] then asked something close to it, and [them] revealed something as a result, the insight it produced is Ruby-ASSISTED.
- UNDER-CLAIM. If the match is fuzzy — the user might have gone there anyway, the timing is loose, the phrasing only loosely overlaps — do NOT mark it assisted. A false claim of credit is worse than no claim.

## Output
Reply with ONLY a single fenced JSON block. No prose before or after.

\`\`\`json
{
  "title": "<a short 3-6 word title for this call: the other party's name if they introduce themselves, plus the topic — e.g. 'Arjun — agent code review' or 'Discovery: memory layer for designers'. No surrounding quotes.>",
  "recap": "<the gist: 2-4 sentences on what was discussed and where it landed>",
  "insights": [
    {
      "takeaway": "<the point, as one sharp claim — what this means for the user, not a quote>",
      "quote": "<OPTIONAL: a verbatim line from [me] or [them] that grounds or sharpens the takeaway. Include one whenever the transcript offers a fitting line; omit this field entirely ONLY when any quote would just echo the takeaway.>",
      "assisted": <true ONLY if you are confident Ruby's nudge led here; else false>,
      "via": "<if assisted: a short clause like 'after Ruby flagged the renewal date'; else empty string>"
    }
  ]
}
\`\`\`

Rules:
- 3-6 insights is typical.
- Lead every insight with the takeaway. Default to including a quote — most insights should have one. Omit it only when the best available line would merely repeat the takeaway.
- A quote must be VERBATIM from the transcript, not paraphrased.
- Only mark an insight assisted when the evidence is clear — bias toward false.
- If Ruby surfaced nothing, insights are still fine (just none assisted).
- Be concrete and grounded in the transcript; invent nothing.`;
}

export function extractJson(text: string): string | null {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const obj = text.match(/\{[\s\S]*\}/);
  return obj ? obj[0] : null;
}

/** Normalize a parsed payload so the renderer can trust its shape. */
export function sanitize(parsed: unknown): CallSummary | null {
  const p = parsed as Partial<CallSummary> & Record<string, unknown>;
  if (typeof p.recap !== "string") return null;
  const insights: CallInsight[] = Array.isArray(p.insights)
    ? p.insights
        .map((i) => {
          const it = i as Partial<CallInsight> & { text?: unknown };
          // Back-compat: legacy logs carried a single `text` field instead of a
          // takeaway. Fall back to it so old calls still render (takeaway-only).
          const rawTakeaway =
            typeof it.takeaway === "string" && it.takeaway.trim()
              ? it.takeaway
              : typeof it.text === "string"
                ? it.text
                : "";
          if (!rawTakeaway.trim()) return null;
          const assisted = it.assisted === true;
          const quote = typeof it.quote === "string" && it.quote.trim() ? it.quote.trim() : undefined;
          return {
            takeaway: rawTakeaway.trim(),
            ...(quote ? { quote } : {}),
            assisted,
            via: assisted && typeof it.via === "string" ? it.via.trim() : "",
          };
        })
        .filter((x): x is CallInsight => x !== null)
    : [];
  const title = typeof p.title === "string" ? p.title.trim().replace(/^["']|["']$/g, "") : "";
  return { title, recap: p.recap.trim(), insights };
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
        // This pass ingests the FULL untrusted transcript. tools:[] + the
        // deny-by-default gate ensure a prompt injection in a [them] utterance
        // cannot reach a Bash/Read/Write tool. (Previously this query set neither
        // tools:[] nor a gate while running bypassPermissions — audit finding #1.)
        ...toolPolicy(),
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
    const summary = sanitize(JSON.parse(json));
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
