// Prep agent — the conversational pre-call partner (RUBY B2 phase 2b).
//
// Distinct from the in-call nudge agent (agent.ts): this is a normal multi-turn
// chat. The user talks through an upcoming call; Ruby interviews them to sharpen
// the agenda and, as understanding firms up, rewrites the call's "working
// direction" via the `update_direction` tool. That direction is the same
// artifact the Direction editor holds and the call consumes at start — so prep
// has no separate "arm" step: it just fills the direction the user will Start.
//
// In 2b the only tool is update_direction. Structured components (goal/checklist)
// are layered on in phase 3a by adding more tools to this same server.

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
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadPrepPrompt } from "./prompts/prep";
import { agentCwd, resolveClaudeCli } from "./claude-cli";
import { modelFor } from "./models";
import type { PrepComponent } from "./types";

export type PrepEvents = {
  /** A complete assistant chat message for one turn. */
  onAssistant: (text: string) => void;
  /** The working direction was (re)written by the agent. */
  onDirection: (direction: string) => void;
  /** The component set (goal/checklist) changed — the full current list. */
  onComponents: (components: PrepComponent[]) => void;
  onError: (e: Error) => void;
  /** Fired when a turn finishes (model done replying). */
  onTurnDone?: () => void;
};

export type PrepAgent = {
  send(message: string): Promise<void>;
  close(): Promise<void>;
};

/**
 * Open a prep chat session seeded with the current working direction. Each
 * send() is one user turn; the assistant's reply arrives via onAssistant and any
 * direction rewrite via onDirection.
 */
export async function openPrepAgent(
  initialDirection: string,
  events: PrepEvents,
): Promise<PrepAgent> {
  if (process.env.PROMPTY_MOCK_AGENT === "1") {
    return openMockPrepAgent(initialDirection, events);
  }

  const { query, tool, createSdkMcpServer } = await loadSdk();

  // Live component set (goal/checklist) built across the conversation. Tools
  // mutate it and emit the whole list, mirroring update_direction's full-replace
  // contract so the renderer never has to reconcile deltas.
  const components: PrepComponent[] = [];
  const emitComponents = () => events.onComponents(components.map((c) => ({ ...c })));

  const mcp = createSdkMcpServer({
    name: "prompty-prep",
    version: "0.1.0",
    tools: [
      tool(
        "update_direction",
        "Rewrite the call's working direction — the brief the coach will follow on the call. Call this whenever your understanding of the user's goal firms up. Pass the COMPLETE direction each time (it replaces the previous one), not a delta.",
        {
          direction: z
            .string()
            .describe(
              "The full coaching brief: what a good call looks like, what to explore, the stance to carry, when to speak up.",
            ),
        },
        async (args) => {
          events.onDirection(args.direction);
          return { content: [{ type: "text", text: "direction_updated" }] };
        },
      ),
      tool(
        "set_goal",
        "Set the single overarching goal for the call — the one outcome that, if achieved, makes it a success. Replaces any existing goal.",
        {
          text: z.string().describe("One crisp sentence naming the call's goal."),
        },
        async (args) => {
          upsertGoal(components, args.text);
          emitComponents();
          return { content: [{ type: "text", text: "goal_set" }] };
        },
      ),
      tool(
        "set_checklist",
        "Set the checklist of things to cover on the call. Pass the COMPLETE ordered list each time (it replaces the previous checklist), not a delta.",
        {
          title: z.string().optional().describe("Optional short label for the checklist."),
          items: z
            .array(z.string())
            .describe("The ordered items to cover, each a short phrase."),
        },
        async (args) => {
          upsertChecklist(components, args.title, args.items);
          emitComponents();
          return { content: [{ type: "text", text: "checklist_set" }] };
        },
      ),
    ],
  });

  // Streaming input: one user message per turn, mirroring agent.ts.
  let pushUserMessage: ((msg: string) => void) | null = null;
  let closeInput: (() => void) | null = null;
  let closing = false;
  let assistantText = "";
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
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: queue.shift()! },
        parent_tool_use_id: null,
        session_id: "",
      };
    }
  })();

  const q = query({
    prompt: inputStream,
    options: {
      model: modelFor("hotkey"),
      systemPrompt: loadPrepPrompt(initialDirection),
      pathToClaudeCodeExecutable: resolveClaudeCli(),
      cwd: agentCwd(),
      mcpServers: { "prompty-prep": mcp },
      allowedTools: [
        "mcp__prompty-prep__update_direction",
        "mcp__prompty-prep__set_goal",
        "mcp__prompty-prep__set_checklist",
      ],
      maxTurns: 200,
      permissionMode: "bypassPermissions",
    },
  });

  (async () => {
    try {
      for await (const msg of q) {
        if (msg.type === "assistant") {
          for (const block of msg.message.content ?? []) {
            if ((block as { type?: string }).type === "text") {
              assistantText += (block as { text?: string }).text ?? "";
            }
          }
        }
        if (msg.type === "result") {
          const text = assistantText.trim();
          assistantText = "";
          if (text) events.onAssistant(text);
          events.onTurnDone?.();
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
    async send(message) {
      const turnDone = new Promise<void>((r) => turnDoneWaiters.push(r));
      pushUserMessage?.(message);
      await turnDone;
    },
    async close() {
      closing = true;
      closeInput?.();
    },
  };
}

/** Replace (or insert) the single goal component. */
function upsertGoal(components: PrepComponent[], text: string): void {
  const existing = components.find((c) => c.type === "goal");
  if (existing && existing.type === "goal") existing.text = text;
  else components.push({ type: "goal", id: randomUUID(), text });
}

/** Replace (or insert) the checklist component with a fresh ordered item set. */
function upsertChecklist(
  components: PrepComponent[],
  title: string | undefined,
  items: string[],
): void {
  const checklist: PrepComponent = {
    type: "checklist",
    id: randomUUID(),
    title,
    items: items
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => ({ id: randomUUID(), text: t, done: false })),
  };
  const idx = components.findIndex((c) => c.type === "checklist");
  if (idx === -1) components.push(checklist);
  else components[idx] = checklist;
}

/**
 * Deterministic mock for E2E/dev (PROMPTY_MOCK_AGENT=1): no model, no CLI. Each
 * send() echoes a canned reply, folds the message into the working direction,
 * and builds a goal + checklist from it — so the UI/IPC wiring (chat bubbles,
 * live direction edits, component cards) can be driven and asserted without a
 * real agent.
 */
function openMockPrepAgent(
  initialDirection: string,
  events: PrepEvents,
): PrepAgent {
  let direction = initialDirection.trim();
  const components: PrepComponent[] = [];
  return {
    async send(message) {
      const focus = message.trim();
      direction = direction
        ? `${direction}\nFocus: ${focus}`
        : `Focus: ${focus}`;
      events.onDirection(direction);
      upsertGoal(components, `Goal: ${focus}`);
      upsertChecklist(components, "Cover", [`Cover ${focus}`, "Agree next steps"]);
      events.onComponents(components.map((c) => ({ ...c })));
      events.onAssistant(`Updated the working direction to focus on: ${focus}`);
      events.onTurnDone?.();
    },
    async close() {
      /* nothing to tear down */
    },
  };
}
