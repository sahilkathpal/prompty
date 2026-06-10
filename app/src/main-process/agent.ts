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
  ChecklistItem,
  Nudge,
  TranscriptUtterance,
} from "./types";
import { buildSystemPrompt } from "./prompts/system";
import { agentCwd, resolveClaudeCli } from "./claude-cli";

export type AgentEvents = {
  onNudge: (n: Nudge) => void;
  onChecklistUpdate: (id: string, status: ChecklistItem["status"]) => void;
  onStayQuiet: (reason: string) => void;
  onError: (e: Error) => void;
};

export type Agent = {
  consider(window: TranscriptUtterance[], trigger: "auto" | "hotkey"): Promise<void>;
  noteChecklistChange(itemId: string, status: ChecklistItem["status"], itemText: string): void;
  close(): Promise<void>;
};

export async function openAgent(setup: CallSetup, events: AgentEvents): Promise<Agent> {
  const { query, tool, createSdkMcpServer } = await loadSdk();
  const decisionCounters = { nudge: 0, quiet: 0, checklist: 0 };
  // Tracks the start of the most recent consider() turn so the emit_nudge
  // handler can log hotkey/auto latency. 0 = no turn in flight.
  let considerStart = 0;
  let considerTrigger: "auto" | "hotkey" | null = null;
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
          kind: z.enum([
            "segue",
            "missed-goal",
            "fact-reminder",
            "correction",
            "answer",
          ]),
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
          if (considerStart > 0) {
            console.log(
              `[timing] ${considerTrigger ?? "?"} nudge emitted ${Date.now() - considerStart}ms after consider() (turn #${turnCount})`,
            );
            considerStart = 0;
          }
          logDecision("emit_nudge", ` kind=${args.kind} text="${args.text}"`);
          events.onNudge({
            id: `n_${Date.now()}_${decisionCounters.nudge}`,
            kind: args.kind,
            text: args.text,
            urgency: args.urgency,
            createdAt: Date.now(),
          });
          finishTurnEarly();
          return { content: [{ type: "text", text: "nudge_emitted" }] };
        },
      ),
      tool(
        "update_checklist",
        "Mark a checklist item as covered or partially covered.",
        {
          item_id: z.string(),
          status: z.enum(["partial", "covered"]),
        },
        async (args) => {
          decisionCounters.checklist++;
          logDecision("update_checklist", ` item=${args.item_id} ${args.status}`);
          events.onChecklistUpdate(args.item_id, args.status);
          return { content: [{ type: "text", text: "checklist_updated" }] };
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
          logDecision("stay_quiet", ` reason="${args.reason}"`);
          events.onStayQuiet(args.reason);
          finishTurnEarly();
          return { content: [{ type: "text", text: "quiet_logged" }] };
        },
      ),
    ],
  });

  type TurnMeta = { trigger: string; turnId: number; enqueuedAt: number };
  let pushUserMessage: ((msg: string, meta?: TurnMeta) => void) | null = null;
  let closeInput: (() => void) | null = null;
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
      // Nudges are short, structured outputs the user is actively waiting on
      // after a hotkey — use the fastest model rather than the CLI default.
      model: "claude-haiku-4-5",
      systemPrompt: buildSystemPrompt(setup),
      pathToClaudeCodeExecutable: resolveClaudeCli(),
      // Keep the CLI's workspace scan out of the user's protected folders.
      cwd: agentCwd(),
      mcpServers: { "prompty-nudges": mcp },
      allowedTools: [
        "mcp__prompty-nudges__emit_nudge",
        "mcp__prompty-nudges__update_checklist",
        "mcp__prompty-nudges__stay_quiet",
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
        if (msg.type === "result") {
          // A non-success subtype is only an error if we didn't deliberately
          // cut the turn short after the decision landed.
          if (msg.subtype !== "success" && !interruptedTurn) {
            events.onError(new Error(`agent error: ${msg.subtype}`));
          }
          turnDecided = false;
          interruptedTurn = false;
          turnDoneWaiters.shift()?.();
        }
      }
      while (turnDoneWaiters.length) turnDoneWaiters.shift()!();
    } catch (e) {
      events.onError(e as Error);
      while (turnDoneWaiters.length) turnDoneWaiters.shift()!();
    }
  })();

  return {
    noteChecklistChange(itemId, status, itemText) {
      const note =
        status === "skipped"
          ? `[user override] Checklist item ${itemId} ("${itemText}") marked SKIPPED — user says it's irrelevant for this call. Do not emit nudges about it.`
          : status === "covered"
            ? `[user override] Checklist item ${itemId} ("${itemText}") marked COVERED by the user. Do not emit nudges about it.`
            : `[user override] Checklist item ${itemId} ("${itemText}") status set to ${status} by the user.`;
      pushUserMessage?.(note);
      turnDoneWaiters.push(() => {});
    },
    async consider(window, trigger) {
      const transcriptBlock = window
        .map((u) => `[${u.speaker}] ${u.text}`)
        .join("\n");
      const triggerLine =
        trigger === "hotkey"
          ? "The user just hit the hotkey asking 'what should I ask?'. Emit one helpful nudge of kind 'answer' even if you would otherwise stay quiet — but keep it ≤15 words and concrete."
          : "Recent transcript chunk. Decide: emit_nudge / update_checklist / stay_quiet. Default to stay_quiet unless a nudge is clearly warranted.";
      const turnDone = new Promise<void>((r) => turnDoneWaiters.push(r));
      const t0 = Date.now();
      turnCount++;
      considerStart = t0;
      considerTrigger = trigger;
      pushUserMessage?.(
        `${triggerLine}\n\n--- transcript ---\n${transcriptBlock}\n--- end ---`,
        { trigger, turnId: turnCount, enqueuedAt: t0 },
      );
      await turnDone;
      console.log(
        `[timing] ${trigger} consider() turn fully done in ${Date.now() - t0}ms`,
      );
    },
    async close() {
      closeInput?.();
    },
  };
}
