import React, { useEffect, useRef, useState } from "react";
import type { AppSettings, ChecklistItem, TranscriptUtterance, CallSetup } from "@shared/types";
import type {
  ArmedEvent,
  PendingPrepPayload,
  PrepStatePayload,
  PrepMessagePayload,
} from "@shared/ipc";

const styles = {
  root: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Inter", sans-serif',
    color: "#1d1d1f",
    background: "#f5f5f7",
    height: "100vh",
    display: "flex",
    flexDirection: "column" as const,
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 20px",
    background: "white",
    borderBottom: "1px solid #e5e5e5",
  },
  brand: { fontSize: 14, fontWeight: 600 },
  iconBtn: {
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontSize: 18,
    padding: 4,
    color: "#1d1d1f",
  },
  main: { flex: 1, padding: 20, overflow: "auto" },
  h1: { fontSize: 18, fontWeight: 600, marginBottom: 12 },
  row: {
    display: "flex",
    justifyContent: "space-between",
    padding: "8px 0",
    borderBottom: "1px solid #e5e5e5",
  },
  muted: { color: "#86868b", fontSize: 12 },
  placeholder: {
    color: "#86868b",
    padding: "40px 0",
    textAlign: "center" as const,
  },
  card: {
    background: "white",
    borderRadius: 8,
    border: "1px solid #e5e5e5",
    padding: 16,
    marginBottom: 12,
  },
  primaryBtn: {
    padding: "6px 14px",
    borderRadius: 6,
    border: "none",
    background: "#0a84ff",
    color: "#fff",
    cursor: "pointer",
    fontSize: 12,
    marginRight: 8,
  },
  secondaryBtn: {
    padding: "6px 14px",
    borderRadius: 6,
    border: "1px solid #d2d2d7",
    background: "#fff",
    cursor: "pointer",
    fontSize: 12,
    marginRight: 8,
  },
} satisfies Record<string, React.CSSProperties>;

type View = "home" | "settings" | "completed";
type SessionState = "idle" | "starting" | "live" | "ending" | "ended" | "error";

export default function App(): JSX.Element {
  const [view, setView] = useState<View>("home");
  const [selectedCall, setSelectedCall] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [prepState, setPrepState] = useState<PrepStatePayload | null>(null);
  const [preflight, setPreflight] = useState<
    { code: "mic" | "auth" | "claude"; message: string } | null
  >(null);

  useEffect(() => {
    window.prompty
      .invoke("settings:get", undefined as never)
      .then(setSettings)
      .catch(() => {});
    window.prompty
      .invoke("prep:get-state", undefined as never)
      .then(setPrepState)
      .catch(() => {});
    window.prompty
      .invoke("preflight:get", undefined as never)
      .then((p) => {
        if (p) setPreflight(p);
      })
      .catch(() => {});
    const offSettings = window.prompty.on("settings:changed", setSettings);
    const offTab = window.prompty.on("main:tab-changed", () => {
      // Legacy event from notification-click flow; route to home.
      setView("home");
    });
    const offPrep = window.prompty.on("prep:state-changed", setPrepState);
    const offPreflight = window.prompty.on("preflight:failed", (p) =>
      setPreflight(p),
    );
    const offAuth = window.prompty.on("auth:state-changed", (p) => {
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              signedIn: p.signedIn,
              signedInUserId: p.userId ?? null,
              signedInEmail: p.email ?? null,
            }
          : prev,
      );
    });
    return () => {
      offSettings();
      offTab();
      offPrep();
      offPreflight();
      offAuth();
    };
  }, []);

  // Prep view takes over the whole window whenever a prep is active.
  if (prepState) {
    return <RunningPrep state={prepState} />;
  }

  return (
    <div style={styles.root} data-testid="main-window-root">
      <header style={styles.topBar}>
        <div style={styles.brand}>Prompty</div>
        <button
          style={styles.iconBtn}
          onClick={() => setView(view === "settings" ? "home" : "settings")}
          data-testid="topbar-settings"
          aria-label="Settings"
          title="Settings"
        >
          ⚙
        </button>
      </header>
      {preflight && (
        <PreflightBanner
          code={preflight.code}
          message={preflight.message}
          onDismiss={() => setPreflight(null)}
        />
      )}
      <main style={styles.main} data-testid={`view-${view}`}>
        {view === "home" && (
          <Home
            onOpenCompleted={(name) => {
              setSelectedCall(name);
              setView("completed");
            }}
          />
        )}
        {view === "settings" && (
          <SettingsTab settings={settings} onBack={() => setView("home")} />
        )}
        {view === "completed" && selectedCall && (
          <CompletedCallDetail
            name={selectedCall}
            onBack={() => setView("home")}
          />
        )}
      </main>
    </div>
  );
}

function PreflightBanner({
  code,
  message,
  onDismiss,
}: {
  code: "mic" | "auth" | "claude";
  message: string;
  onDismiss: () => void;
}): JSX.Element {
  const action = async () => {
    try {
      if (code === "mic") {
        await window.prompty.invoke("onboarding:request-mic", undefined as never);
      } else if (code === "auth") {
        await window.prompty.invoke("auth:google-sign-in", undefined as never);
      } else {
        await window.prompty.invoke("onboarding:open-external", {
          url: "https://docs.claude.com/en/docs/claude-code/overview",
        });
      }
    } finally {
      onDismiss();
    }
  };
  const actionLabel =
    code === "mic"
      ? "Grant mic access"
      : code === "auth"
        ? "Sign in"
        : "Install Claude Code";
  const actionTestId =
    code === "mic"
      ? "preflight-grant-mic"
      : code === "auth"
        ? "preflight-sign-in"
        : "preflight-install-claude";
  return (
    <div
      data-testid="preflight-error"
      data-code={code}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 20px",
        background: "#fff4e5",
        borderBottom: "1px solid #f0d9b5",
        color: "#7a4f01",
        fontSize: 13,
      }}
    >
      <span style={{ flex: 1 }}>{message}</span>
      <button style={styles.primaryBtn} onClick={action} data-testid={actionTestId}>
        {actionLabel}
      </button>
      <button
        style={styles.secondaryBtn}
        onClick={onDismiss}
        data-testid="preflight-dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}

interface CompletedFile {
  name: string;
  mtimeMs: number;
}

function Home({
  onOpenCompleted,
}: {
  onOpenCompleted: (name: string) => void;
}): JSX.Element {
  const [armed, setArmed] = useState<ArmedEvent | null>(null);
  const [pending, setPending] = useState<PendingPrepPayload | null>(null);
  const [upcoming, setUpcoming] = useState<ArmedEvent[]>([]);
  const [completed, setCompleted] = useState<CompletedFile[]>([]);

  const refreshUpcoming = () => {
    window.prompty
      .invoke("calendar:list-upcoming", { limit: 5 })
      .then((r) => setUpcoming(r.events))
      .catch(() => {});
  };
  const refreshCompleted = () => {
    window.prompty
      .invoke("calls:list", undefined as never)
      .then((r) => setCompleted(r.files))
      .catch(() => setCompleted([]));
  };

  useEffect(() => {
    window.prompty
      .invoke("calendar:current-arm", undefined as never)
      .then((r) => setArmed(r.event))
      .catch(() => {});
    window.prompty
      .invoke("pending-prep:get", undefined as never)
      .then(setPending)
      .catch(() => {});
    refreshUpcoming();
    refreshCompleted();
    const offArm = window.prompty.on("calendar:arm-changed", (p) => {
      setArmed(p.event);
      refreshUpcoming();
    });
    const offPP = window.prompty.on("pending-prep:changed", (p) => {
      setPending(p.prep);
    });
    const offState = window.prompty.on("session:state-changed", (p) => {
      // When a session ends, refresh the completed list.
      if (p.state === "ended" || p.state === "idle") refreshCompleted();
    });
    return () => {
      offArm();
      offPP();
      offState();
    };
  }, []);

  const startNow = () => window.prompty.invoke("call:start", undefined as never);
  const startPrep = () => window.prompty.invoke("prep:open", { eventId: armed?.id });
  const startAdhoc = () => window.prompty.invoke("prep:open", {});
  const resumePrep = () =>
    window.prompty.invoke("prep:open", { eventId: pending?.eventId });
  const discardPending = () =>
    window.prompty.invoke("pending-prep:clear", undefined as never);

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <button
          style={styles.primaryBtn}
          onClick={startAdhoc}
          data-testid="home-adhoc-button"
        >
          + Start ad-hoc call
        </button>
      </div>

      {pending && (
        <div style={styles.card} data-testid="pending-prep-card">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Prepped {pending.eventTitle ? `for ${pending.eventTitle}` : "(ad-hoc)"}
          </div>
          <div style={{ ...styles.muted, marginBottom: 4 }}>Goal: {pending.goal}</div>
          <div style={{ ...styles.muted, marginBottom: 12 }}>
            {pending.checklist.length} checklist item
            {pending.checklist.length === 1 ? "" : "s"}
          </div>
          <button
            style={styles.primaryBtn}
            onClick={startNow}
            data-testid="pending-prep-start"
          >
            Run the call
          </button>
          <button
            style={styles.secondaryBtn}
            onClick={resumePrep}
            data-testid="pending-prep-resume"
          >
            Resume prep
          </button>
          <button
            style={styles.secondaryBtn}
            onClick={discardPending}
            data-testid="pending-prep-discard"
          >
            Discard
          </button>
        </div>
      )}

      {armed && (
        <div style={styles.card} data-testid="armed-event-card">
          <div style={{ fontWeight: 600, marginBottom: 4 }} data-testid="armed-event-title">
            {armed.title}
          </div>
          <div style={{ ...styles.muted, marginBottom: 12 }}>
            Starts {new Date(armed.startsAt).toLocaleTimeString()}
            {armed.attendees && armed.attendees.length > 0 && (
              <> · {armed.attendees.map((a) => a.name ?? a.email).join(", ")}</>
            )}
          </div>
          <button
            style={styles.primaryBtn}
            onClick={startNow}
            data-testid="armed-event-start-now"
          >
            Run the call
          </button>
          <button
            style={styles.secondaryBtn}
            onClick={startPrep}
            data-testid="armed-event-start-prep"
          >
            Prep
          </button>
        </div>
      )}

      <div style={{ marginTop: 16 }} data-testid="upcoming-list">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Upcoming</div>
        {upcoming.length === 0 && (
          <div style={styles.muted}>No upcoming calls with a video link.</div>
        )}
        {upcoming.map((e) => (
          <div key={e.id} style={styles.card} data-testid={`upcoming-${e.id}`}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{e.title}</div>
            <div style={{ ...styles.muted, marginBottom: 8 }}>
              {new Date(e.startsAt).toLocaleString([], {
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
              })}
              {e.attendees && e.attendees.length > 0 && (
                <> · {e.attendees.map((a) => a.name ?? a.email).join(", ")}</>
              )}
            </div>
            <button
              style={styles.secondaryBtn}
              onClick={() => window.prompty.invoke("prep:open", { eventId: e.id })}
            >
              Prep
            </button>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 24 }} data-testid="completed-list">
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Completed</div>
        {completed.length === 0 ? (
          <div style={styles.muted}>No completed calls yet.</div>
        ) : (
          completed.map((c) => (
            <button
              key={c.name}
              style={{
                ...styles.card,
                width: "100%",
                textAlign: "left",
                cursor: "pointer",
                background: "white",
                fontSize: 13,
              }}
              onClick={() => onOpenCompleted(c.name)}
              data-testid={`completed-${c.name}`}
            >
              <div style={{ fontWeight: 600, marginBottom: 2 }}>
                {formatCompletedTitle(c.name)}
              </div>
              <div style={styles.muted}>
                {new Date(c.mtimeMs).toLocaleString([], {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </div>
            </button>
          ))
        )}
      </div>
    </>
  );
}

function formatCompletedTitle(filename: string): string {
  // ISO-ish timestamp prefix then `-<attendee>.json`.
  const m = filename.match(/^\d{4}-\d{2}-\d{2}T[^Z]*Z-(.+)\.json$/);
  if (!m) return filename;
  const attendee = m[1].replace(/_/g, " ");
  return attendee === "unknown" ? "Untitled call" : attendee;
}

const MODE_OPTIONS: { value: string; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "discovery", label: "Discovery" },
  { value: "user-interview", label: "User interview" },
  { value: "hiring", label: "Hiring" },
];

const prepStyles = {
  root: {
    display: "flex",
    flexDirection: "column" as const,
    height: "calc(100vh - 40px)",
    margin: -20,
    background: "#f5f5f7",
  },
  header: {
    padding: "12px 16px",
    background: "white",
    borderBottom: "1px solid #e5e5e5",
  },
  body: { flex: 1, display: "flex", minHeight: 0 },
  chatCol: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    minWidth: 0,
  },
  transcript: { flex: 1, overflow: "auto", padding: 16 },
  inputRow: {
    padding: 12,
    borderTop: "1px solid #e5e5e5",
    background: "white",
    display: "flex",
    gap: 8,
  },
  textarea: {
    flex: 1,
    border: "1px solid #d2d2d7",
    borderRadius: 6,
    padding: "8px 10px",
    fontSize: 13,
    resize: "none" as const,
    fontFamily: "inherit",
    minHeight: 38,
    maxHeight: 120,
    outline: "none",
  },
  rail: {
    width: 320,
    padding: 16,
    borderLeft: "1px solid #e5e5e5",
    background: "#fafafa",
    overflow: "auto",
  },
  card: {
    background: "white",
    borderRadius: 8,
    border: "1px solid #e5e5e5",
    padding: 12,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 11,
    textTransform: "uppercase" as const,
    color: "#86868b",
    fontWeight: 600,
    marginBottom: 6,
  },
  footer: {
    padding: 12,
    borderTop: "1px solid #e5e5e5",
    background: "white",
    display: "flex",
    gap: 8,
    justifyContent: "flex-end",
  },
  msgUser: {
    background: "#0a84ff",
    color: "white",
    padding: "8px 12px",
    borderRadius: 14,
    marginBottom: 8,
    maxWidth: "75%",
    whiteSpace: "pre-wrap" as const,
    fontSize: 13,
  },
  msgAssistant: {
    background: "white",
    color: "#1d1d1f",
    padding: "8px 12px",
    borderRadius: 14,
    marginBottom: 8,
    maxWidth: "75%",
    border: "1px solid #e5e5e5",
    whiteSpace: "pre-wrap" as const,
    fontSize: 13,
  },
  msgTool: {
    color: "#86868b",
    fontSize: 11,
    fontStyle: "italic" as const,
    padding: "2px 0 6px 4px",
  },
  primary: {
    padding: "8px 14px",
    borderRadius: 6,
    border: "none",
    background: "#0a84ff",
    color: "white",
    fontSize: 13,
    cursor: "pointer",
  },
  secondary: {
    padding: "8px 14px",
    borderRadius: 6,
    border: "1px solid #d2d2d7",
    background: "white",
    color: "#1d1d1f",
    fontSize: 13,
    cursor: "pointer",
  },
  muted: { color: "#86868b", fontSize: 12 },
  modeRow: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 6,
    marginBottom: 12,
  },
  modeChip: {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid #d2d2d7",
    background: "white",
    color: "#1d1d1f",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  modeChipActive: {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid #0a84ff",
    background: "#0a84ff",
    color: "white",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  },
} satisfies Record<string, React.CSSProperties>;

function PrepMessageRow({ m }: { m: PrepMessagePayload }): JSX.Element {
  if (m.role === "tool") {
    return (
      <div style={prepStyles.msgTool} data-testid="prep-msg-tool">
        · {m.text}
      </div>
    );
  }
  const isUser = m.role === "user";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isUser ? "flex-end" : "flex-start",
      }}
      data-testid={isUser ? "prep-msg-user" : "prep-msg-assistant"}
    >
      <div style={isUser ? prepStyles.msgUser : prepStyles.msgAssistant}>
        {m.text || (m.streaming ? "…" : "")}
      </div>
    </div>
  );
}

function RunningPrep({ state }: { state: PrepStatePayload }): JSX.Element {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const kickedRef = useRef(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.messages.length, state.assistantBusy]);

  // Empty thread on first mount means the prep session was just opened — ask
  // the main process for an opening greeting that isn't attributed to the user.
  useEffect(() => {
    if (kickedRef.current) return;
    if (state.messages.length > 0) {
      kickedRef.current = true;
      return;
    }
    if (state.assistantBusy) return;
    kickedRef.current = true;
    void window.prompty.invoke("prep:kick", undefined as never);
  }, [state.messages.length, state.assistantBusy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setInput("");
    try {
      await window.prompty.invoke("prep:send-message", { text });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const saveAndStart = async () => {
    setBusy(true);
    try {
      await window.prompty.invoke("prep:save", { andStartCoaching: true });
    } finally {
      setBusy(false);
    }
  };
  const saveAndClose = async () => {
    setBusy(true);
    try {
      await window.prompty.invoke("prep:save", { andStartCoaching: false });
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    setBusy(true);
    try {
      await window.prompty.invoke("prep:discard", undefined as never);
    } finally {
      setBusy(false);
    }
  };

  const pickMode = async (m: string) => {
    try {
      await window.prompty.invoke("prep:set-mode", { mode: m });
    } catch {
      // ignore — handler returns error in payload
    }
  };

  const { event, goal, checklist, messages, mode } = state;
  const canSaveAndStart = !!goal && checklist.length >= 1;

  return (
    <div style={prepStyles.root} data-testid="prep-root">
      <header style={prepStyles.header} data-testid="prep-header">
        {event ? (
          <>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{event.title}</div>
            <div style={prepStyles.muted}>
              Starts {new Date(event.startsAt).toLocaleTimeString()}
              {event.attendees && event.attendees.length > 0 && (
                <>
                  {" "}· {event.attendees
                    .map((a) => a.name ?? a.email)
                    .filter(Boolean)
                    .join(", ")}
                </>
              )}
            </div>
          </>
        ) : (
          <div
            style={{ fontWeight: 600, fontSize: 14 }}
            data-testid="prep-adhoc-title"
          >
            Ad-hoc call prep
          </div>
        )}
      </header>

      <div style={prepStyles.body}>
        <div style={prepStyles.chatCol}>
          <div
            style={prepStyles.transcript}
            ref={scrollRef}
            data-testid="prep-transcript"
          >
            {messages.length === 0 ? (
              <div style={prepStyles.muted}>
                Tell me about the call — who's on it and what you want out of it.
              </div>
            ) : (
              messages.map((m) => <PrepMessageRow key={m.id} m={m} />)
            )}
            {state.assistantBusy && (
              <div style={prepStyles.muted} data-testid="prep-typing">
                Prompty is typing…
              </div>
            )}
          </div>
          <div style={prepStyles.inputRow}>
            <textarea
              style={prepStyles.textarea}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="What's the one outcome that would make this call a win?"
              data-testid="prep-input"
              rows={1}
            />
            <button
              style={prepStyles.primary}
              onClick={send}
              disabled={busy || !input.trim()}
              data-testid="prep-send"
            >
              Send
            </button>
          </div>
        </div>

        <aside style={prepStyles.rail}>
          <div style={prepStyles.modeRow} data-testid="prep-mode-row">
            {MODE_OPTIONS.map((opt) => {
              const active = mode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  style={active ? prepStyles.modeChipActive : prepStyles.modeChip}
                  onClick={() => void pickMode(opt.value)}
                  data-testid={`prep-mode-chip-${opt.value}`}
                  data-active={active ? "true" : "false"}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <div style={prepStyles.card} data-testid="prep-goal-card">
            <div style={prepStyles.cardTitle}>Goal</div>
            {goal ? (
              <div style={{ fontSize: 13 }}>{goal}</div>
            ) : (
              <div style={prepStyles.muted}>Not set yet</div>
            )}
          </div>
          <div style={prepStyles.card} data-testid="prep-checklist-card">
            <div style={prepStyles.cardTitle}>Checklist</div>
            {checklist.length === 0 ? (
              <div style={prepStyles.muted}>No items yet</div>
            ) : (
              checklist.map((c) => (
                <div
                  key={c.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 6,
                    padding: "4px 0",
                    fontSize: 12,
                  }}
                >
                  <span style={{ flex: 1 }}>· {c.text}</span>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      <footer style={prepStyles.footer}>
        <button
          style={prepStyles.secondary}
          onClick={discard}
          disabled={busy}
          data-testid="prep-discard"
        >
          Discard
        </button>
        <button
          style={prepStyles.secondary}
          onClick={saveAndClose}
          disabled={busy || !canSaveAndStart}
          data-testid="prep-save-close"
        >
          Save & close
        </button>
        <button
          style={prepStyles.primary}
          onClick={saveAndStart}
          disabled={busy || !canSaveAndStart}
          data-testid="prep-save-start"
        >
          Save & run the call
        </button>
      </footer>
    </div>
  );
}

interface CompletedCallLog {
  goal: string;
  mode?: string;
  checklist: ChecklistItem[];
  transcript: TranscriptUtterance[];
  attendee?: { name?: string; company?: string };
  startedAt: number;
  endedAt: number;
  summary?: {
    goalRecap: string;
    items: {
      id: string;
      text: string;
      status: ChecklistItem["status"];
      answer: string;
    }[];
  };
}

function CompletedCallDetail({
  name,
  onBack,
}: {
  name: string;
  onBack: () => void;
}): JSX.Element {
  const [log, setLog] = useState<CompletedCallLog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.prompty
      .invoke("calls:read", { name })
      .then((r) => {
        if (cancelled) return;
        try {
          setLog(JSON.parse(r.content) as CompletedCallLog);
        } catch {
          setError("Could not parse call log.");
        }
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [name]);

  return (
    <div data-testid="completed-detail">
      <button
        style={{ ...styles.secondaryBtn, marginBottom: 12 }}
        onClick={onBack}
        data-testid="completed-back"
      >
        ← Back
      </button>
      {!log && !error && <div style={styles.muted}>Loading…</div>}
      {error && <div style={styles.muted}>{error}</div>}
      {log && (
        <>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
              {formatCompletedTitle(name)}
            </div>
            <div style={styles.muted}>
              {new Date(log.endedAt).toLocaleString()}
              {log.mode && <> · {log.mode}</>}
            </div>
          </div>

          <div style={styles.card}>
            <div style={{ ...styles.muted, marginBottom: 4 }}>Goal</div>
            <div style={{ fontSize: 13, marginBottom: 12 }}>{log.goal}</div>
            {log.summary?.goalRecap && (
              <>
                <div style={{ ...styles.muted, marginBottom: 4 }}>Outcome</div>
                <div style={{ fontSize: 13 }}>{log.summary.goalRecap}</div>
              </>
            )}
          </div>

          <div style={styles.card}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Checklist</div>
            {(log.summary?.items ?? (log.checklist ?? []).map((c) => ({
              id: c.id,
              text: c.text,
              status: c.status,
              answer: "Not discussed.",
            }))).map((it) => (
              <div key={it.id} style={{ padding: "8px 0", borderBottom: "1px solid #f0f0f0" }}>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                  <span style={{ marginRight: 6 }}>
                    {it.status === "covered"
                      ? "✔"
                      : it.status === "partial"
                        ? "◐"
                        : it.status === "skipped"
                          ? "✗"
                          : "○"}
                  </span>
                  {it.text}
                </div>
                <div style={{ fontSize: 12, color: "#4a4a4f" }}>{it.answer}</div>
              </div>
            ))}
          </div>

          <div style={styles.card}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Transcript</div>
            {(log.transcript ?? []).length === 0 ? (
              <div style={styles.muted}>No transcript recorded.</div>
            ) : (
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                {(log.transcript ?? []).map((u, i) => (
                  <div key={i} style={{ marginBottom: 4 }}>
                    <span
                      style={{
                        fontWeight: 600,
                        color: u.speaker === "me" ? "#0a84ff" : "#1d1d1f",
                        marginRight: 6,
                      }}
                    >
                      {u.speaker === "me" ? "You" : "Them"}:
                    </span>
                    {u.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SettingsTab({
  settings,
  onBack,
}: {
  settings: AppSettings | null;
  onBack: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const signedIn = !!settings?.signedIn;
  const email = settings?.signedInEmail ?? null;

  const signIn = async () => {
    setBusy(true);
    try {
      await window.prompty.invoke("auth:google-sign-in", undefined as never);
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    setBusy(true);
    try {
      await window.prompty.invoke("auth:sign-out", undefined as never);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        style={{ ...styles.secondaryBtn, marginBottom: 12 }}
        onClick={onBack}
        data-testid="settings-back"
      >
        ← Back
      </button>
      <div style={styles.h1}>Settings</div>

      <div style={{ ...styles.h1, fontSize: 14, marginTop: 8 }}>Account</div>
      <div style={styles.row}>
        <span>Signed in</span>
        <span data-testid="settings-account-status">
          {signedIn ? email ?? "Yes" : "Not signed in"}
        </span>
      </div>
      <div style={{ marginTop: 8 }}>
        {signedIn ? (
          <button
            data-testid="settings-sign-out"
            disabled={busy}
            onClick={signOut}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid #d2d2d7",
              background: "#fff",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Sign out
          </button>
        ) : (
          <button
            data-testid="settings-sign-in"
            disabled={busy}
            onClick={signIn}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "none",
              background: "#0a84ff",
              color: "#fff",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Sign in with Google
          </button>
        )}
      </div>

      <div style={{ ...styles.h1, fontSize: 14, marginTop: 24 }}>Permissions</div>
      <div style={styles.row}><span>Microphone</span><span>—</span></div>
      <div style={styles.row}><span>Screen Recording (macOS &lt;14.4)</span><span>—</span></div>
      <div style={styles.row}><span>Notifications</span><span>—</span></div>

      <div style={{ ...styles.h1, fontSize: 14, marginTop: 24 }}>Storage</div>
      <div style={styles.row}>
        <span>Call log folder</span>
        <span>~/.prompty/calls/</span>
      </div>

      <div style={{ ...styles.h1, fontSize: 14, marginTop: 24 }}>About</div>
      <div style={styles.row}><span>Version</span><span>0.1.0 (dev)</span></div>
      <div style={styles.row}><span>Hotkey</span><span>{settings?.hotkey ?? "Alt+Shift+Space"}</span></div>
    </>
  );
}
