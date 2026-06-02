import {
  query,
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  CallSetup,
  ChecklistItem,
  Nudge,
  TranscriptUtterance,
} from "./types.ts";
import { buildSystemPrompt } from "./prompts/system.ts";
import { resolveClaudeCli } from "./claude-cli.ts";

export type AgentEvents = {
  onNudge: (n: Nudge) => void;
  onChecklistUpdate: (id: string, status: ChecklistItem["status"]) => void;
  onStayQuiet: (reason: string) => void;
  onError: (e: Error) => void;
};

export type Agent = {
  /** Feed a transcript window (recent utterances) and ask for a decision. */
  consider(window: TranscriptUtterance[], trigger: "auto" | "hotkey"): Promise<void>;
  /** Tear down the underlying Claude process. */
  close(): Promise<void>;
};

/**
 * Open a long-running Agent SDK session for one call.
 *
 * Internally uses query() with a streaming user-message iterable so the same
 * underlying Claude process handles every consider() turn (keeps prompt cache
 * warm and avoids re-feeding the system prompt + setup each turn).
 */
export function openAgent(setup: CallSetup, events: AgentEvents): Agent {
  const decisionCounters = { nudge: 0, quiet: 0, checklist: 0 };

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
          events.onNudge({
            id: `n_${Date.now()}_${decisionCounters.nudge}`,
            kind: args.kind,
            text: args.text,
            urgency: args.urgency,
            createdAt: Date.now(),
          });
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
          events.onStayQuiet(args.reason);
          return { content: [{ type: "text", text: "quiet_logged" }] };
        },
      ),
    ],
  });

  // Streaming-input iterable that we push user messages into.
  let pushUserMessage: ((msg: string) => void) | null = null;
  let closeInput: (() => void) | null = null;
  // Each consider() awaits the next `result` message before returning.
  const turnDoneWaiters: Array<() => void> = [];

  const inputStream = (async function* () {
    const queue: string[] = [];
    let waiter: (() => void) | null = null;
    let closed = false;

    pushUserMessage = (msg: string) => {
      queue.push(msg);
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
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: next },
        parent_tool_use_id: null,
        session_id: "",
      };
    }
  })();

  const q = query({
    prompt: inputStream,
    options: {
      systemPrompt: buildSystemPrompt(setup),
      pathToClaudeCodeExecutable: resolveClaudeCli(),
      mcpServers: { "prompty-nudges": mcp },
      allowedTools: [
        "mcp__prompty-nudges__emit_nudge",
        "mcp__prompty-nudges__update_checklist",
        "mcp__prompty-nudges__stay_quiet",
      ],
      tools: [
        "mcp__prompty-nudges__emit_nudge",
        "mcp__prompty-nudges__update_checklist",
        "mcp__prompty-nudges__stay_quiet",
      ],
      maxTurns: 200,
      permissionMode: "bypassPermissions",
    },
  });

  // Drain the assistant message stream so the loop runs. We don't render
  // anything from these — the tool handlers are our real output channel.
  // Each `result` message marks the end of one turn; wake the next consider().
  (async () => {
    try {
      for await (const msg of q) {
        if (msg.type === "result") {
          if (msg.subtype !== "success") {
            events.onError(new Error(`agent error: ${msg.subtype}`));
          }
          turnDoneWaiters.shift()?.();
        }
      }
      // Stream closed — wake any pending waiters so callers don't hang.
      while (turnDoneWaiters.length) turnDoneWaiters.shift()!();
    } catch (e) {
      events.onError(e as Error);
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
          ? "The user just hit the hotkey asking 'what should I ask?'. Emit one helpful nudge of kind 'answer' even if you would otherwise stay quiet — but keep it ≤15 words and concrete."
          : "Recent transcript chunk. Decide: emit_nudge / update_checklist / stay_quiet. Default to stay_quiet unless a nudge is clearly warranted.";
      const turnDone = new Promise<void>((r) => turnDoneWaiters.push(r));
      pushUserMessage?.(
        `${triggerLine}\n\n--- transcript ---\n${transcriptBlock}\n--- end ---`,
      );
      await turnDone;
    },
    async close() {
      closeInput?.();
      // Best-effort: the streaming iterable will end naturally when closed.
    },
  };
}
