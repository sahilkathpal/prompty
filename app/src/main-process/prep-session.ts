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
import { agentCwd, resolveClaudeCli } from "./claude-cli";
import { EventEmitter } from "node:events";
import { listAvailableSkills } from "./prompts/loader";
import { openDebugLog, debugFullPrompt, type DebugLog } from "./debug-logger";

/**
 * A valid skill is the empty string (no skill — the resting state) or the name
 * of a folder under the bundled/user skills dir. Validated by registry, not a
 * frozen enum, so a new skill folder works without a code change.
 */
function isValidSkill(s: string): boolean {
  if (s === "") return true;
  return listAvailableSkills().some((sk) => sk.name === s);
}

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
  direction: string,
  checklist: ChecklistItem[],
  skill: string,
  notes?: string,
): string {
  const items = checklist.map((c) => `- ${c.text}`);
  return [
    "[current-state] The user may have directly edited the rail since your last turn. This is the authoritative current state — treat it as ground truth and do not contradict, re-ask, or re-add anything below. Do not mention or quote this block.",
    `goal: ${goal || "(not set yet)"}`,
    `direction: ${direction || "(not set yet)"}`,
    `skill: ${skill || "(none)"}`,
    "checklist:",
    items.length ? items.join("\n") : "(none yet)",
    `notes: ${notes?.trim() || "(none)"}`,
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
  direction: string;
  checklist: ChecklistItem[];
  notes: string;
  skill: string;
  messages: PrepMessage[];
  event: CalendarEvent | null;
  assistantBusy: boolean;
}

export interface PrepSessionHandle {
  sendMessage(text: string): Promise<void>;
  /** Hidden bootstrap turn so the assistant greets the user without a visible "from me" message. */
  kick(): Promise<void>;
  /** UI-side override for the selected skill (chip-row clicks; "" clears it). */
  setSkill(skill: string): void;
  /**
   * UI-side direct edits to the rail. These are SILENT — they mutate state and
   * push a `You …` trace message, but never trigger a model turn. The current
   * goal/checklist/skill is re-injected into the model on the next sendMessage so
   * it stays in sync with manual edits.
   */
  setGoal(text: string): void;
  setDirection(text: string): void;
  setNotes(text: string): void;
  addChecklistItem(text: string): ChecklistItem;
  editChecklistItem(id: string, text: string): void;
  removeChecklistItem(id: string): void;
  getState(): PrepState;
  /** Returns the snapshot used for pending-prep persistence. */
  snapshot(): {
    goal: string;
    direction: string;
    checklist: ChecklistItem[];
    notes: string;
    skill: string;
    event: CalendarEvent | null;
  };
  discard(): Promise<void>;
  close(): Promise<void>;
  /** Toggle verbose debug capture mid-session (the `debugMode` setting). */
  setDebug(enabled: boolean): void;
  /** Record a prep-save debug event (snapshot + whether it chained to a call). */
  noteSave(chainedToCall: boolean): void;
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
  direction?: string;
  checklist?: ChecklistItem[];
  notes?: string;
  skill?: string;
  messages?: PrepMessage[];
}

// ---- Debug recorder (opt-in `debugMode`) -------------------------------------
//
// Shared by both factories so the prep debug event shapes live in one place.
// Writes prep-*.jsonl events; null/no-op unless debug is on. `snapshotState`
// is supplied by each factory (its `state` is local) so prep-state-change /
// prep-save carry the live rail snapshot.

export interface PrepAgentTurnDebug {
  context: string;
  systemPrompt?: string;
  assistantText: string;
  toolCalls: { name: string; args: unknown }[];
  latencyMs: number;
}

function makePrepDebug(
  event: CalendarEvent | null,
  seed: PrepSeed | undefined,
  enabled: boolean,
  snapshotState: () => Record<string, unknown>,
) {
  const startedAt = Date.now();
  let log: DebugLog | null = null;
  const seeded = Boolean(
    seed &&
      (seed.goal ||
        seed.direction ||
        (seed.checklist?.length ?? 0) > 0 ||
        seed.notes ||
        seed.skill ||
        (seed.messages?.length ?? 0) > 0),
  );
  const open = () => {
    if (log) return;
    log = openDebugLog("prep", startedAt);
    log?.write("prep-start", {
      systemPrompt: buildPrepSystemPrompt(event, seed?.skill),
      event: event ? { id: event.id, title: event.title } : null,
      seededFromPending: seeded,
    });
  };
  if (enabled) open();
  return {
    userTurn: (text: string, preamble?: string) =>
      log?.write("prep-user-turn", { text, preamble }),
    agentTurn: (d: PrepAgentTurnDebug) => log?.write("prep-agent-turn", { ...d }),
    stateChange: (source: "tool" | "rail") =>
      log?.write("prep-state-change", { state: snapshotState(), source }),
    save: (chainedToCall: boolean) =>
      log?.write("prep-save", { snapshot: snapshotState(), chainedToCall }),
    discard: () => log?.write("prep-discard", {}),
    error: (where: string, e: Error) =>
      log?.write("prep-error", { where, message: e.message, stack: e.stack }),
    setDebug: (on: boolean) => {
      if (on) open();
      else {
        log?.close();
        log = null;
      }
    },
    close: () => {
      log?.close();
      log = null;
    },
  };
}

type PrepDebug = ReturnType<typeof makePrepDebug>;

// ---- Mock factory (for E2E + smoke without claude quota) ---------------------

function createMockPrepSession(
  event: CalendarEvent | null,
  seed?: PrepSeed,
  debug = false,
): PrepSessionHandle {
  const emitter = new EventEmitter();
  const state: PrepState = {
    goal: seed?.goal ?? "",
    direction: seed?.direction ?? "",
    checklist: seed?.checklist ? [...seed.checklist] : [],
    notes: seed?.notes ?? "",
    skill: seed?.skill ?? "",
    messages: seed?.messages ? [...seed.messages] : [],
    event,
    assistantBusy: false,
  };
  const dbg: PrepDebug = makePrepDebug(event, seed, debug, () => ({
    goal: state.goal,
    direction: state.direction,
    checklist: [...state.checklist],
    notes: state.notes,
    skill: state.skill,
  }));
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
    dbg.agentTurn({ context: "(mock)", assistantText: text, toolCalls: [], latencyMs: 0 });
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
        dbg.userTurn(text);
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
        const direction = `Mock direction: explore ${text
          .slice(0, 40)
          .trim()} broadly, stay curious, and steer toward the goal without forcing topics.`;
        state.direction = direction;
        pushTool("set_direction", `Set direction: ${direction}`);
        dbg.stateChange("tool");
        await pushAssistant(
          `Locking in: ${goal}. Here's the direction I'll coach to: ${direction} You're prepped. Hit 'Save & run the call' when ready.`,
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
    setSkill(skill: string) {
      if (!isValidSkill(skill)) {
        throw new Error(`invalid skill: ${skill}`);
      }
      state.skill = skill;
      pushTool("set_skill", skill ? `Set skill: ${skill}` : `Cleared skill`);
      emitState();
      dbg.stateChange("rail");
    },
    setGoal(text: string) {
      const v = text.trim();
      if (!v) throw new Error("goal cannot be empty");
      state.goal = v;
      pushTool("set_goal", `You set goal: ${v}`);
      emitState();
      dbg.stateChange("rail");
    },
    setDirection(text: string) {
      const v = text.trim();
      if (!v) throw new Error("direction cannot be empty");
      state.direction = v;
      pushTool("set_direction", `You set direction: ${v}`);
      emitState();
      dbg.stateChange("rail");
    },
    setNotes(text: string) {
      state.notes = text;
      pushTool("set_notes", text.trim() ? `You set notes` : `You cleared notes`);
      emitState();
      dbg.stateChange("rail");
    },
    addChecklistItem(text: string) {
      const v = text.trim();
      if (!v) throw new Error("checklist item cannot be empty");
      const id = `c_${Date.now()}_${state.checklist.length + 1}`;
      const item: ChecklistItem = { id, text: v, status: "open" };
      state.checklist.push(item);
      pushTool("add_checklist_item", `You added: ${v}`);
      emitState();
      dbg.stateChange("rail");
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
      dbg.stateChange("rail");
    },
    removeChecklistItem(id: string) {
      const idx = state.checklist.findIndex((c) => c.id === id);
      if (idx < 0) throw new Error("not_found");
      const [removed] = state.checklist.splice(idx, 1);
      pushTool("remove_checklist_item", `You removed: ${removed?.text ?? id}`);
      emitState();
      dbg.stateChange("rail");
    },
    getState() {
      return { ...state, messages: [...state.messages], checklist: [...state.checklist] };
    },
    snapshot() {
      return {
        goal: state.goal,
        direction: state.direction,
        checklist: [...state.checklist],
        notes: state.notes,
        skill: state.skill,
        event,
      };
    },
    async discard() {
      state.goal = "";
      state.direction = "";
      state.checklist = [];
      state.notes = "";
      state.skill = "";
      state.messages = [];
      dbg.discard();
      emitState();
    },
    setDebug(enabled: boolean) {
      dbg.setDebug(enabled);
    },
    noteSave(chainedToCall: boolean) {
      dbg.save(chainedToCall);
    },
    async close() {
      dbg.close();
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
  debug = false,
): Promise<PrepSessionHandle> {
  const { query, tool, createSdkMcpServer } = await loadSdk();
  const emitter = new EventEmitter();
  const state: PrepState = {
    goal: seed?.goal ?? "",
    direction: seed?.direction ?? "",
    checklist: seed?.checklist ? [...seed.checklist] : [],
    notes: seed?.notes ?? "",
    skill: seed?.skill ?? "",
    messages: seed?.messages ? [...seed.messages] : [],
    event,
    assistantBusy: false,
  };
  const dbg: PrepDebug = makePrepDebug(event, seed, debug, () => ({
    goal: state.goal,
    direction: state.direction,
    checklist: [...state.checklist],
    notes: state.notes,
    skill: state.skill,
  }));
  // Per-turn debug accumulator (set in sendMessage/kick, flushed on result).
  type PrepDbgTurn = {
    context: string;
    systemPrompt?: string;
    assistantText: string;
    toolCalls: { name: string; args: unknown }[];
    t0: number;
  };
  let prepDbgTurn: PrepDbgTurn | null = null;

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
    seed?.goal ||
      seed?.direction ||
      (seed?.checklist?.length ?? 0) > 0 ||
      seed?.skill ||
      seed?.notes,
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
    buildPrepStatePreamble(
      state.goal,
      state.direction,
      state.checklist,
      state.skill,
      state.notes,
    );

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
          prepDbgTurn?.toolCalls.push({ name: "set_goal", args });
          emitState();
          dbg.stateChange("tool");
          return { content: [{ type: "text", text: "goal_set" }] };
        },
      ),
      tool(
        "set_direction",
        "Set or replace the call's direction — a 40-60 word PROSE paragraph describing what a good call looks like (what to explore + the stance/approach to carry). This is the PRIMARY fuel for in-call nudges, so make it concrete and directional. Synthesize and commit it after a few interview turns.",
        { text: z.string().min(1).max(800) },
        async (args) => {
          state.direction = args.text;
          state.messages.push({
            id: mkId(),
            role: "tool",
            text: `Set direction: ${args.text}`,
            createdAt: Date.now(),
            toolName: "set_direction",
          });
          prepDbgTurn?.toolCalls.push({ name: "set_direction", args });
          emitState();
          dbg.stateChange("tool");
          return { content: [{ type: "text", text: "direction_set" }] };
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
          prepDbgTurn?.toolCalls.push({ name: "add_checklist_item", args });
          emitState();
          dbg.stateChange("tool");
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
          prepDbgTurn?.toolCalls.push({ name: "update_checklist_item", args });
          emitState();
          dbg.stateChange("tool");
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
          prepDbgTurn?.toolCalls.push({ name: "remove_checklist_item", args });
          emitState();
          dbg.stateChange("tool");
          return { content: [{ type: "text", text: "removed" }] };
        },
      ),
      tool(
        "set_skill",
        "Add an OPTIONAL coaching skill (playbook) for this call, layered on top of the direction. Pass one of the available skill names (e.g. discovery, user-interview, hiring), or an empty string to clear it. Only call this when the call clearly fits a skill; no skill is the normal default.",
        { skill: z.string().max(60) },
        async (args) => {
          const skill = args.skill.trim();
          if (!isValidSkill(skill)) {
            return { content: [{ type: "text", text: "invalid_skill" }] };
          }
          state.skill = skill;
          state.messages.push({
            id: mkId(),
            role: "tool",
            text: skill ? `Set skill: ${skill}` : `Cleared skill`,
            createdAt: Date.now(),
            toolName: "set_skill",
          });
          prepDbgTurn?.toolCalls.push({ name: "set_skill", args });
          emitState();
          dbg.stateChange("tool");
          return { content: [{ type: "text", text: "skill_set" }] };
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
      // Skill is fixed for the SDK session: seed it at open. A mid-session skill
      // chip won't rebuild this prompt (same seed-rebuild tradeoff as resume),
      // but the in-call prompt is where the skill truly bakes in.
      systemPrompt: buildPrepSystemPrompt(event, seed?.skill),
      pathToClaudeCodeExecutable: resolveClaudeCli(),
      // Keep the CLI's workspace scan out of the user's protected folders.
      cwd: agentCwd(),
      mcpServers: { "prompty-prep": checklistMcp },
      allowedTools: [
        "mcp__prompty-prep__set_goal",
        "mcp__prompty-prep__set_direction",
        "mcp__prompty-prep__add_checklist_item",
        "mcp__prompty-prep__update_checklist_item",
        "mcp__prompty-prep__remove_checklist_item",
        "mcp__prompty-prep__set_skill",
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
              // Cast: this IIFE both reads and (below) clears prepDbgTurn, so
              // TS won't widen it back from the capture-time type on its own.
              const acc = prepDbgTurn as PrepDbgTurn | null;
              if (acc) acc.assistantText += block.text;
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
          const dt = prepDbgTurn as PrepDbgTurn | null;
          if (dt) {
            dbg.agentTurn({
              context: dt.context,
              systemPrompt: dt.systemPrompt,
              assistantText: dt.assistantText,
              toolCalls: dt.toolCalls,
              latencyMs: Date.now() - dt.t0,
            });
          }
          prepDbgTurn = null;
          if (m.subtype && m.subtype !== "success") {
            const err = new Error(`prep agent error: ${m.subtype}`);
            dbg.error("agent", err);
            emitter.emit("error", err);
          }
          turnDoneWaiters.shift()?.();
        }
      }
      while (turnDoneWaiters.length) turnDoneWaiters.shift()!();
    } catch (e) {
      dbg.error("stream", e as Error);
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
      const preamble = railDirty ? buildStatePreamble() : undefined;
      const pumpContent = preamble ? `${preamble}\n\n${text}` : text;
      dbg.userTurn(text, preamble);
      prepDbgTurn = {
        context: pumpContent,
        systemPrompt: debugFullPrompt()
          ? buildPrepSystemPrompt(event, seed?.skill)
          : undefined,
        assistantText: "",
        toolCalls: [],
        t0: Date.now(),
      };
      railDirty = false;
      const turnDone = new Promise<void>((r) => turnDoneWaiters.push(r));
      pushUserMessage?.(pumpContent);
      await turnDone;
    },
    async kick() {
      // Feed a synthetic "begin" turn to the SDK without adding a user message
      // to the visible thread. The system prompt instructs the assistant to
      // open with the right question.
      const kickMsg =
        "[system] The prep session just opened. Open the conversation now per your opening-turn instructions. Do not reference this message.";
      prepDbgTurn = {
        context: kickMsg,
        systemPrompt: debugFullPrompt()
          ? buildPrepSystemPrompt(event, seed?.skill)
          : undefined,
        assistantText: "",
        toolCalls: [],
        t0: Date.now(),
      };
      const turnDone = new Promise<void>((r) => turnDoneWaiters.push(r));
      pushUserMessage?.(kickMsg);
      await turnDone;
    },
    setSkill(skill: string) {
      if (!isValidSkill(skill)) {
        throw new Error(`invalid skill: ${skill}`);
      }
      state.skill = skill;
      pushTrace("set_skill", skill ? `Set skill: ${skill}` : `Cleared skill`);
      railDirty = true;
      emitState();
      dbg.stateChange("rail");
    },
    setGoal(text: string) {
      const v = text.trim();
      if (!v) throw new Error("goal cannot be empty");
      state.goal = v;
      pushTrace("set_goal", `You set goal: ${v}`);
      railDirty = true;
      emitState();
      dbg.stateChange("rail");
    },
    setDirection(text: string) {
      const v = text.trim();
      if (!v) throw new Error("direction cannot be empty");
      state.direction = v;
      pushTrace("set_direction", `You set direction: ${v}`);
      railDirty = true;
      emitState();
      dbg.stateChange("rail");
    },
    setNotes(text: string) {
      state.notes = text;
      pushTrace("set_notes", text.trim() ? `You set notes` : `You cleared notes`);
      railDirty = true;
      emitState();
      dbg.stateChange("rail");
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
      dbg.stateChange("rail");
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
      dbg.stateChange("rail");
    },
    removeChecklistItem(id: string) {
      const idx = state.checklist.findIndex((c) => c.id === id);
      if (idx < 0) throw new Error("not_found");
      const [removed] = state.checklist.splice(idx, 1);
      pushTrace("remove_checklist_item", `You removed: ${removed?.text ?? id}`);
      railDirty = true;
      emitState();
      dbg.stateChange("rail");
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
        direction: state.direction,
        checklist: [...state.checklist],
        notes: state.notes,
        skill: state.skill,
        event,
      };
    },
    async discard() {
      state.goal = "";
      state.direction = "";
      state.checklist = [];
      state.notes = "";
      state.skill = "";
      state.messages = [];
      dbg.discard();
      emitState();
    },
    setDebug(enabled: boolean) {
      dbg.setDebug(enabled);
    },
    noteSave(chainedToCall: boolean) {
      dbg.save(chainedToCall);
    },
    async close() {
      dbg.close();
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
  opts?: { debug?: boolean },
): Promise<PrepSessionHandle> {
  if (process.env.PROMPTY_MOCK_PREP === "1") {
    return createMockPrepSession(event, seed, opts?.debug ?? false);
  }
  // v1 tradeoff: when seeding, we rebuild the SDK session fresh (model has no
  // memory of the prior turns) but populate the visible thread + goal/checklist
  // so the user sees their previous conversation. Wiring the SDK's input
  // stream to replay the full history is non-trivial; this gives the right UX
  // for the resume case (user sees what they discussed; if they keep talking,
  // the model picks up from the current goal/checklist state).
  return createRealPrepSession(event, seed, opts?.debug ?? false);
}
