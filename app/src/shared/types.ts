// Shared domain types between main and renderer.

// Agent-side nudge kind/urgency (matches ported server/agent.ts tool schema).
export type AgentNudgeKind =
  | "segue"
  | "missed-goal"
  | "fact-reminder"
  | "correction"
  | "answer";
export type AgentNudgeUrgency = "high" | "medium";

// UI nudge kind — superset of the agent kinds plus a few renderer-only ones.
export type NudgeKind =
  | AgentNudgeKind
  | "ask"
  | "warn"
  | "info"
  | "covered"
  | "wrap";

export interface Nudge {
  id: string;
  kind: NudgeKind;
  // Set by the agent loop; drives the high-urgency (red) treatment in the UI.
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

export type ChecklistStatus = "open" | "covered" | "partial" | "skipped";

export interface ChecklistItem {
  id: string;
  text: string;
  status: ChecklistStatus;
}

export type Speaker = "me" | "them";

export interface TranscriptUtterance {
  speaker: Speaker;
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
}

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
  goal: string;
  checklist: ChecklistItem[];
  context: CallContext;
  mode?: string;
}

export const PREP_MODES = [
  "default",
  "discovery",
  "user-interview",
  "hiring",
] as const;
export type PrepMode = (typeof PREP_MODES)[number];

export function isPrepMode(s: string): s is PrepMode {
  return (PREP_MODES as readonly string[]).includes(s);
}

export interface PanelState {
  compact: boolean;
  callStatus: "idle" | "armed" | "live" | "ended";
  goal: string | null;
  checklist: ChecklistItem[];
  nudges: Nudge[];
}

export type MainTab = "prep" | "in-call" | "past-calls" | "settings";

export interface AppSettings {
  panelPosition: { x: number; y: number } | null;
  launchAtLogin: boolean;
  hotkey: string;
  signedIn: boolean;
  onboardingCompleted: boolean;
  loginItemPrompted: boolean;
  signedInUserId: string | null;
  signedInEmail: string | null;
  lastTab: MainTab;
  // When true, nudges flash in the floating teleprompter bar and the overlay
  // stays minimal. When false, the bar is hidden and nudges collect as a feed
  // inside the overlay. Replaces the old inverted `focusMode` flag.
  headsUpBar: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  panelPosition: null,
  launchAtLogin: false,
  hotkey: "Alt+Shift+Space",
  signedIn: false,
  onboardingCompleted: false,
  loginItemPrompted: false,
  signedInUserId: null,
  signedInEmail: null,
  lastTab: "prep",
  headsUpBar: true,
};

export type MediaPermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export interface PermissionStatus {
  microphone: MediaPermissionStatus;
  screen: MediaPermissionStatus;
  notifications: "enabled" | "unknown";
}

export interface MacOsVersion {
  major: number;
  minor: number;
  patch: number;
  needsScreenRecording: boolean;
}
