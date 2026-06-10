import React, { useEffect, useRef, useState } from "react";
import type { AppSettings, ChecklistItem, TranscriptUtterance, CallSetup } from "@shared/types";
import type {
  ArmedEvent,
  PendingPrepPayload,
  PrepStatePayload,
  PrepMessagePayload,
} from "@shared/ipc";

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

  const startAdhoc = () => window.prompty.invoke("prep:open", {});

  return (
    <div className="mw-root" data-testid="main-window-root">
      <header className="mw-topbar">
        <div className="mw-topbar-actions">
          {view === "home" && (
            <button
              className="mw-btn mw-btn-primary"
              onClick={startAdhoc}
              data-testid="home-adhoc-button"
            >
              + Start ad-hoc call
            </button>
          )}
          <button
            className="mw-icon-btn"
            onClick={() => setView(view === "settings" ? "home" : "settings")}
            data-testid="topbar-settings"
            aria-label="Settings"
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>
      {preflight && (
        <PreflightBanner
          code={preflight.code}
          message={preflight.message}
          onDismiss={() => setPreflight(null)}
        />
      )}
      <main className="mw-body" data-testid={`view-${view}`}>
        <div className="mw-content">
          {view === "home" && (
            <Home
              signedIn={!!settings?.signedIn}
              onStartAdhoc={startAdhoc}
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
        </div>
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
    <div className="mw-preflight" data-testid="preflight-error" data-code={code}>
      <span className="mw-preflight-msg">{message}</span>
      <button
        className="mw-btn mw-btn-primary"
        onClick={action}
        data-testid={actionTestId}
      >
        {actionLabel}
      </button>
      <button
        className="mw-btn mw-btn-ghost"
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

const COMPLETED_PREVIEW = 5;

function Home({
  signedIn,
  onStartAdhoc,
  onOpenCompleted,
}: {
  signedIn: boolean;
  onStartAdhoc: () => void;
  onOpenCompleted: (name: string) => void;
}): JSX.Element {
  const [armed, setArmed] = useState<ArmedEvent | null>(null);
  const [pending, setPending] = useState<PendingPrepPayload | null>(null);
  const [upcoming, setUpcoming] = useState<ArmedEvent[]>([]);
  const [completed, setCompleted] = useState<CompletedFile[]>([]);
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  // Call type picked for a no-prep ad-hoc start (idle hero). Defaults to the
  // general "default" coaching mode so a single click is enough to start.
  const [adhocMode, setAdhocMode] = useState<string>("default");

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

  const startNow = (mode?: string) =>
    window.prompty.invoke("call:start", mode ? { mode } : {});
  const startPrep = () => window.prompty.invoke("prep:open", { eventId: armed?.id });
  const resumePrep = () =>
    window.prompty.invoke("prep:open", { eventId: pending?.eventId });
  const discardPending = () =>
    window.prompty.invoke("pending-prep:clear", undefined as never);

  const visibleCompleted =
    showAllCompleted || completed.length <= COMPLETED_PREVIEW
      ? completed
      : completed.slice(0, COMPLETED_PREVIEW);

  // Hero precedence: a prep you already built (most actionable) wins, then an
  // imminent calendar call, else a calm "start a call" prompt.
  let hero: JSX.Element;
  if (pending) {
    hero = (
      <div className="mw-hero" data-testid="pending-prep-card">
        <div className="mw-hero-eyebrow">Ready to run</div>
        <div className="mw-hero-title">
          {pending.eventTitle ?? "Ad-hoc call"}
        </div>
        <div className="mw-hero-meta">
          {pending.goal}
          {" · "}
          {pending.checklist.length} checklist item
          {pending.checklist.length === 1 ? "" : "s"}
        </div>
        <div className="mw-hero-actions">
          <button
            className="mw-btn mw-btn-primary"
            onClick={() => startNow()}
            data-testid="pending-prep-start"
          >
            Run the call
          </button>
          <button
            className="mw-btn mw-btn-secondary"
            onClick={resumePrep}
            data-testid="pending-prep-resume"
          >
            Resume prep
          </button>
          <button
            className="mw-btn mw-btn-ghost"
            onClick={discardPending}
            data-testid="pending-prep-discard"
          >
            Discard
          </button>
        </div>
      </div>
    );
  } else if (armed) {
    hero = (
      <div className="mw-hero" data-testid="armed-event-card">
        <div className="mw-hero-eyebrow">Up next</div>
        <div className="mw-hero-title" data-testid="armed-event-title">
          {armed.title}
        </div>
        <div className="mw-hero-meta">
          Starts {new Date(armed.startsAt).toLocaleTimeString()}
          {armed.attendees && armed.attendees.length > 0 && (
            <> · {armed.attendees.map((a) => a.name ?? a.email).join(", ")}</>
          )}
        </div>
        <div className="mw-hero-actions">
          <button
            className="mw-btn mw-btn-primary"
            onClick={() => startNow()}
            data-testid="armed-event-start-now"
          >
            Run the call
          </button>
          <button
            className="mw-btn mw-btn-secondary"
            onClick={startPrep}
            data-testid="armed-event-start-prep"
          >
            Prep
          </button>
        </div>
      </div>
    );
  } else {
    hero = (
      <div className="mw-hero mw-hero-idle" data-testid="idle-hero">
        <div className="mw-hero-title">Start a call</div>
        <div className="mw-hero-sub">
          Pick a call type and start — no prep needed. You'll get live nudges
          right away.
        </div>
        <div className="mw-mode-row" data-testid="idle-mode-row">
          {MODE_OPTIONS.map((opt) => {
            const active = adhocMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                className={`mw-chip${active ? " active" : ""}`}
                onClick={() => setAdhocMode(opt.value)}
                data-testid={`idle-mode-chip-${opt.value}`}
                data-active={active ? "true" : "false"}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <div className="mw-hero-actions">
          <button
            className="mw-btn mw-btn-primary"
            onClick={() => startNow(adhocMode)}
            data-testid="idle-start-call"
          >
            Start call
          </button>
          <button
            className="mw-btn mw-btn-secondary"
            onClick={onStartAdhoc}
            data-testid="home-hero-adhoc"
          >
            Prep first
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {hero}

      <div className="mw-section" data-testid="upcoming-list">
        <div className="mw-section-label">
          Upcoming
          {upcoming.length > 0 && (
            <span className="mw-section-count">{upcoming.length}</span>
          )}
        </div>
        {upcoming.length === 0 ? (
          signedIn ? (
            <div className="mw-empty">No upcoming calls with a video link.</div>
          ) : (
            <div className="mw-empty-action">
              <span>Connect Google Calendar to see your upcoming calls.</span>
              <button
                className="mw-btn mw-btn-secondary"
                onClick={() =>
                  window.prompty.invoke("auth:google-sign-in", undefined as never)
                }
                data-testid="home-connect-calendar"
              >
                Sign in with Google
              </button>
            </div>
          )
        ) : (
          <div className="mw-list">
            {upcoming.map((e) => (
              <button
                key={e.id}
                className="mw-row"
                onClick={() => window.prompty.invoke("prep:open", { eventId: e.id })}
                data-testid={`upcoming-${e.id}`}
              >
                <div className="mw-row-main">
                  <div className="mw-row-title">{e.title}</div>
                  <div className="mw-row-meta">
                    {new Date(e.startsAt).toLocaleString([], {
                      weekday: "short",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                    {e.attendees && e.attendees.length > 0 && (
                      <> · {e.attendees.map((a) => a.name ?? a.email).join(", ")}</>
                    )}
                  </div>
                </div>
                <span className="mw-row-action mw-btn mw-btn-secondary">Prep</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mw-section" data-testid="completed-list">
        <div className="mw-section-label">
          Completed
          {completed.length > 0 && (
            <span className="mw-section-count">{completed.length}</span>
          )}
        </div>
        {completed.length === 0 ? (
          <div className="mw-empty">No completed calls yet.</div>
        ) : (
          <>
            <div className="mw-list">
              {visibleCompleted.map((c) => (
                <button
                  key={c.name}
                  className="mw-row"
                  onClick={() => onOpenCompleted(c.name)}
                  data-testid={`completed-${c.name}`}
                >
                  <div className="mw-row-main">
                    <div className="mw-row-title">
                      {formatCompletedTitle(c.name)}
                    </div>
                    <div className="mw-row-meta">
                      {new Date(c.mtimeMs).toLocaleString([], {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </div>
                  </div>
                  <span className="mw-row-chevron">›</span>
                </button>
              ))}
            </div>
            {completed.length > COMPLETED_PREVIEW && !showAllCompleted && (
              <button
                className="mw-show-all"
                onClick={() => setShowAllCompleted(true)}
                data-testid="completed-show-all"
              >
                Show all ({completed.length})
              </button>
            )}
          </>
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

function PrepMessageRow({ m }: { m: PrepMessagePayload }): JSX.Element {
  if (m.role === "tool") {
    return (
      <div className="prep-trace" data-testid="prep-msg-tool">
        · {m.text}
      </div>
    );
  }
  const isUser = m.role === "user";
  return (
    <div
      className={`prep-msg-row ${isUser ? "user" : "assistant"}`}
      data-testid={isUser ? "prep-msg-user" : "prep-msg-assistant"}
    >
      <div className={`prep-bubble ${isUser ? "user" : "assistant"}`}>
        {m.text || (m.streaming ? "…" : "")}
      </div>
    </div>
  );
}

// Inline goal editor — click to edit, Enter/blur commits, Escape cancels.
// Silent: writes via prep:set-goal and never sends a chat message.
function GoalEditor({ goal }: { goal: string }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal);
  useEffect(() => {
    if (!editing) setDraft(goal);
  }, [goal, editing]);

  const commit = () => {
    const v = draft.trim();
    setEditing(false);
    if (v && v !== goal) {
      void window.prompty.invoke("prep:set-goal", { text: v });
    }
  };

  if (editing) {
    return (
      <input
        className="prep-edit-input"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            setDraft(goal);
            setEditing(false);
          }
        }}
        data-testid="prep-goal-input"
      />
    );
  }
  return goal ? (
    <div
      className="prep-goal-text"
      onClick={() => setEditing(true)}
      data-testid="prep-goal-text"
    >
      {goal}
    </div>
  ) : (
    <div
      className="prep-goal-empty"
      onClick={() => setEditing(true)}
      data-testid="prep-goal-empty"
    >
      Click to set a goal…
    </div>
  );
}

// Inline checklist editor — each row click-to-edit + hover-delete, plus an
// "+ add item" affordance. All edits are silent (no chat message).
function ChecklistEditor({ items }: { items: ChecklistItem[] }): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [newDraft, setNewDraft] = useState("");

  const startEdit = (it: ChecklistItem) => {
    setEditingId(it.id);
    setDraft(it.text);
  };
  const commitEdit = (it: ChecklistItem) => {
    const v = draft.trim();
    setEditingId(null);
    if (v && v !== it.text) {
      void window.prompty.invoke("prep:edit-checklist-item", { id: it.id, text: v });
    }
  };
  const remove = (id: string) => {
    void window.prompty.invoke("prep:remove-checklist-item", { id });
  };
  const commitAdd = () => {
    const v = newDraft.trim();
    if (v) {
      void window.prompty.invoke("prep:add-checklist-item", { text: v });
    }
    setNewDraft("");
  };

  return (
    <>
      {items.length === 0 && !adding && (
        <div className="prep-check-empty">No items yet</div>
      )}
      {items.map((c) => (
        <div className="prep-check-row" key={c.id} data-testid="prep-check-row">
          <span className="prep-check-bullet">·</span>
          {editingId === c.id ? (
            <input
              className="prep-edit-input"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => commitEdit(c)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit(c);
                } else if (e.key === "Escape") {
                  setEditingId(null);
                }
              }}
              data-testid="prep-check-input"
            />
          ) : (
            <>
              <span
                className="prep-check-text"
                onClick={() => startEdit(c)}
                data-testid="prep-check-text"
              >
                {c.text}
              </span>
              <button
                className="prep-check-remove"
                onClick={() => remove(c.id)}
                title="Remove"
                aria-label="Remove item"
                data-testid="prep-check-remove"
              >
                ×
              </button>
            </>
          )}
        </div>
      ))}
      {adding ? (
        <div className="prep-add-row">
          <span className="prep-check-bullet">·</span>
          <input
            className="prep-edit-input"
            autoFocus
            value={newDraft}
            onChange={(e) => setNewDraft(e.target.value)}
            onBlur={() => {
              commitAdd();
              setAdding(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitAdd();
              } else if (e.key === "Escape") {
                setNewDraft("");
                setAdding(false);
              }
            }}
            placeholder="Short topic label…"
            data-testid="prep-check-add-input"
          />
        </div>
      ) : (
        <div className="prep-add-row">
          <button
            className="prep-add-btn"
            onClick={() => setAdding(true)}
            data-testid="prep-check-add"
          >
            + add item
          </button>
        </div>
      )}
    </>
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
    <div className="prep-root" data-testid="prep-root">
      <header className="prep-header" data-testid="prep-header">
        {event ? (
          <>
            <div className="prep-header-title">{event.title}</div>
            <div className="prep-header-meta">
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
          <div className="prep-header-title" data-testid="prep-adhoc-title">
            Ad-hoc call prep
          </div>
        )}
      </header>

      <div className="prep-body">
        <div className="prep-chat-col">
          <div
            className="prep-transcript"
            ref={scrollRef}
            data-testid="prep-transcript"
          >
            {messages.length === 0 ? (
              <div className="prep-empty">
                Tell me about the call — who's on it and what you want out of it.
              </div>
            ) : (
              messages.map((m) => <PrepMessageRow key={m.id} m={m} />)
            )}
            {state.assistantBusy && (
              <div className="prep-typing" data-testid="prep-typing">
                Prompty is typing…
              </div>
            )}
          </div>
          <div className="prep-input-row">
            <textarea
              className="prep-textarea"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="What's the one outcome that would make this call a win?"
              data-testid="prep-input"
              rows={1}
            />
            <button
              className="prep-btn prep-btn-primary"
              onClick={send}
              disabled={busy || !input.trim()}
              data-testid="prep-send"
            >
              Send
            </button>
          </div>
        </div>

        <aside className="prep-rail">
          <div className="prep-mode-row" data-testid="prep-mode-row">
            {MODE_OPTIONS.map((opt) => {
              const active = mode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`prep-chip${active ? " active" : ""}`}
                  onClick={() => void pickMode(opt.value)}
                  data-testid={`prep-mode-chip-${opt.value}`}
                  data-active={active ? "true" : "false"}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <div className="prep-card" data-testid="prep-goal-card">
            <div className="prep-card-title">Goal</div>
            <GoalEditor goal={goal} />
          </div>
          <div className="prep-card" data-testid="prep-checklist-card">
            <div className="prep-card-title">Checklist</div>
            <ChecklistEditor items={checklist} />
          </div>
        </aside>
      </div>

      <footer className="prep-footer">
        <button
          className="prep-btn prep-btn-secondary"
          onClick={discard}
          disabled={busy}
          data-testid="prep-discard"
        >
          Discard
        </button>
        <button
          className="prep-btn prep-btn-secondary"
          onClick={saveAndClose}
          disabled={busy || !canSaveAndStart}
          data-testid="prep-save-close"
        >
          Save & close
        </button>
        <button
          className="prep-btn prep-btn-primary"
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
        className="mw-btn mw-btn-secondary mw-back"
        onClick={onBack}
        data-testid="completed-back"
      >
        ← Back
      </button>
      {!log && !error && <div className="mw-empty">Loading…</div>}
      {error && <div className="mw-empty">{error}</div>}
      {log && (
        <>
          <div className="mw-detail-title">{formatCompletedTitle(name)}</div>
          <div className="mw-detail-meta">
            {new Date(log.endedAt).toLocaleString()}
            {log.mode && <> · {log.mode}</>}
          </div>

          <div className="mw-card">
            <div className="mw-card-label">Goal</div>
            <div className="mw-card-text">{log.goal}</div>
            {log.summary?.goalRecap && (
              <>
                <div className="mw-card-label">Outcome</div>
                <div className="mw-card-text">{log.summary.goalRecap}</div>
              </>
            )}
          </div>

          <div className="mw-card">
            <div className="mw-card-label">Checklist</div>
            {(log.summary?.items ?? (log.checklist ?? []).map((c) => ({
              id: c.id,
              text: c.text,
              status: c.status,
              answer: "Not discussed.",
            }))).map((it) => (
              <div key={it.id} className="mw-check-item">
                <div className="mw-check-head">
                  <span
                    className={`mw-check-glyph ${
                      it.status === "covered"
                        ? "covered"
                        : it.status === "partial"
                          ? "partial"
                          : it.status === "skipped"
                            ? "skipped"
                            : "pending"
                    }`}
                  >
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
                <div className="mw-check-answer">{it.answer}</div>
              </div>
            ))}
          </div>

          <div className="mw-card">
            <div className="mw-card-label">Transcript</div>
            {(log.transcript ?? []).length === 0 ? (
              <div className="mw-empty">No transcript recorded.</div>
            ) : (
              <div className="mw-transcript">
                {(log.transcript ?? []).map((u, i) => (
                  <div key={i} className="mw-utt">
                    <span
                      className={`mw-utt-speaker ${
                        u.speaker === "me" ? "me" : "them"
                      }`}
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
        className="mw-btn mw-btn-secondary mw-back"
        onClick={onBack}
        data-testid="settings-back"
      >
        ← Back
      </button>
      <div className="mw-detail-title">Settings</div>

      <div className="mw-section">
        <div className="mw-section-label">Account</div>
        <div className="mw-kv">
          <span className="mw-kv-key">Signed in</span>
          <span className="mw-kv-val" data-testid="settings-account-status">
            {signedIn ? email ?? "Yes" : "Not signed in"}
          </span>
        </div>
        <div style={{ marginTop: 12 }}>
          {signedIn ? (
            <button
              className="mw-btn mw-btn-secondary"
              data-testid="settings-sign-out"
              disabled={busy}
              onClick={signOut}
            >
              Sign out
            </button>
          ) : (
            <button
              className="mw-btn mw-btn-primary"
              data-testid="settings-sign-in"
              disabled={busy}
              onClick={signIn}
            >
              Sign in with Google
            </button>
          )}
        </div>
      </div>

      <div className="mw-section">
        <div className="mw-section-label">Permissions</div>
        <div className="mw-kv"><span className="mw-kv-key">Microphone</span><span className="mw-kv-val">—</span></div>
        <div className="mw-kv"><span className="mw-kv-key">Notifications</span><span className="mw-kv-val">—</span></div>
      </div>

      <div className="mw-section">
        <div className="mw-section-label">Storage</div>
        <div className="mw-kv">
          <span className="mw-kv-key">Call log folder</span>
          <span className="mw-kv-val">~/.prompty/calls/</span>
        </div>
      </div>

      <div className="mw-section">
        <div className="mw-section-label">About</div>
        <div className="mw-kv"><span className="mw-kv-key">Version</span><span className="mw-kv-val">0.1.0 (dev)</span></div>
        <div className="mw-kv"><span className="mw-kv-key">Hotkey</span><span className="mw-kv-val">{settings?.hotkey ?? "Alt+Shift+Space"}</span></div>
      </div>
    </>
  );
}
