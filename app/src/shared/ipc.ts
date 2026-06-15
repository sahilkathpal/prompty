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
  TranscriptUtterance,
  PermissionStatus,
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
    // Each entry carries enough to render the Past Calls list without opening
    // every file: the effective title and the call's clock.
    response: {
      files: {
        name: string;
        mtimeMs: number;
        title: string;
        startedAt?: number;
        endedAt?: number;
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
  // Playground: pick a file and return its contents, to load a direction/prompt
  // from disk instead of typing it. Returns null if the user cancels.
  "direction:load-file": {
    request: void;
    response: { content: string; path: string } | null;
  };
  // Playground: the single persisted direction (~/.prompty/playground/direction.md).
  // The home textarea loads this on launch and saves it on Start/blur, so the UI
  // box and the on-disk file are the same artifact — nothing is lost.
  "direction:load-current": {
    request: void;
    response: { content: string };
  };
  "direction:save-current": {
    request: { content: string };
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
  "call:start": {
    // Optional skill. Lets a user start a call straight from the home screen
    // with a chosen playbook (or none), with no prep required.
    request: { skill?: string } | void;
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
