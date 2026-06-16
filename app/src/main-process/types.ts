// Re-export shared domain types so main-process code can import from a single
// local path without reaching across into renderer-flavored shared.
export type {
  Speaker,
  TranscriptUtterance,
  CallContext,
  CallContextAttendee,
  CallSetup,
  MemoryItem,
  PrepComponent,
  GoalComponent,
  ChecklistComponent,
  ChecklistItem,
  Nudge,
  AgentNudgeUrgency,
  SessionStatus,
  SessionStatusEvent,
} from "../shared/types";
