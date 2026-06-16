// Shared domain types between main and renderer.

// Urgency is the one structured dimension on a nudge: it drives the high-urgency
// (red) treatment in the overlay and the preempt behavior in the teleprompter.
// There is deliberately no `kind` taxonomy — what a nudge is and when to fire it
// lives in the (freely-editable) prompt prose, not in a code-side enum.
export type AgentNudgeUrgency = "high" | "medium";

export interface Nudge {
  id: string;
  urgency: AgentNudgeUrgency;
  text: string;
  createdAt: number;
}

// Live health of a coaching session's audio/transcription pipeline, surfaced
// as the overlay status dot. Distinct from the lifecycle SessionState.
export type SessionStatus =
  | "starting"
  | "listening"
  | "no-audio"
  | "mic-silent"
  | "reconnecting"
  | "error";

export interface SessionStatusEvent {
  state: SessionStatus;
  /** Momentary true when a fresh audio frame just arrived — drives the pulse. */
  audioPulse?: boolean;
  reason?: string;
}

export type Speaker = "me" | "them";

export interface TranscriptUtterance {
  speaker: Speaker;
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
}

// A single user-curated personalisation fact — how Ruby should coach *this*
// user (e.g. "nudge me rarely", "keep questions short"). Global: every memory
// applies to every call. Freeform natural language, edited/deleted one-by-one
// from the Memory tab. `source` distinguishes hand-written items from ones Ruby
// proposed and the user confirmed.
export interface MemoryItem {
  id: string;
  text: string;
  createdAt: number;
  source: "manual" | "suggested";
}

// Composable prep components (RUBY B3): structured objects Ruby creates during
// prep to make the call's plan explicit. A small discriminated union so new
// types (question-bank, talking-points, …) are additive, not a rewrite.
export interface GoalComponent {
  type: "goal";
  id: string;
  text: string;
}
export interface ChecklistItem {
  id: string;
  text: string;
  /** Marked covered during the call (phase 3c); always false pre-call. */
  done: boolean;
}
export interface ChecklistComponent {
  type: "checklist";
  id: string;
  title?: string;
  items: ChecklistItem[];
}
export type PrepComponent = GoalComponent | ChecklistComponent;

export interface CallContextAttendee {
  name?: string;
  email?: string;
  company?: string;
  bio?: string;
  summary?: string;
}

export interface CallContext {
  attendee?: CallContextAttendee;
  attioNotes?: string[];
  manualNotes?: string;
}

export interface CallSetup {
  // The whole coaching brief: a free-text direction describing what a good call
  // looks like (RUBY_MVP §3/§4 — goal + checklist were cut). Optional only
  // because a draft may not have one yet.
  direction?: string;
  context: CallContext;
  // Optional named playbook layered on top of base + direction (e.g.
  // "discovery", "hiring", "user-interview"). Empty/absent = no skill.
  skill?: string;
  // Snapshot of the user's global memory (personalisation) at the moment the
  // call started — how Ruby should coach them. Threaded onto the setup once in
  // startSession so every prompt built from it (in-call + hotkey) reflects it.
  memories?: MemoryItem[];
  // Composable components built during prep (goal/checklist). Folded onto the
  // setup at call start and injected into the in-call prompt (RUBY B3).
  components?: PrepComponent[];
}

export interface PanelState {
  compact: boolean;
  callStatus: "idle" | "armed" | "live" | "ended";
  nudges: Nudge[];
}

export type MainTab = "prep" | "in-call" | "past-calls" | "settings";

export interface AppSettings {
  panelPosition: { x: number; y: number } | null;
  // Persisted overlay size; null until the user resizes it, then restored on
  // the next session so the panel keeps whatever footprint they chose.
  panelSize: { width: number; height: number } | null;
  launchAtLogin: boolean;
  hotkey: string;
  onboardingCompleted: boolean;
  loginItemPrompted: boolean;
  lastTab: MainTab;
  // When true, prep and in-call sessions write a verbose debug log (the
  // model's-eye view: resolved prompts, per-turn context deltas, raw model
  // responses, tool calls, latencies) to ~/.prompty/debug/. Off by default;
  // opt-in developer/diagnostic capture. Takes effect immediately mid-session.
  debugMode: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  panelPosition: null,
  panelSize: null,
  launchAtLogin: false,
  hotkey: "Alt+Shift+Space",
  onboardingCompleted: false,
  loginItemPrompted: false,
  lastTab: "prep",
  // Playground default: on, so every call self-archives its direction + the
  // model's-eye view to ~/.prompty/debug/call-*.{jsonl,md} for replay later.
  debugMode: true,
};

export type MediaPermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export interface PermissionStatus {
  microphone: MediaPermissionStatus;
  notifications: "enabled" | "unknown";
}
