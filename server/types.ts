export type Speaker = "me" | "them";

export type TranscriptUtterance = {
  speaker: Speaker;
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
};

export type ChecklistItem = {
  id: string;
  text: string;
  status: "open" | "partial" | "covered";
};

export type CallContext = {
  attendee?: {
    name?: string;
    email?: string;
    company?: string;
    bio?: string;
    summary?: string;
  };
  attioNotes?: string[];
  manualNotes?: string;
};

export type CallSetup = {
  goal: string;
  checklist: ChecklistItem[];
  context: CallContext;
  mode?: string;
};

export type Nudge = {
  id: string;
  kind: "segue" | "missed-goal" | "fact-reminder" | "correction" | "answer";
  text: string;
  urgency: "high" | "medium";
  createdAt: number;
};

export type ServerToClient =
  | { type: "transcript"; utterance: TranscriptUtterance }
  | { type: "nudge"; nudge: Nudge }
  | { type: "checklist_update"; itemId: string; status: ChecklistItem["status"] }
  | { type: "setup"; setup: CallSetup }
  | { type: "setup_pushed"; setup: CallSetup }
  | { type: "call_ended"; logPath: string }
  | { type: "error"; message: string }
  | { type: "ready" };

export type ClientToServer =
  | { type: "start_call"; setup: CallSetup }
  | { type: "end_call" }
  | { type: "audio_chunk"; source: Speaker; pcm16: string; sampleRate: number }
  | { type: "request_nudge" }
  | { type: "client_error"; source: string; message: string; name?: string };
