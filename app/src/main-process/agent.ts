// claude-agent-sdk is ESM-only; load it lazily so this CJS bundle can require() this file.
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
import { z } from "zod";
import type {
  CallSetup,
  Nudge,
  TranscriptUtterance,
} from "./types";
import { buildSystemPrompt } from "./prompts/system";
import { agentCwd, resolveClaudeCli } from "./claude-cli";
import { modelFor } from "./models";
import { debugFullPrompt } from "./debug-logger";

/**
 * Per-turn debug record emitted to AgentEvents.onDebug when debug mode is on.
 * Captures the model's-eye view of one consider() turn: the dynamic context it
 * saw, the raw text it produced, the tools it called, and what it decided.
 */
export interface AgentTurnDebug {
  trigger: "auto" | "hotkey";
  turnId: number;
  /** The dynamic per-turn user message (trigger line + transcript window). */
  context: string;
  /** Resolved static system prompt — only under PROMPTY_DEBUG_FULL_PROMPT. */
  systemPrompt?: string;
  /** Raw assistant text for the turn (decisions ride on tool calls). */
  assistantText: string;
  toolCalls: { name: string; args: unknown }[];
  decision: "emit_nudge" | "stay_quiet" | "none";
  /** stay_quiet reason, when that was the decision. */
  reason?: string;
  nudgeFired: boolean;
  latencyMs: number;
}

export type AgentEvents = {
  onNudge: (n: Nudge) => void;
  onStayQuiet: (reason: string) => void;
  onError: (e: Error) => void;
  /** A checklist item was marked covered during the call (RUBY B3 phase 3c). */
  onItemCovered?: (itemId: string) => void;
  /** Optional verbose per-turn capture (debug mode). */
  onDebug?: (turn: AgentTurnDebug) => void;
};

export type Agent = {
  consider(window: TranscriptUtterance[], trigger: "auto" | "hotkey"): Promise<void>;
  close(): Promise<void>;
};

export async function openAgent(setup: CallSetup, events: AgentEvents): Promise<Agent> {
  const { query, tool, createSdkMcpServer } = await loadSdk();
  const decisionCounters = { nudge: 0, quiet: 0 };
  // Tracks the start of the most recent consider() turn so the emit_nudge
  // handler can log hotkey/auto latency. 0 = no turn in flight.
  let considerStart = 0;
  let considerTrigger: "auto" | "hotkey" | null = null;
  // Per-turn debug accumulator (set in consider(), flushed on the turn's
  // result). The session is serial — one consider() turn runs at a time in the
  // real path — so a single mutable record is safe.
  type DbgTurnState = {
    trigger: "auto" | "hotkey";
    turnId: number;
    context: string;
    systemPrompt?: string;
    assistantText: string;
    toolCalls: { name: string; args: unknown }[];
    stayQuietReason?: string;
    t0: number;
  };
  let dbgTurn: DbgTurnState | null = null;
  // Turns accumulated in this persistent session — if latency climbs alongside
  // this number over a call, the growing context is the bottleneck.
  let turnCount = 0;

  // --- Optional turn-timing instrumentation (PROMPTY_AGENT_TIMING=1) ---------
  // Observe-only. Splits each turn into queue-wait (enqueue → start) and model
  // time (start → decision), and records what the turn decided. turnStartAt /
  // turnMeta are set the moment a message is actually pulled for processing (at
  // the yield below), so they stay accurate when turns queue behind one another
  // — unlike considerStart, which is enqueue-time and gets overwritten.
  const TIMING = process.env.PROMPTY_AGENT_TIMING === "1";
  let turnStartAt = 0;
  let turnMeta: { trigger: string; turnId: number; enqueuedAt: number } | null = null;
  const logDecision = (decision: string, extra = "") => {
    if (!TIMING || !turnMeta) return;
    console.log(
      `[timing] turn #${turnMeta.turnId} (${turnMeta.trigger}) DECIDED ${decision} after ${Date.now() - turnStartAt}ms model${extra}`,
    );
    turnMeta = null;
  };

  // Once the agent makes its user-facing decision (a nudge or an explicit
  // stay-quiet) the turn has produced everything we need. Left to its own
  // devices it keeps running — more tool calls, a wrap-up message — for many
  // seconds, holding this single serial session and blocking the next
  // consider() (including a hotkey press). interruptTurn() cuts the turn short
  // the moment the decision lands. Assigned once the query handle exists below.
  let turnDecided = false;
  let interruptedTurn = false;
  let interruptQuery: () => void = () => {};
  const finishTurnEarly = () => {
    if (turnDecided) return;
    turnDecided = true;
    interruptedTurn = true;
    interruptQuery();
  };

  const mcp = createSdkMcpServer({
    name: "prompty-nudges",
    version: "0.1.0",
    tools: [
      tool(
        "emit_nudge",
        "Surface a single high-signal nudge to the user during the call.",
        {
          text: z
            .string()
            .max(180)
            .describe(
              "≤15 words. A thing the user can say or ask, not meta-commentary.",
            ),
          urgency: z.enum(["high", "medium"]),
        },
        async (args) => {
          decisionCounters.nudge++;
          dbgTurn?.toolCalls.push({ name: "emit_nudge", args });
          if (considerStart > 0) {
            console.log(
              `[timing] ${considerTrigger ?? "?"} nudge emitted ${Date.now() - considerStart}ms after consider() (turn #${turnCount})`,
            );
            considerStart = 0;
          }
          logDecision("emit_nudge", ` text="${args.text}"`);
          events.onNudge({
            id: `n_${Date.now()}_${decisionCounters.nudge}`,
            text: args.text,
            urgency: args.urgency,
            createdAt: Date.now(),
          });
          finishTurnEarly();
          return { content: [{ type: "text", text: "nudge_emitted" }] };
        },
      ),
      tool(
        "stay_quiet",
        "Explicit no-op when nothing high-signal applies. Use this as the default.",
        {
          reason: z.string().max(120),
        },
        async (args) => {
          decisionCounters.quiet++;
          if (dbgTurn) {
            dbgTurn.toolCalls.push({ name: "stay_quiet", args });
            dbgTurn.stayQuietReason = args.reason;
          }
          logDecision("stay_quiet", ` reason="${args.reason}"`);
          events.onStayQuiet(args.reason);
          finishTurnEarly();
          return { content: [{ type: "text", text: "quiet_logged" }] };
        },
      ),
      tool(
        "mark_covered",
        "Mark a checklist item as covered once the call has genuinely addressed it. Auxiliary — it does NOT end the turn; you must still call emit_nudge or stay_quiet for your decision.",
        {
          itemId: z
            .string()
            .describe("The id of the checklist item shown in the ## Checklist section."),
        },
        async (args) => {
          dbgTurn?.toolCalls.push({ name: "mark_covered", args });
          events.onItemCovered?.(args.itemId);
          return { content: [{ type: "text", text: "marked_covered" }] };
        },
      ),
    ],
  });

  type TurnMeta = { trigger: string; turnId: number; enqueuedAt: number };
  let pushUserMessage: ((msg: string, meta?: TurnMeta) => void) | null = null;
  let closeInput: (() => void) | null = null;
  // Set by close(): once we deliberately tear down the session, the SDK kills
  // the claude subprocess and the consumer loop throws "process exited with
  // code 1". That's teardown noise, not an agent failure — swallow it so it
  // never reaches onError (which would surface a spurious error on every normal
  // call end, and trip the replay harness's error count).
  let closing = false;
  const turnDoneWaiters: Array<() => void> = [];

  const inputStream = (async function* () {
    const queue: { content: string; meta?: TurnMeta }[] = [];
    let waiter: (() => void) | null = null;
    let closed = false;

    pushUserMessage = (msg: string, meta?: TurnMeta) => {
      queue.push({ content: msg, meta });
      waiter?.();
    };
    closeInput = () => {
      closed = true;
      waiter?.();
    };

    while (true) {
      if (queue.length === 0) {
        if (closed) return;
        await new Promise<void>((r) => (waiter = r));
        waiter = null;
        if (closed && queue.length === 0) return;
      }
      const next = queue.shift()!;
      // A turn begins processing the moment it's pulled here. Anchor timing so
      // the decision log can split queue-wait from model time.
      turnStartAt = Date.now();
      turnMeta = next.meta ?? null;
      if (TIMING && next.meta) {
        console.log(
          `[timing] turn #${next.meta.turnId} (${next.meta.trigger}) START — waited ${turnStartAt - next.meta.enqueuedAt}ms in queue`,
        );
      }
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: next.content },
        parent_tool_use_id: null,
        session_id: "",
      };
    }
  })();

  const q = query({
    prompt: inputStream,
    options: {
      // The nudge taxonomy needs real judgment, so this role favours quality
      // over raw speed (see models.ts); the coalescing queue + stay_quiet
      // default bound the call volume. Overridable via PROMPTY_MODEL_NUDGE.
      model: modelFor("nudge"),
      systemPrompt: buildSystemPrompt(setup),
      pathToClaudeCodeExecutable: resolveClaudeCli(),
      // Keep the CLI's workspace scan out of the user's protected folders.
      cwd: agentCwd(),
      mcpServers: { "prompty-nudges": mcp },
      allowedTools: [
        "mcp__prompty-nudges__emit_nudge",
        "mcp__prompty-nudges__stay_quiet",
        "mcp__prompty-nudges__mark_covered",
      ],
      // `tools` is not in current SDK options shape; allowedTools is the gate.
      maxTurns: 200,
      permissionMode: "bypassPermissions",
    },
  });

  interruptQuery = () => {
    void q.interrupt().catch(() => {
      // The turn may have already wound down on its own; nothing to interrupt.
    });
  };

  (async () => {
    try {
      for await (const msg of q) {
        // Cast required: this IIFE both reads and assigns `dbgTurn` (= null
        // below), so TS seeds local control-flow with the capture-time type
        // (null) and never widens back to the declared union. The real value is
        // set by consider() in a sibling closure.
        const dt = dbgTurn as DbgTurnState | null;
        if (msg.type === "assistant" && dt) {
          for (const block of msg.message.content ?? []) {
            if ((block as { type?: string }).type === "text") {
              dt.assistantText += (block as { text?: string }).text ?? "";
            }
          }
        }
        if (msg.type === "result") {
          // A non-success subtype is only an error if we didn't deliberately
          // cut the turn short after the decision landed.
          if (msg.subtype !== "success" && !interruptedTurn) {
            events.onError(new Error(`agent error: ${msg.subtype}`));
          }
          // Flush the turn's debug record (if capturing). Done here, on the
          // result, so it fires exactly once per turn regardless of whether the
          // turn was interrupted early after its decision landed.
          if (dt && events.onDebug) {
            const tc = dt.toolCalls;
            const nudgeFired = tc.some((c) => c.name === "emit_nudge");
            const decision = nudgeFired
              ? "emit_nudge"
              : tc.some((c) => c.name === "stay_quiet")
                ? "stay_quiet"
                : "none";
            events.onDebug({
              trigger: dt.trigger,
              turnId: dt.turnId,
              context: dt.context,
              systemPrompt: dt.systemPrompt,
              assistantText: dt.assistantText,
              toolCalls: tc,
              decision,
              reason: dt.stayQuietReason,
              nudgeFired,
              latencyMs: Date.now() - dt.t0,
            });
          }
          dbgTurn = null;
          turnDecided = false;
          interruptedTurn = false;
          turnDoneWaiters.shift()?.();
        }
      }
      while (turnDoneWaiters.length) turnDoneWaiters.shift()!();
    } catch (e) {
      if (!closing) events.onError(e as Error);
      while (turnDoneWaiters.length) turnDoneWaiters.shift()!();
    }
  })();

  return {
    async consider(window, trigger) {
      const transcriptBlock = window
        .map((u) => `[${u.speaker}] ${u.text}`)
        .join("\n");
      const triggerLine =
        trigger === "hotkey"
          ? "The user just hit the hotkey asking 'what should I ask?'. Emit one helpful nudge even if you would otherwise stay quiet — but keep it ≤15 words and concrete."
          : "Recent transcript chunk. Decide: emit_nudge / stay_quiet. Default to stay_quiet unless a nudge is clearly warranted.";
      const turnDone = new Promise<void>((r) => turnDoneWaiters.push(r));
      const t0 = Date.now();
      turnCount++;
      considerStart = t0;
      considerTrigger = trigger;
      const userMsg = `${triggerLine}\n\n--- transcript ---\n${transcriptBlock}\n--- end ---`;
      if (events.onDebug) {
        dbgTurn = {
          trigger,
          turnId: turnCount,
          context: userMsg,
          systemPrompt: debugFullPrompt() ? buildSystemPrompt(setup) : undefined,
          assistantText: "",
          toolCalls: [],
          t0,
        };
      }
      pushUserMessage?.(userMsg, { trigger, turnId: turnCount, enqueuedAt: t0 });
      await turnDone;
      console.log(
        `[timing] ${trigger} consider() turn fully done in ${Date.now() - t0}ms`,
      );
    },
    async close() {
      closing = true;
      closeInput?.();
    },
  };
}
