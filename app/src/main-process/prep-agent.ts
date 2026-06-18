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
import { addMemory } from "./memory-store";
import type { PrepComponent } from "./types";

export type PrepEvents = {
  /** Incremental assistant text as it streams in, for a responsive chat. */
  onAssistantDelta?: (text: string) => void;
  /** A complete assistant chat message for one turn (authoritative). */
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
  /**
   * Emit the opening turn: Ruby reflects the seed brief back and asks whether to
   * flesh it out or go. Special-cased — it does NOT fold the brief into the
   * direction or offer components (that's send()'s job on later turns). When the
   * session resumes a prep that already has components, the opening acknowledges
   * them instead of asking the bare fork.
   */
  open(): Promise<void>;
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
  existingComponents: PrepComponent[] = [],
): Promise<PrepAgent> {
  if (process.env.PROMPTY_MOCK_AGENT === "1") {
    return openMockPrepAgent(initialDirection, events, existingComponents);
  }

  const { query, tool, createSdkMcpServer } = await loadSdk();

  // Live component set (goal/checklist) built across the conversation. Tools
  // mutate it and emit the whole list, mirroring update_direction's full-replace
  // contract so the renderer never has to reconcile deltas. Seeded from any
  // components carried in from a resumed prep so the agent can reference them.
  const components: PrepComponent[] = existingComponents.map((c) => ({ ...c }));
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
      tool(
        "write_memory",
        "Save a durable preference about how Ruby should coach the user in FUTURE calls. Only call this after the user has agreed to remember it. The text is a standing instruction about Ruby's behaviour, not a fact about this call.",
        {
          text: z
            .string()
            .describe("The preference, in the user's own framing — one sentence."),
        },
        async (args) => {
          // Global, persistent memory — unlike goal/checklist this isn't a per-call
          // component, so there's no component to emit, just a write to the store.
          addMemory(args.text);
          return { content: [{ type: "text", text: "memory_saved" }] };
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
      systemPrompt: loadPrepPrompt(initialDirection, components),
      pathToClaudeCodeExecutable: resolveClaudeCli(),
      // Stream partial assistant text so the chat updates as it generates
      // rather than only when the whole turn (incl. tool calls) finishes.
      includePartialMessages: true,
      cwd: agentCwd(),
      mcpServers: { "prompty-prep": mcp },
      // Only our MCP prep tools — no claude_code built-ins. Without this the agent
      // inherits the full preset, which defers MCP tools behind ToolSearch (see the
      // detailed note in agent.ts) and hands a chat agent needless filesystem/shell
      // access.
      tools: [],
      allowedTools: [
        "mcp__prompty-prep__update_direction",
        "mcp__prompty-prep__set_goal",
        "mcp__prompty-prep__set_checklist",
        "mcp__prompty-prep__write_memory",
      ],
      maxTurns: 200,
      permissionMode: "bypassPermissions",
    },
  });

  (async () => {
    try {
      for await (const msg of q) {
        // Token-level streaming: emit text deltas as they arrive.
        if ((msg as { type?: string }).type === "stream_event") {
          const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            const t = ev.delta.text ?? "";
            if (t) events.onAssistantDelta?.(t);
          }
          continue;
        }
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
    async open() {
      // Kick the opening turn: the seed brief is the agent's first user message,
      // and prep.md instructs it to reflect the brief back and ask the
      // flesh-out-or-go fork (no direction rewrite, no component offer on turn 1;
      // acknowledge any already-pinned components on resume).
      const turnDone = new Promise<void>((r) => turnDoneWaiters.push(r));
      pushUserMessage?.(initialDirection.trim() || "Let's prep this call.");
      await turnDone;
    },
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
 * Deterministic mock for E2E/dev (PROMPTY_MOCK_AGENT=1): no model, no CLI. It
 * mirrors the real suggest-then-create gate so the consent flow can be driven
 * and asserted without a model:
 *
 * - A substantive message M folds into the direction ("Focus: M") and, on a
 *   normal call, makes the mock OFFER a goal + checklist — no components yet.
 * - A following affirmative ("yes") then CREATES them from the remembered focus:
 *   goal "Goal: M", checklist "Cover" with items "Cover M" / "Agree next steps".
 * - An affirmative-less decline ("no") drops the offer and is sticky for the
 *   session (no re-offer).
 * - A low-value message (mentions "casual" / "catch up") only updates the
 *   direction and offers nothing — the negative case.
 * - A voiced nudging preference ("nudge me rarely", "don't interrupt me") OFFERS
 *   to remember it; a following affirmative writes it to memory; a decline drops
 *   it. This is a separate pending slot from the goal/checklist offer, so the two
 *   consent flows don't collide.
 */
const MOCK_AFFIRM = /\b(yes|yeah|yep|sure|please|ok|okay|go ahead|do it|sounds good)\b/i;
const MOCK_DECLINE = /\b(no|nope|nah|skip|don't|do not|leave it)\b/i;
const MOCK_LOW_VALUE = /\b(casual|catch[\s-]?up|catching up|chit[\s-]?chat|no agenda)\b/i;
const MOCK_NUDGE_PREF =
  /\b(nudge me|interrupt me|push me|stay quiet|don'?t interrupt|only when|remember (that|to))\b/i;

function openMockPrepAgent(
  initialDirection: string,
  events: PrepEvents,
  existingComponents: PrepComponent[] = [],
): PrepAgent {
  let direction = initialDirection.trim();
  const components: PrepComponent[] = existingComponents.map((c) => ({ ...c }));
  // The substantive focus awaiting a yes/no; null when nothing is pending.
  let pendingFocus: string | null = null;
  // A voiced nudging preference awaiting a yes/no; null when nothing is pending.
  let pendingMemory: string | null = null;
  // A verbal "no" turns off offers for the rest of the session.
  let declined = false;

  return {
    async send(message) {
      const focus = message.trim();

      // Responding to a pending memory offer (takes precedence over a focus offer).
      if (pendingMemory) {
        if (MOCK_AFFIRM.test(focus)) {
          addMemory(pendingMemory);
          events.onAssistant(
            `Got it — I'll keep that in mind from now on: ${pendingMemory}`,
          );
          pendingMemory = null;
          events.onTurnDone?.();
          return;
        }
        if (MOCK_DECLINE.test(focus)) {
          pendingMemory = null;
          events.onAssistant("Okay — I won't save that.");
          events.onTurnDone?.();
          return;
        }
        // Anything else: the offer lapses and this is a fresh turn.
        pendingMemory = null;
      }

      // A voiced preference about how Ruby nudges → offer to remember it. Checked
      // before the goal/checklist path so a behaviour preference doesn't get
      // mistaken for a call focus.
      if (MOCK_NUDGE_PREF.test(focus)) {
        pendingMemory = focus;
        events.onAssistant(`Want me to remember that for future calls — "${focus}"?`);
        events.onTurnDone?.();
        return;
      }

      // Responding to a pending offer.
      if (pendingFocus) {
        if (MOCK_AFFIRM.test(focus)) {
          upsertGoal(components, `Goal: ${pendingFocus}`);
          upsertChecklist(components, "Cover", [
            `Cover ${pendingFocus}`,
            "Agree next steps",
          ]);
          events.onComponents(components.map((c) => ({ ...c })));
          events.onAssistant(`Pinned the goal and checklist for: ${pendingFocus}`);
          pendingFocus = null;
          events.onTurnDone?.();
          return;
        }
        if (MOCK_DECLINE.test(focus)) {
          pendingFocus = null;
          declined = true;
          events.onAssistant("No problem — leaving the goal and checklist out.");
          events.onTurnDone?.();
          return;
        }
        // Anything else: treat as a new substantive turn; the offer lapses.
        pendingFocus = null;
      }

      direction = direction ? `${direction}\nFocus: ${focus}` : `Focus: ${focus}`;
      events.onDirection(direction);

      // Low-value or already-declined: update the direction, offer nothing.
      if (declined || MOCK_LOW_VALUE.test(focus)) {
        events.onAssistant(`Updated the working direction to focus on: ${focus}`);
        events.onTurnDone?.();
        return;
      }

      // Otherwise: offer the goal + checklist (no components until confirmed).
      pendingFocus = focus;
      events.onAssistant(
        `Updated the working direction to focus on: ${focus}. Want me to pin a goal and a checklist for this?`,
      );
      events.onTurnDone?.();
    },
    async open() {
      // The opening turn: reflect the seed brief and ask the flesh-out-or-go fork.
      // Deterministic. No direction fold, no component offer (that's send()). When
      // resuming a prep that already has components, acknowledge them instead.
      const brief = direction.trim();
      if (components.length > 0) {
        const kinds = components.map((c) => (c.type === "goal" ? "goal" : "checklist")).join(" + ");
        events.onAssistant(
          `Your prep is still here${brief ? ` for "${brief}"` : ""} — ${kinds} pinned. Want to tweak anything, or hit Start when you're ready?`,
        );
      } else {
        events.onAssistant(
          `Here's what I've got${brief ? `: "${brief}"` : ""}. Want to flesh this out, or hit Start when you're ready?`,
        );
      }
      events.onTurnDone?.();
    },
    async close() {
      /* nothing to tear down */
    },
  };
}
