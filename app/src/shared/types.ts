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
// from the Memory tab.
export interface MemoryItem {
  id: string;
  text: string;
  createdAt: number;
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

export interface CallSetup {
  // The whole coaching brief: a free-text direction describing what a good call
  // looks like (RUBY_MVP §3). Optional only because a draft may not have one
  // yet. Goal/checklist are layered on via `components`.
  direction?: string;
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
  // Set true the moment onboarding completes; drives the one-time guided first
  // run in Home (prep-bar coachmark + playbook coachmark on the prep screen).
  // Cleared the first time the user engages or dismisses, and never returns.
  // Defaults false so existing installs don't suddenly see the tour.
  firstRunCoach: boolean;
  // Set true the moment onboarding completes; gates the one-time in-call "ready"
  // primer (and the "hover to end" hint) on the overlay during the user's FIRST
  // live call. Cleared when that first call ends, and never returns. Defaults
  // false so existing installs don't suddenly see it.
  firstCallCoach: boolean;
  lastTab: MainTab;
  // The working direction, persisted as a draft so a prepped brief survives
  // closing/reopening the window. Empty until the user types or preps one.
  directionDraft: string;
  // The sticky in-call skill (folder name, e.g. "discovery"). Reusable
  // methodology, so it persists across calls — unlike the per-call direction.
  // Empty = "No skill" (base + direction only). Written synchronously on pick.
  skill: string;
  // The goal/checklist armed during prep, persisted alongside directionDraft so a
  // brief prepped ahead of a call survives an app quit (Gap 2). Together with
  // directionDraft this is the one pending prep; both are cleared at call start.
  prepComponents: PrepComponent[];
  // Google sign-in state, mirrored into settings so renderers can show the
  // signed-in identity without an extra IPC round-trip. The encrypted session
  // itself lives in userData/google-session.bin (see google-auth.ts).
  signedIn: boolean;
  signedInUserId: string | null;
  signedInEmail: string | null;
  // Product analytics (PostHog). Opt-out: capture is on by default, this turns
  // it off. analyticsAnonId is the stable pre-sign-in distinct_id (empty until
  // first use). Neither ever holds call content — see electron/analytics.ts.
  analyticsOptOut: boolean;
  analyticsAnonId: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  panelPosition: null,
  panelSize: null,
  launchAtLogin: false,
  hotkey: "Alt+Shift+Space",
  onboardingCompleted: false,
  loginItemPrompted: false,
  firstRunCoach: false,
  firstCallCoach: false,
  lastTab: "prep",
  directionDraft: "",
  skill: "",
  prepComponents: [],
  signedIn: false,
  signedInUserId: null,
  signedInEmail: null,
  analyticsOptOut: false,
  analyticsAnonId: "",
};

/** Display metadata for a pickable skill — name (folder) + frontmatter title/description. */
export interface SkillInfo {
  name: string;
  title: string;
  description: string;
  /** A short example nudge this playbook would surface — shown in the picker so
   *  the choice is informed and "what's a playbook" answers itself in context. */
  sample: string;
}

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
