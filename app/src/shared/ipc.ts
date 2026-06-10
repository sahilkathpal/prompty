// Typed IPC contracts between Electron main and renderers.
//
// Channels are split into two flavors:
//   - "invoke" channels: renderer → main, request/response (ipcMain.handle).
//   - "event" channels:  main → renderer, fire-and-forget (webContents.send).
//
// The wrappers in electron/ipc-handlers.ts and electron/preload.ts use these
// types to ensure channel names + payloads stay in sync.

import type {
  Nudge,
  ChecklistItem,
  PanelState,
  AppSettings,
  CallSetup,
  TranscriptUtterance,
  PermissionStatus,
  MacOsVersion,
  MainTab,
  SessionStatusEvent,
} from "./types";

// -- renderer → main (invoke) ------------------------------------------------

export interface InvokeChannels {
  "main:open-tab": {
    request: { tab: MainTab };
    response: void;
  };
  "overlay:open": {
    request: void;
    response: void;
  };
  "overlay:close": {
    request: void;
    response: void;
  };
  "calls:list": {
    request: void;
    response: { files: { name: string; mtimeMs: number }[] };
  };
  "calls:read": {
    request: { name: string };
    response: { content: string };
  };
  "settings:get": {
    request: void;
    response: AppSettings;
  };
  "settings:set": {
    request: Partial<AppSettings>;
    response: AppSettings;
  };
  "call:start": {
    request: void;
    response: { ok: boolean; error?: string };
  };
  "call:end": {
    request: void;
    response: { ok: boolean; error?: string };
  };
  "checklist:toggle": {
    request: { id: string; status: ChecklistItem["status"] };
    response: void;
  };
  // On-demand nudge request from the overlay's "What should I ask?" button.
  "nudge:request": {
    request: { source: "panel" };
    response: { ok: boolean };
  };
  // Renderer asks the overlay window to fit its content height. "grow" only
  // increases height (revealing the sticky-note stack without shrinking a
  // height the user dragged taller); "exact" snaps to the measured height
  // (used when the feed is hidden, to drop the now-unused space). Width is
  // never touched — it stays under manual control.
  "overlay:set-height": {
    request: { height: number; mode: "grow" | "exact" };
    response: { ok: boolean };
  };
  // Last recent pre-flight failure — queried by the main window on mount so a
  // just-opened window (e.g. via the T-0 notification path) doesn't miss the
  // one-shot preflight:failed broadcast.
  "preflight:get": {
    request: void;
    response: { code: "mic" | "auth" | "claude"; message: string } | null;
  };
  "auth:google-sign-in": {
    request: void;
    response: { ok: boolean; error?: string; userId?: string; email?: string };
  };
  "auth:sign-out": {
    request: void;
    response: { ok: boolean };
  };
  "auth:status": {
    request: void;
    response: { signedIn: boolean; userId?: string; email?: string };
  };
  "quit": {
    request: void;
    response: void;
  };
  "debug:inject-utterance": {
    request: { speaker: "me" | "them"; text: string; isFinal?: boolean };
    response: { ok: boolean; error?: string };
  };
  "onboarding:check-claude": {
    request: void;
    response: { found: boolean; path: string | null };
  };
  "onboarding:request-mic": {
    request: void;
    response: { granted: boolean };
  };
  "onboarding:macos-version": {
    request: void;
    response: MacOsVersion;
  };
  "onboarding:permission-status": {
    request: void;
    response: PermissionStatus;
  };
  "onboarding:fire-notification": {
    request: void;
    response: { ok: boolean; error?: string };
  };
  "onboarding:open-external": {
    request: { url: string };
    response: void;
  };
  "onboarding:complete": {
    request: void;
    response: { ok: boolean };
  };
  "calendar:current-arm": {
    request: void;
    response: { event: ArmedEvent | null };
  };
  "calendar:list-upcoming": {
    request: { limit?: number; windowMinutes?: number };
    response: { events: ArmedEvent[] };
  };
  "session:state": {
    request: void;
    response: {
      state: "idle" | "starting" | "live" | "ending" | "ended" | "error";
      setup: CallSetup | null;
      nudges: Nudge[];
      transcript: TranscriptUtterance[];
    };
  };
  "prep:open": {
    request: { eventId?: string };
    response: { ok: boolean; error?: string };
  };
  "prep:send-message": {
    request: { text: string };
    response: { ok: boolean; error?: string };
  };
  "prep:kick": {
    request: void;
    response: { ok: boolean; error?: string };
  };
  "prep:get-state": {
    request: void;
    response: PrepStatePayload | null;
  };
  "prep:save": {
    request: { andStartCoaching: boolean };
    response: { ok: boolean; error?: string };
  };
  "prep:discard": {
    request: void;
    response: { ok: boolean };
  };
  "prep:set-mode": {
    request: { mode: string };
    response: { ok: boolean; error?: string };
  };
  // Direct (silent) rail edits — see PrepSessionHandle.set/add/edit/remove.
  "prep:set-goal": {
    request: { text: string };
    response: { ok: boolean; error?: string };
  };
  "prep:add-checklist-item": {
    request: { text: string };
    response: { ok: boolean; error?: string };
  };
  "prep:edit-checklist-item": {
    request: { id: string; text: string };
    response: { ok: boolean; error?: string };
  };
  "prep:remove-checklist-item": {
    request: { id: string };
    response: { ok: boolean; error?: string };
  };
  "pending-prep:get": {
    request: void;
    response: PendingPrepPayload | null;
  };
  "pending-prep:clear": {
    request: void;
    response: { ok: boolean };
  };
}

export interface PrepMessagePayload {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  createdAt: number;
  streaming?: boolean;
  toolName?: string;
}

export interface PrepStatePayload {
  goal: string;
  checklist: ChecklistItem[];
  mode: string;
  messages: PrepMessagePayload[];
  event: ArmedEvent | null;
  assistantBusy: boolean;
}

export interface PendingPrepPayload {
  goal: string;
  checklist: ChecklistItem[];
  mode?: string;
  eventId?: string;
  eventTitle?: string;
  savedAt: number;
}

export interface ArmedEvent {
  id: string;
  title: string;
  startsAt: number;
  attendees?: { name?: string; email?: string }[];
}

export type InvokeChannel = keyof InvokeChannels;
export type InvokeRequest<C extends InvokeChannel> = InvokeChannels[C]["request"];
export type InvokeResponse<C extends InvokeChannel> = InvokeChannels[C]["response"];

// -- main → renderer (event) -------------------------------------------------

export interface EventChannels {
  "nudge:received": Nudge;
  "nudge:requested": { source: "hotkey" | "tray" | "panel" };
  "panel:state": PanelState;
  "settings:changed": AppSettings;
  "call:status": { status: "idle" | "armed" | "live" | "ended"; reason?: string };
  "transcript:utterance": TranscriptUtterance;
  "setup:loaded": { setup: CallSetup; eventId?: string };
  "auth:state-changed": { signedIn: boolean; userId?: string; email?: string };
  "main:tab-changed": { tab: MainTab };
  "session:state-changed": {
    state: "idle" | "starting" | "live" | "ending" | "ended" | "error";
    setup?: CallSetup | null;
  };
  // Live audio/transcription health for the overlay status dot.
  "session:status": SessionStatusEvent;
  // A start attempt was blocked by a failed pre-flight check.
  "preflight:failed": { code: "mic" | "auth" | "claude"; message: string };
  "session:setup": { setup: CallSetup };
  "calendar:arm-changed": { event: ArmedEvent | null };
  "prep:state-changed": PrepStatePayload | null;
  "prep:assistant-chunk": { delta: string; messageId: string };
  "pending-prep:changed": { prep: PendingPrepPayload | null };
}

export type EventChannel = keyof EventChannels;
export type EventPayload<C extends EventChannel> = EventChannels[C];

// The shape exposed via contextBridge to renderers.
export interface PromptyBridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    payload: InvokeRequest<C>,
  ): Promise<InvokeResponse<C>>;
  on<C extends EventChannel>(
    channel: C,
    handler: (payload: EventPayload<C>) => void,
  ): () => void;
}

declare global {
  interface Window {
    prompty: PromptyBridge;
  }
}
