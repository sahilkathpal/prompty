// Stage 4 — Prep session.
//
// Wraps a claude-agent-sdk `query()` stream that drives the pre-call setup
// interview. The model can call MCP tools to write goal/checklist state.
// The renderer drives the conversation via sendMessage() and observes via
// events (state-changed, assistant-chunk, error).

import { z } from "zod";
import type { ChecklistItem } from "./types";
import type { CalendarEvent } from "./calendar-arm";
import { buildPrepSystemPrompt } from "./prompts/prep-system";
import { resolveClaudeCli } from "./claude-cli";
import { EventEmitter } from "node:events";
import { PREP_MODES, isPrepMode } from "../shared/types";

type ClaudeAgentSdk = typeof import("@anthropic-ai/claude-agent-sdk");
let sdkPromise: Promise<ClaudeAgentSdk> | null = null;
function loadSdk(): Promise<ClaudeAgentSdk> {
  if (!sdkPromise) {
    sdkPromise = (new Function("m", "return import(m)") as (
      m: string,
    ) => Promise<ClaudeAgentSdk>)("@anthropic-ai/claude-agent-sdk");
  }
  return sdkPromise;
}

export type PrepMessageRole = "user" | "assistant" | "tool";

/**
 * Compact, authoritative snapshot of the rail, injected ahead of the user's
 * next message so the model stays in sync with manual edits (never shown as a
 * chat bubble). Exported as a pure function for deterministic testing.
 */
export function buildPrepStatePreamble(
  goal: string,
  checklist: ChecklistItem[],
  mode: string,
): string {
  const items = checklist.map((c) => `- ${c.text}`);
  return [
    "[current-state] The user may have directly edited the rail since your last turn. This is the authoritative current state — treat it as ground truth and do not contradict, re-ask, or re-add anything below. Do not mention or quote this block.",
    `goal: ${goal || "(not set yet)"}`,
    `mode: ${mode || "(not set yet)"}`,
    "checklist:",
    items.length ? items.join("\n") : "(none yet)",
    "[/current-state]",
  ].join("\n");
}

export interface PrepMessage {
  id: string;
  role: PrepMessageRole;
  text: string;
  createdAt: number;
  /** True while assistant text is still streaming. */
  streaming?: boolean;
  /** For tool messages: the tool name. */
  toolName?: string;
}

export interface PrepState {
  goal: string;
  checklist: ChecklistItem[];
  mode: string;
  messages: PrepMessage[];
  event: CalendarEvent | null;
  assistantBusy: boolean;
}

export interface PrepSessionHandle {
  sendMessage(text: string): Promise<void>;
  /** Hidden bootstrap turn so the assistant greets the user without a visible "from me" message. */
  kick(): Promise<void>;
  /** UI-side override for the selected mode (chip-row clicks). */
  setMode(mode: string): void;
  /**
   * UI-side direct edits to the rail. These are SILENT — they mutate state and
   * push a `You …` trace message, but never trigger a model turn. The current
   * goal/checklist/mode is re-injected into the model on the next sendMessage so
   * it stays in sync with manual edits.
   */
  setGoal(text: string): void;
  addChecklistItem(text: string): ChecklistItem;
  editChecklistItem(id: string, text: string): void;
  removeChecklistItem(id: string): void;
  getState(): PrepState;
  /** Returns the snapshot used for pending-prep persistence. */
  snapshot(): {
    goal: string;
    checklist: ChecklistItem[];
    mode: string;
    event: CalendarEvent | null;
  };
  discard(): Promise<void>;
  close(): Promise<void>;
  on(
    event: "state-changed",
    fn: (state: PrepState) => void,
  ): () => void;
  on(
    event: "assistant-chunk",
    fn: (chunk: { delta: string; messageId: string }) => void,
  ): () => void;
  on(event: "error", fn: (e: Error) => void): () => void;
}

export interface PrepSessionFactory {
  (event: CalendarEvent | null): Promise<PrepSessionHandle>;
}

export interface PrepSeed {
  goal?: string;
  checklist?: ChecklistItem[];
  mode?: string;
  messages?: PrepMessage[];
}

// ---- Mock factory (for E2E + smoke without claude quota) ---------------------

function createMockPrepSession(
  event: CalendarEvent | null,
  seed?: PrepSeed,
): PrepSessionHandle {
  const emitter = new EventEmitter();
  const state: PrepState = {
    goal: seed?.goal ?? "",
    checklist: seed?.checklist ? [...seed.checklist] : [],
    mode: seed?.mode ?? "",
    messages: seed?.messages ? [...seed.messages] : [],
    event,
    assistantBusy: false,
  };
  let userTurns = state.messages.filter((m) => m.role === "user").length;
  let nextId = 1;
  const mkId = () => `m_${Date.now()}_${nextId++}`;

  const emitState = () => emitter.emit("state-changed", { ...state });

  const pushAssistant = async (text: string) => {
    state.assistantBusy = true;
    emitState();
    const id = mkId();
    const msg: PrepMessage = {
      id,
      role: "assistant",
      text: "",
      createdAt: Date.now(),
      streaming: true,
    };
    state.messages.push(msg);
    emitState();
    // Simulate streaming.
    const chunks = text.match(/.{1,12}/gs) ?? [text];
    for (const c of chunks) {
      msg.text += c;
      emitter.emit("assistant-chunk", { delta: c, messageId: id });
      await new Promise((r) => setTimeout(r, 8));
    }
    msg.streaming = false;
    state.assistantBusy = false;
    emitState();
  };

  const pushTool = (name: string, summary: string) => {
    state.messages.push({
      id: mkId(),
      role: "tool",
      text: summary,
      createdAt: Date.now(),
      toolName: name,
    });
  };

  // Opening greeting on first sendMessage.
  const SYNTHETIC_KICK_PREFIX = "Let's get started";
  const handle: PrepSessionHandle = {
    async sendMessage(text: string) {
      const isSyntheticKick =
        userTurns === 0 && text.startsWith(SYNTHETIC_KICK_PREFIX);
      // Don't add the synthetic kick to the visible thread — it's a system
      // prompt to make the assistant greet the user.
      if (!isSyntheticKick) {
        userTurns++;
        state.messages.push({
          id: mkId(),
          role: "user",
          text,
          createdAt: Date.now(),
        });
        emitState();
      }
      if (isSyntheticKick) {
        await pushAssistant(
          event
            ? `Hey — let's prep for ${event.title}. What's the one outcome that would make this call a win?`
            : `Hey — let's prep this call. What's the one outcome that would make it a win?`,
        );
        return;
      }
      if (userTurns === 1) {
        await pushAssistant(
          event
            ? `Got it — prepping for ${event.title}. What's the one outcome that would make it a win?`
            : `Got it. What's this call about, and what's the one outcome that would make it a win?`,
        );
      } else if (userTurns === 2) {
        const goal = `Mock goal derived from: "${text.slice(0, 60)}"`;
        state.goal = goal;
        pushTool("set_goal", `Set goal: ${goal}`);
        state.mode = "default";
        pushTool("set_mode", "Set mode: default");
        const items = [
          "Ask about current scale and team size",
          "Verify budget authority and timeline",
          "Surface top three pain points",
        ];
        for (const t of items) {
          const id = `c_${Date.now()}_${state.checklist.length + 1}`;
          state.checklist.push({ id, text: t, status: "open" });
          pushTool("add_checklist_item", `Added: ${t}`);
        }
        await pushAssistant(
          `Locking in: ${goal}. I drafted 3 checklist items in the right rail. You're prepped. Hit 'Save & run the call' when ready.`,
        );
      } else {
        await pushAssistant(`Acknowledged. Anything else to add?`);
      }
    },
    async kick() {
      await pushAssistant(
        event
          ? `Hey — let's prep for ${event.title}. What's the one outcome that would make this call a win?`
          : `Hey — let's prep this call. What's the one outcome that would make it a win?`,
      );
    },
    setMode(mode: string) {
      if (!isPrepMode(mode)) {
        throw new Error(`invalid mode: ${mode}`);
      }
      state.mode = mode;
      pushTool("set_mode", `Set mode: ${mode}`);
      emitState();
    },
    setGoal(text: string) {
      const v = text.trim();
      if (!v) throw new Error("goal cannot be empty");
      state.goal = v;
      pushTool("set_goal", `You set goal: ${v}`);
      emitState();
    },
    addChecklistItem(text: string) {
      const v = text.trim();
      if (!v) throw new Error("checklist item cannot be empty");
      const id = `c_${Date.now()}_${state.checklist.length + 1}`;
      const item: ChecklistItem = { id, text: v, status: "open" };
      state.checklist.push(item);
      pushTool("add_checklist_item", `You added: ${v}`);
      emitState();
      return item;
    },
    editChecklistItem(id: string, text: string) {
      const v = text.trim();
      if (!v) throw new Error("checklist item cannot be empty");
      const item = state.checklist.find((c) => c.id === id);
      if (!item) throw new Error("not_found");
      item.text = v;
      pushTool("update_checklist_item", `You edited: ${v}`);
      emitState();
    },
    removeChecklistItem(id: string) {
      const idx = state.checklist.findIndex((c) => c.id === id);
      if (idx < 0) throw new Error("not_found");
      const [removed] = state.checklist.splice(idx, 1);
      pushTool("remove_checklist_item", `You removed: ${removed?.text ?? id}`);
      emitState();
    },
    getState() {
      return { ...state, messages: [...state.messages], checklist: [...state.checklist] };
    },
    snapshot() {
      return { goal: state.goal, checklist: [...state.checklist], mode: state.mode, event };
    },
    async discard() {
      state.goal = "";
      state.checklist = [];
      state.mode = "";
      state.messages = [];
      emitState();
    },
    async close() {
      emitter.removeAllListeners();
    },
    on(name: string, fn: (...args: unknown[]) => void) {
      emitter.on(name, fn);
      return () => emitter.off(name, fn);
    },
  } as PrepSessionHandle;

  return handle;
}

// ---- Real factory ------------------------------------------------------------

async function createRealPrepSession(
  event: CalendarEvent | null,
  seed?: PrepSeed,
): Promise<PrepSessionHandle> {
  const { query, tool, createSdkMcpServer } = await loadSdk();
  const emitter = new EventEmitter();
  const state: PrepState = {
    goal: seed?.goal ?? "",
    checklist: seed?.checklist ? [...seed.checklist] : [],
    mode: seed?.mode ?? "",
    messages: seed?.messages ? [...seed.messages] : [],
    event,
    assistantBusy: false,
  };

  let nextId = 1;
  const mkId = () => `m_${Date.now()}_${nextId++}`;
  const emitState = () =>
    emitter.emit("state-changed", {
      ...state,
      messages: [...state.messages],
      checklist: [...state.checklist],
    });

  // Set true whenever the user edits the rail directly (or when seeding a
  // resumed session). Consumed once by the next sendMessage, which prepends an
  // authoritative current-state block to the model's turn so it never re-asks
  // for something already set or re-adds an item the user removed.
  let railDirty = Boolean(
    seed?.goal || (seed?.checklist?.length ?? 0) > 0 || seed?.mode,
  );

  const pushTrace = (toolName: string, text: string) => {
    state.messages.push({
      id: mkId(),
      role: "tool",
      text,
      createdAt: Date.now(),
      toolName,
    });
  };

  const buildStatePreamble = (): string =>
    buildPrepStatePreamble(state.goal, state.checklist, state.mode);

  const checklistMcp = createSdkMcpServer({
    name: "prompty-prep",
    version: "0.1.0",
    tools: [
      tool(
        "set_goal",
        "Set or replace the call's goal. Use after the user has given a concrete answer.",
        { text: z.string().min(1).max(400) },
        async (args) => {
          state.goal = args.text;
          state.messages.push({
            id: mkId(),
            role: "tool",
            text: `Set goal: ${args.text}`,
            createdAt: Date.now(),
            toolName: "set_goal",
          });
          emitState();
          return { content: [{ type: "text", text: "goal_set" }] };
        },
      ),
      tool(
        "add_checklist_item",
        "Append a new checklist item. Item text must be a SHORT topic label (2-6 words) the user can glance at — a track to mine or verify — not a full sentence or scripted question. e.g. \"Current Snowflake spend\".",
        { text: z.string().min(1).max(80) },
        async (args) => {
          const id = `c_${Date.now()}_${state.checklist.length + 1}`;
          state.checklist.push({ id, text: args.text, status: "open" });
          state.messages.push({
            id: mkId(),
            role: "tool",
            text: `Added: ${args.text}`,
            createdAt: Date.now(),
            toolName: "add_checklist_item",
          });
          emitState();
          return { content: [{ type: "text", text: id }] };
        },
      ),
      tool(
        "update_checklist_item",
        "Edit an existing checklist item by id. Keep it a SHORT topic label (2-6 words), not a sentence.",
        { id: z.string(), text: z.string().min(1).max(80) },
        async (args) => {
          const item = state.checklist.find((c) => c.id === args.id);
          if (!item) {
            return {
              content: [{ type: "text", text: "not_found" }],
            };
          }
          item.text = args.text;
          state.messages.push({
            id: mkId(),
            role: "tool",
            text: `Updated ${args.id}: ${args.text}`,
            createdAt: Date.now(),
            toolName: "update_checklist_item",
          });
          emitState();
          return { content: [{ type: "text", text: "updated" }] };
        },
      ),
      tool(
        "remove_checklist_item",
        "Delete a checklist item by id.",
        { id: z.string() },
        async (args) => {
          const idx = state.checklist.findIndex((c) => c.id === args.id);
          if (idx < 0) {
            return { content: [{ type: "text", text: "not_found" }] };
          }
          const [removed] = state.checklist.splice(idx, 1);
          state.messages.push({
            id: mkId(),
            role: "tool",
            text: `Removed: ${removed?.text ?? args.id}`,
            createdAt: Date.now(),
            toolName: "remove_checklist_item",
          });
          emitState();
          return { content: [{ type: "text", text: "removed" }] };
        },
      ),
      tool(
        "set_mode",
        "Set the coaching mode for this call. Must be one of: default, discovery, user-interview, hiring.",
        { mode: z.enum(PREP_MODES) },
        async (args) => {
          state.mode = args.mode;
          state.messages.push({
            id: mkId(),
            role: "tool",
            text: `Set mode: ${args.mode}`,
            createdAt: Date.now(),
            toolName: "set_mode",
          });
          emitState();
          return { content: [{ type: "text", text: "mode_set" }] };
        },
      ),
    ],
  });

  // Input stream pump.
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
      systemPrompt: buildPrepSystemPrompt(event),
      pathToClaudeCodeExecutable: resolveClaudeCli(),
      mcpServers: { "prompty-prep": checklistMcp },
      allowedTools: [
        "mcp__prompty-prep__set_goal",
        "mcp__prompty-prep__add_checklist_item",
        "mcp__prompty-prep__update_checklist_item",
        "mcp__prompty-prep__remove_checklist_item",
        "mcp__prompty-prep__set_mode",
      ],
      maxTurns: 50,
      permissionMode: "bypassPermissions",
    },
  });

  // Track the current assistant message we're streaming into.
  let currentAssistantId: string | null = null;

  (async () => {
    try {
      for await (const msg of q) {
        const m = msg as unknown as {
          type: string;
          subtype?: string;
          message?: {
            role?: string;
            content?: unknown;
          };
        };
        if (m.type === "assistant" && m.message?.content) {
          const content = m.message.content as Array<{
            type?: string;
            text?: string;
          }>;
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string") {
              if (!currentAssistantId) {
                currentAssistantId = mkId();
                state.assistantBusy = true;
                state.messages.push({
                  id: currentAssistantId,
                  role: "assistant",
                  text: "",
                  createdAt: Date.now(),
                  streaming: true,
                });
                emitState();
              }
              const target = state.messages.find(
                (x) => x.id === currentAssistantId,
              );
              if (target) {
                target.text += block.text;
                emitter.emit("assistant-chunk", {
                  delta: block.text,
                  messageId: currentAssistantId,
                });
              }
              emitState();
            }
          }
        }
        if (m.type === "result") {
          if (currentAssistantId) {
            const target = state.messages.find(
              (x) => x.id === currentAssistantId,
            );
            if (target) target.streaming = false;
            currentAssistantId = null;
          }
          state.assistantBusy = false;
          emitState();
          if (m.subtype && m.subtype !== "success") {
            emitter.emit("error", new Error(`prep agent error: ${m.subtype}`));
          }
          turnDoneWaiters.shift()?.();
        }
      }
      while (turnDoneWaiters.length) turnDoneWaiters.shift()!();
    } catch (e) {
      emitter.emit("error", e as Error);
      while (turnDoneWaiters.length) turnDoneWaiters.shift()!();
    }
  })();

  return {
    async sendMessage(text: string) {
      // Visible bubble = the user's real text only (never the preamble).
      state.messages.push({
        id: mkId(),
        role: "user",
        text,
        createdAt: Date.now(),
      });
      emitState();
      // Pump content MAY differ from the visible bubble: if the user edited the
      // rail since the last turn (or this is the first turn after a resume),
      // prepend the authoritative current-state block. Consumed once.
      const pumpContent = railDirty
        ? `${buildStatePreamble()}\n\n${text}`
        : text;
      railDirty = false;
      const turnDone = new Promise<void>((r) => turnDoneWaiters.push(r));
      pushUserMessage?.(pumpContent);
      await turnDone;
    },
    async kick() {
      // Feed a synthetic "begin" turn to the SDK without adding a user message
      // to the visible thread. The system prompt instructs the assistant to
      // open with the right question.
      const turnDone = new Promise<void>((r) => turnDoneWaiters.push(r));
      pushUserMessage?.(
        "[system] The prep session just opened. Open the conversation now per your opening-turn instructions. Do not reference this message.",
      );
      await turnDone;
    },
    setMode(mode: string) {
      if (!isPrepMode(mode)) {
        throw new Error(`invalid mode: ${mode}`);
      }
      state.mode = mode;
      pushTrace("set_mode", `Set mode: ${mode}`);
      railDirty = true;
      emitState();
    },
    setGoal(text: string) {
      const v = text.trim();
      if (!v) throw new Error("goal cannot be empty");
      state.goal = v;
      pushTrace("set_goal", `You set goal: ${v}`);
      railDirty = true;
      emitState();
    },
    addChecklistItem(text: string) {
      const v = text.trim();
      if (!v) throw new Error("checklist item cannot be empty");
      const id = `c_${Date.now()}_${state.checklist.length + 1}`;
      const item: ChecklistItem = { id, text: v, status: "open" };
      state.checklist.push(item);
      pushTrace("add_checklist_item", `You added: ${v}`);
      railDirty = true;
      emitState();
      return item;
    },
    editChecklistItem(id: string, text: string) {
      const v = text.trim();
      if (!v) throw new Error("checklist item cannot be empty");
      const item = state.checklist.find((c) => c.id === id);
      if (!item) throw new Error("not_found");
      item.text = v;
      pushTrace("update_checklist_item", `You edited: ${v}`);
      railDirty = true;
      emitState();
    },
    removeChecklistItem(id: string) {
      const idx = state.checklist.findIndex((c) => c.id === id);
      if (idx < 0) throw new Error("not_found");
      const [removed] = state.checklist.splice(idx, 1);
      pushTrace("remove_checklist_item", `You removed: ${removed?.text ?? id}`);
      railDirty = true;
      emitState();
    },
    getState() {
      return {
        ...state,
        messages: [...state.messages],
        checklist: [...state.checklist],
      };
    },
    snapshot() {
      return {
        goal: state.goal,
        checklist: [...state.checklist],
        mode: state.mode,
        event,
      };
    },
    async discard() {
      state.goal = "";
      state.checklist = [];
      state.mode = "";
      state.messages = [];
      emitState();
    },
    async close() {
      closeInput?.();
      emitter.removeAllListeners();
    },
    on(name: string, fn: (...args: unknown[]) => void) {
      emitter.on(name, fn);
      return () => emitter.off(name, fn);
    },
  } as PrepSessionHandle;
}

export async function openPrepSession(
  event: CalendarEvent | null,
  seed?: PrepSeed,
): Promise<PrepSessionHandle> {
  if (process.env.PROMPTY_MOCK_PREP === "1") {
    return createMockPrepSession(event, seed);
  }
  // v1 tradeoff: when seeding, we rebuild the SDK session fresh (model has no
  // memory of the prior turns) but populate the visible thread + goal/checklist
  // so the user sees their previous conversation. Wiring the SDK's input
  // stream to replay the full history is non-trivial; this gives the right UX
  // for the resume case (user sees what they discussed; if they keep talking,
  // the model picks up from the current goal/checklist state).
  return createRealPrepSession(event, seed);
}
