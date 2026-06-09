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
import { resolveClaudeCli } from "./claude-cli";

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

  let pushUserMessage: ((msg: string) => void) | null = null;
  let closeInput: (() => void) | null = null;
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
      // `tools` is not in current SDK options shape; allowedTools is the gate.
      maxTurns: 200,
      permissionMode: "bypassPermissions",
    },
  });

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
      pushUserMessage?.(
        `${triggerLine}\n\n--- transcript ---\n${transcriptBlock}\n--- end ---`,
      );
      await turnDone;
    },
    async close() {
      closeInput?.();
    },
  };
}
