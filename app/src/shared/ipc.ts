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
  PanelState,
  AppSettings,
  CallSetup,
  MemoryItem,
  PrepComponent,
  TranscriptUtterance,
  PermissionStatus,
  MainTab,
  SessionStatusEvent,
  SkillInfo,
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
    // Each entry carries enough to render the Past Calls list without opening
    // every file: the effective title and the call's clock.
    response: {
      files: {
        name: string;
        mtimeMs: number;
        title: string;
        startedAt?: number;
        endedAt?: number;
        // True while the background summary pass is still running for this call.
        summaryPending?: boolean;
      }[];
    };
  };
  "calls:read": {
    request: { name: string };
    response: { content: string };
  };
  // Rename a saved call — rewrites the `title` field in its JSON (the file name
  // itself stays put as the stable id).
  "calls:rename": {
    request: { name: string; title: string };
    response: { ok: boolean };
  };
  // Memory (RUBY upgrade B1): the user's curated personalisation for how Ruby
  // coaches them. Flat global list, managed from the Memory tab; injected into
  // the in-call + hotkey prompts.
  "memory:list": {
    request: void;
    response: { items: MemoryItem[] };
  };
  "memory:add": {
    request: { text: string };
    response: { item: MemoryItem | null };
  };
  "memory:update": {
    request: { id: string; text: string };
    response: { ok: boolean };
  };
  "memory:delete": {
    request: { id: string };
    response: { ok: boolean };
  };
  // Prep chat (RUBY B2 phase 2b): a conversational pre-call session. Start opens
  // the prep agent seeded with the current working direction; send is one user
  // turn; end tears it down. Assistant replies + live direction rewrites arrive
  // as events (prep:assistant / prep:direction).
  "prep:start": {
    request: { direction?: string };
    response: { ok: boolean };
  };
  "prep:send": {
    request: { message: string };
    response: { ok: boolean };
  };
  "prep:end": {
    request: void;
    response: { ok: boolean };
  };
  // Grow the main window for the prep split-view, restore it on exit. The split
  // (chat + direction + components) needs real width to breathe.
  "main:set-prep-layout": {
    request: { wide: boolean };
    response: void;
  };
  // Push user edits to the prep components back to the armed setup in main
  // (RUBY B3 phase 3a). Replaces the whole list.
  "prep:set-components": {
    request: { components: PrepComponent[] };
    response: { ok: boolean };
  };
  "settings:get": {
    request: void;
    response: AppSettings;
  };
  "settings:set": {
    request: Partial<AppSettings>;
    response: AppSettings;
  };
  // The skills the Direction-tab picker offers: BUNDLED only, with display
  // metadata. User skills are excluded (their override loading is disabled).
  "skills:list": {
    request: void;
    response: { skills: SkillInfo[] };
  };
  "call:start": {
    // The per-call direction (the whole brief) typed in the Direction tab, plus
    // an optional skill. Direction is ephemeral: passed in at start, snapshotted
    // into the CallLog, never persisted pre-call (RUBY B2 phase 2a).
    request: { skill?: string; direction?: string } | void;
    response: { ok: boolean; error?: string };
  };
  "call:end": {
    request: void;
    response: { ok: boolean; error?: string };
  };
  // On-demand nudge request from the overlay's "What should I ask?" button.
  "nudge:request": {
    request: { source: "panel" };
    response: { ok: boolean };
  };
  // The gem renderer asks the overlay window to fit its measured content
  // height as it moves between states (gem-only → gem+bloom → gem+history).
  // Always exact: the window snaps tightly to each state so a dismissed bloom
  // or collapsed history returns it to the small resting footprint. Width is
  // fixed.
  "overlay:set-height": {
    request: { height: number };
    response: { ok: boolean };
  };
  // Nudge the gem window by a screen-space delta. The renderer drives this from
  // a press-drag on the pill (drag to move, click to expand) since a native
  // `-webkit-app-region: drag` region can't also receive the expand click.
  "overlay:move-by": {
    request: { dx: number; dy: number };
    response: { ok: boolean };
  };
  // Last recent pre-flight failure — queried by the main window on mount so a
  // just-opened window (e.g. via the T-0 notification path) doesn't miss the
  // one-shot preflight:failed broadcast.
  "preflight:get": {
    request: void;
    response: { code: "mic" | "claude"; message: string } | null;
  };
  "quit": {
    request: void;
    response: void;
  };
  "debug:inject-utterance": {
    request: { speaker: "me" | "them"; text: string; isFinal?: boolean };
    response: { ok: boolean; error?: string };
  };
  // Reveal the debug-log directory (~/.prompty/debug/) in the OS file browser.
  // Creates the directory first if it does not yet exist so the button always
  // opens something. Used by the Debug section of the Settings tab.
  "debug:reveal": {
    request: void;
    response: { ok: boolean; path: string };
  };
  "onboarding:check-claude": {
    request: void;
    response: { found: boolean; path: string | null };
  };
  "onboarding:request-mic": {
    request: void;
    response: { granted: boolean };
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
  "onboarding:set-ruby-message": {
    request: { text: string | null };
    response: void;
  };
  "onboarding:set-height": {
    request: { height: number };
    response: void;
  };
  // Toggle whether the (mostly-transparent) overlay window swallows mouse events.
  // The renderer ignores by default so clicks pass through the empty rectangle to
  // apps behind it, and only captures while the cursor is over the gem/note/panel.
  "overlay:set-mouse-ignore": {
    request: { ignore: boolean };
    response: void;
  };
  "onboarding:celebrate": {
    request: void;
    response: void;
  };
  // Register the real global hotkey for the onboarding hotkey step and put the
  // main process into "onboarding nudge" mode. `registered` is false (and
  // `conflict` true) when the combo is already claimed by another app, in which
  // case the card falls back to a focused-window keydown listener for the demo.
  "onboarding:arm-hotkey": {
    request: void;
    response: { ok: boolean; registered: boolean; conflict: boolean };
  };
  // Fallback for when the global shortcut couldn't be registered: the card's
  // focused-window keydown listener asks main to bloom a sample nudge, so the
  // demo path is identical to the real one (same bloom + onboarding:hotkey-fired).
  "onboarding:fire-nudge": {
    request: void;
    response: void;
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
}

export type InvokeChannel = keyof InvokeChannels;
export type InvokeRequest<C extends InvokeChannel> = InvokeChannels[C]["request"];
export type InvokeResponse<C extends InvokeChannel> = InvokeChannels[C]["response"];

// -- main → renderer (event) -------------------------------------------------

export interface EventChannels {
  "nudge:received": Nudge;
  "nudge:requested": { source: "hotkey" | "tray" | "panel" };
  // The onboarding hotkey step's global shortcut fired — the card sets its
  // "done" state, restores itself, and reveals Continue. Carries the sample
  // nudge that simultaneously bloomed in the overlay.
  "onboarding:hotkey-fired": { nudge: Nudge };
  "panel:state": PanelState;
  "settings:changed": AppSettings;
  "call:status": { status: "idle" | "armed" | "live" | "ended"; reason?: string };
  "transcript:utterance": TranscriptUtterance;
  "setup:loaded": { setup: CallSetup; eventId?: string };
  "main:tab-changed": { tab: MainTab };
  "session:state-changed": {
    state: "idle" | "starting" | "live" | "ending" | "ended" | "error";
    setup?: CallSetup | null;
  };
  // Live audio/transcription health for the overlay status dot.
  "session:status": SessionStatusEvent;
  // A start attempt was blocked by a failed pre-flight check.
  "preflight:failed": { code: "mic" | "claude"; message: string };
  "session:setup": { setup: CallSetup };
  // A saved call changed on disk (e.g. the background summary pass landed) —
  // renderers showing the Past Calls list re-read it. `name` is the log filename.
  "calls:updated": { name: string };
  "overlay:ruby-message": { text: string | null };
  // Prep chat streaming (RUBY B2 phase 2b).
  "prep:assistant-delta": { text: string };
  "prep:assistant": { text: string };
  "prep:direction": { direction: string };
  "prep:thinking": { thinking: boolean };
  "prep:error": { message: string };
  // Prep components changed — full current list (RUBY B3 phase 3a).
  "prep:components": { components: PrepComponent[] };
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
