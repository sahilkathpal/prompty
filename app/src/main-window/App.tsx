// Prompty — Playground home (prompt-playground branch).
//
// Two tabs: Direction (the whole coaching prompt, with the minimal base.md) +
// past calls; and Settings (mic, Google, Claude, debug, hotkey). No onboarding,
// calendar, prep, skills, goal, or checklist — those are earned features, added
// back to production only once proven useful. Starting a call goes straight to a
// direction-only session (no prep).

import React, { useCallback, useEffect, useRef, useState } from "react";
import Gem from "../shared/Gem";
import "../shared/tokens.css";

type SessionState = "idle" | "starting" | "live" | "ending" | "ended" | "error";
type CallMeta = {
  name: string;
  mtimeMs: number;
  title: string;
  startedAt?: number;
  endedAt?: number;
  summaryPending?: boolean;
};
type Tab = "direction" | "memory" | "settings";
type Mem = { id: string; text: string; createdAt: number; source: "manual" | "suggested" };
const TAB_LABELS: Record<Tab, string> = {
  direction: "Direction",
  memory: "Memory",
  settings: "Settings",
};

// The post-call card (RUBY_MVP decision #9), as written onto the call log JSON
// by summary.ts. Optional fields are defensive — older logs predate this shape.
type CallInsight = { text: string; assisted?: boolean; via?: string };
type CallSummary = {
  title?: string;
  recap: string;
  insights: CallInsight[];
  questionsNotAsked: { text: string }[];
  stat: { surfaced: number; used: number };
};
type ParsedCall = {
  title?: string;
  summary?: CallSummary;
  startedAt?: number;
  endedAt?: number;
  attendee?: { name?: string; company?: string };
  summaryPending?: boolean;
  raw: string;
};

// ---- Past-calls list formatting -------------------------------------------
function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}
function dayLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (sameDay(d, now)) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts);
}
function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDur(start?: number, end?: number): string | null {
  if (!start || !end || end <= start) return null;
  return `${Math.max(1, Math.round((end - start) / 60000))} min`;
}
// Calls arrive newest-first; collapse consecutive same-day runs into groups.
function groupByDay(calls: CallMeta[]): { label: string; items: CallMeta[] }[] {
  const groups: { label: string; items: CallMeta[] }[] = [];
  for (const c of calls) {
    const label = dayLabel(c.startedAt ?? c.mtimeMs);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(c);
    else groups.push({ label, items: [c] });
  }
  return groups;
}

const v = (name: string, fallback: string) => `var(${name}, ${fallback})`;
const MIC_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>("direction");
  const [direction, setDirection] = useState("");
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState(false);
  const [hotkey, setHotkey] = useState("Alt+Shift+Space");
  const [calls, setCalls] = useState<CallMeta[]>([]);
  const [openCall, setOpenCall] = useState<{ name: string; call: ParsedCall } | null>(null);
  const [editing, setEditing] = useState<{ name: string; draft: string } | null>(null);
  const [micStatus, setMicStatus] = useState<string | null>(null);
  const [claude, setClaude] = useState<{ found: boolean; path: string | null } | null>(null);
  const [memories, setMemories] = useState<Mem[]>([]);
  const [newMemory, setNewMemory] = useState("");
  const [editingMem, setEditingMem] = useState<{ id: string; draft: string } | null>(null);
  const [prepOpen, setPrepOpen] = useState(false);
  const [prepMessages, setPrepMessages] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [prepInput, setPrepInput] = useState("");
  const [prepThinking, setPrepThinking] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);
  const seeded = useRef(false);

  const refreshCalls = useCallback(() => {
    window.prompty
      .invoke("calls:list", undefined as never)
      .then((r) => setCalls(r.files))
      .catch(() => {});
  }, []);
  const refreshMic = useCallback(() => {
    window.prompty
      .invoke("onboarding:permission-status", undefined as never)
      .then((p) => setMicStatus(p.microphone))
      .catch(() => {});
  }, []);
  const refreshClaude = useCallback(() => {
    window.prompty
      .invoke("onboarding:check-claude", undefined as never)
      .then((r) => setClaude(r))
      .catch(() => {});
  }, []);
  const refreshMemories = useCallback(() => {
    window.prompty
      .invoke("memory:list", undefined as never)
      .then((r) => setMemories(r.items))
      .catch(() => {});
  }, []);
  const readCall = useCallback(async (name: string): Promise<ParsedCall | null> => {
    try {
      const r = await window.prompty.invoke("calls:read", { name });
      let parsed: ParsedCall = { raw: r.content };
      try {
        const obj = JSON.parse(r.content) as Record<string, unknown>;
        const summary = obj.summary as CallSummary | undefined;
        parsed = {
          title: (obj.title as string | undefined) ?? summary?.title,
          summary,
          startedAt: obj.startedAt as number | undefined,
          endedAt: obj.endedAt as number | undefined,
          attendee: obj.attendee as ParsedCall["attendee"],
          summaryPending: obj.summaryPending as boolean | undefined,
          raw: JSON.stringify(obj, null, 2),
        };
      } catch {}
      return parsed;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    // Direction is ephemeral (RUBY B2 phase 2a): the editor starts empty every
    // launch. The only seed is an already-live call's direction, so reopening
    // the window mid-call still shows what's being coached.
    window.prompty
      .invoke("session:state", undefined as never)
      .then((r) => {
        setSessionState(r.state);
        if (!seeded.current && r.setup?.direction) {
          setDirection(r.setup.direction);
          seeded.current = true;
        }
      })
      .catch(() => {});
    window.prompty
      .invoke("settings:get", undefined as never)
      .then((s) => {
        const set = s as { debugMode?: boolean; hotkey?: string };
        if (set.hotkey) setHotkey(set.hotkey);
        // Playground defaults debug on; force it on if a stored setting was off.
        setDebug(true);
        if (set.debugMode !== true) window.prompty.invoke("settings:set", { debugMode: true } as never);
      })
      .catch(() => {});
    window.prompty
      .invoke("preflight:get", undefined as never)
      .then((pf) => pf && setError(pf.message))
      .catch(() => {});
    refreshCalls();
    refreshMic();
    refreshClaude();
    refreshMemories();

    const offState = window.prompty.on("session:state-changed", (p) => {
      setSessionState(p.state);
      if (p.state === "ended" || p.state === "idle") refreshCalls();
    });
    const offPf = window.prompty.on("preflight:failed", (p) => {
      setError(p.message);
      if (p.code === "mic") refreshMic();
    });
    // The background summary pass landed: refresh the list, and if the affected
    // call is open, re-read it so the "Summarizing…" placeholder fills in.
    const offCallsUpdated = window.prompty.on("calls:updated", (p) => {
      refreshCalls();
      setOpenCall((oc) => {
        if (oc?.name === p.name) {
          void readCall(p.name).then((call) => {
            if (call)
              setOpenCall((cur) => (cur?.name === p.name ? { name: p.name, call } : cur));
          });
        }
        return oc;
      });
    });
    // Prep chat streaming (RUBY B2 phase 2b).
    const offPrepAsst = window.prompty.on("prep:assistant", (p) =>
      setPrepMessages((m) => [...m, { role: "assistant", text: p.text }]),
    );
    const offPrepDir = window.prompty.on("prep:direction", (p) => {
      // Ruby rewrote the shared working direction — reflect it live in the editor.
      setDirection(p.direction);
      seeded.current = true;
    });
    const offPrepThinking = window.prompty.on("prep:thinking", (p) =>
      setPrepThinking(p.thinking),
    );
    const offPrepError = window.prompty.on("prep:error", (p) => setPrepError(p.message));
    return () => {
      offState();
      offPf();
      offCallsUpdated();
      offPrepAsst();
      offPrepDir();
      offPrepThinking();
      offPrepError();
    };
  }, [refreshCalls, refreshMic, refreshClaude, refreshMemories, readCall]);

  const openPrep = useCallback(async () => {
    setPrepError(null);
    setPrepMessages([]);
    const r = await window.prompty.invoke("prep:start", { direction });
    if (r.ok) setPrepOpen(true);
    else setPrepError("Couldn't start prep — is Claude Code installed?");
  }, [direction]);

  const sendPrep = useCallback(() => {
    const msg = prepInput.trim();
    if (!msg || prepThinking) return;
    setPrepInput("");
    setPrepMessages((m) => [...m, { role: "user", text: msg }]);
    void window.prompty.invoke("prep:send", { message: msg });
  }, [prepInput, prepThinking]);

  const closePrep = useCallback(() => {
    void window.prompty.invoke("prep:end", undefined as never);
    setPrepOpen(false);
  }, []);

  const addMemoryItem = useCallback(() => {
    const text = newMemory.trim();
    if (!text) return;
    setNewMemory("");
    void window.prompty.invoke("memory:add", { text }).then((r) => {
      if (r.item) setMemories((list) => [...list, r.item as Mem]);
    });
  }, [newMemory]);

  const saveMemoryEdit = useCallback(() => {
    if (!editingMem) return;
    const { id, draft } = editingMem;
    const text = draft.trim();
    setEditingMem(null);
    if (!text) return;
    void window.prompty.invoke("memory:update", { id, text }).then((r) => {
      if (r.ok) setMemories((list) => list.map((m) => (m.id === id ? { ...m, text } : m)));
    });
  }, [editingMem]);

  const deleteMemoryItem = useCallback((id: string) => {
    void window.prompty.invoke("memory:delete", { id }).then((r) => {
      if (r.ok) setMemories((list) => list.filter((m) => m.id !== id));
    });
  }, []);

  const isLive =
    sessionState === "starting" || sessionState === "live" || sessionState === "ending";
  // The end teardown — closing the agent and generating the post-call summary —
  // can take several seconds. Surface it: the button locks into "Ending…" and a
  // status line explains the wait, so a re-click can't fire end() again.
  const isEnding = sessionState === "ending";

  const start = useCallback(async () => {
    setError(null);
    if (!direction.trim()) {
      setError("Add a direction first — it's the brief your coach follows on the call.");
      return;
    }
    const r = await window.prompty.invoke("call:start", { direction });
    if (!r.ok) {
      const pf = await window.prompty
        .invoke("preflight:get", undefined as never)
        .catch(() => null);
      setError(pf?.message ?? r.error ?? "Couldn't start the call.");
      if (pf?.code === "mic") refreshMic();
    }
  }, [direction, refreshMic]);

  const end = useCallback(() => {
    void window.prompty.invoke("call:end", undefined as never);
  }, []);

  const loadFile = useCallback(async () => {
    const r = await window.prompty
      .invoke("direction:load-file", undefined as never)
      .catch(() => null);
    if (r) setDirection(r.content);
  }, []);

  const toggleDebug = useCallback(() => {
    setDebug((cur) => {
      const next = !cur;
      window.prompty.invoke("settings:set", { debugMode: next } as never);
      return next;
    });
  }, []);

  const grantMic = useCallback(async () => {
    await window.prompty.invoke("onboarding:request-mic", undefined as never).catch(() => {});
    refreshMic();
  }, [refreshMic]);

  const viewCall = useCallback(
    (name: string) => {
      if (openCall?.name === name) {
        setOpenCall(null);
        return;
      }
      void readCall(name).then((call) => {
        if (call) setOpenCall({ name, call });
      });
    },
    [openCall, readCall],
  );

  const saveRename = useCallback(() => {
    if (!editing) return;
    const { name, draft } = editing;
    const title = draft.trim();
    setEditing(null);
    void window.prompty.invoke("calls:rename", { name, title }).then(() => {
      setCalls((list) => list.map((c) => (c.name === name ? { ...c, title } : c)));
      setOpenCall((oc) =>
        oc && oc.name === name ? { ...oc, call: { ...oc.call, title } } : oc,
      );
    });
  }, [editing]);

  const micOk = micStatus === "granted";
  const micBlocked = micStatus === "denied" || micStatus === "restricted";

  const chatPanel = (
    <section style={S.chatCard}>
      <div style={S.chatHead}>
        <span style={S.label}>Prep with Ruby</span>
        <button style={S.linkBtn} data-testid="prep-done" onClick={closePrep}>
          Done
        </button>
      </div>
      <div style={S.chatLog} data-testid="prep-log">
        {prepMessages.length === 0 && !prepThinking ? (
          <div style={S.empty}>Tell Ruby about the call you're about to have.</div>
        ) : (
          prepMessages.map((m, i) => (
            <div
              key={i}
              data-testid={`prep-msg-${m.role}`}
              style={m.role === "user" ? S.bubbleUser : S.bubbleAsst}
            >
              {m.text}
            </div>
          ))
        )}
        {prepThinking && (
          <div style={S.bubbleAsst} data-testid="prep-thinking">
            …
          </div>
        )}
      </div>
      {prepError && <div style={S.error}>{prepError}</div>}
      <div style={S.chatInputRow}>
        <input
          data-testid="prep-input"
          style={S.memInput}
          value={prepInput}
          placeholder="Message Ruby…"
          onChange={(e) => setPrepInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendPrep();
          }}
        />
        <button
          style={S.btnAccent}
          data-testid="prep-send"
          onClick={sendPrep}
          disabled={!prepInput.trim() || prepThinking}
        >
          Send
        </button>
      </div>
    </section>
  );

  return (
    <div style={S.page}>
      <div className="app-dragbar" />
      <header className="app-drag" style={S.header}>
        <div>
          <div style={S.title}>
            <Gem variant="mini" size={20} />
            <span>Ruby</span>
          </div>
          <div style={S.subtitle}>Your coaching brief — what a good call looks like, on every call.</div>
        </div>
        <nav className="app-no-drag" style={S.nav}>
          {(["direction", "memory", "settings"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              data-testid={`tab-${t}`}
              style={{ ...S.navBtn, ...(tab === t ? S.navBtnActive : null) }}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      </header>

      {tab === "direction" ? (
        <>
          {!prepOpen && !micOk && micStatus && (
            <div style={S.warn}>
              <span>🎙️ Microphone not granted — calls can't hear audio.</span>
              <button style={S.linkBtn} onClick={() => setTab("settings")}>
                Fix in Settings →
              </button>
            </div>
          )}

          <div style={prepOpen ? S.prepSplit : undefined}>
          {prepOpen && chatPanel}
          <div style={prepOpen ? S.prepRight : undefined}>
          <section style={S.card}>
            <label style={S.label} htmlFor="direction">
              Direction
            </label>
            <textarea
              id="direction"
              data-testid="playground-direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              placeholder="Describe what a good call looks like: what to explore, the stance to carry, when to speak up…"
              spellCheck={false}
              style={S.textarea}
            />
            <div style={S.row}>
              <button style={S.btnGhost} onClick={loadFile}>
                Load from file…
              </button>
              {!prepOpen && !isLive && (
                <button style={S.btnGhost} data-testid="prep-open" onClick={openPrep}>
                  Prep with Ruby
                </button>
              )}
              <span style={{ flex: 1 }} />
              {isLive ? (
                <button
                  style={{ ...S.btnDanger, ...(isEnding ? S.btnBusy : null) }}
                  data-testid="playground-end"
                  onClick={end}
                  disabled={isEnding}
                >
                  {isEnding ? "Ending…" : "End call"}
                </button>
              ) : (
                <button style={S.btnAccent} data-testid="playground-start" onClick={start}>
                  Start call
                </button>
              )}
            </div>
            {isEnding ? (
              <div style={S.ending} data-testid="playground-ending">
                <span className="mw-spinner" aria-hidden /> Wrapping up — saving your call
                summary. This can take a few seconds.
              </div>
            ) : isLive ? (
              <div style={S.live}>
                <span style={S.dot} /> Coaching live in the floating overlay.
              </div>
            ) : null}
            {error && (
              <div style={S.error} data-testid="playground-error">
                {error}
              </div>
            )}
          </section>
          </div>
          </div>

          {!prepOpen && (
          <section style={S.card}>
            <div style={S.cardHead}>
              <span style={S.label}>Past calls</span>
              <button style={S.linkBtn} onClick={refreshCalls}>
                Refresh
              </button>
            </div>
            {calls.length === 0 ? (
              <div style={S.empty}>No calls yet — start one above.</div>
            ) : (
              groupByDay(calls).map((group) => (
                <div key={group.label} style={S.callGroup}>
                  <div style={S.callDay}>{group.label}</div>
                  <ul style={S.list}>
                    {group.items.map((c) => {
                      const when = c.startedAt ?? c.mtimeMs;
                      const open = openCall?.name === c.name;
                      const isEditing = editing?.name === c.name;
                      const dur = fmtDur(c.startedAt, c.endedAt);
                      return (
                        <li key={c.name}>
                          <div className={`pc-rowwrap${open ? " open" : ""}`} style={S.callRowWrap}>
                            {isEditing ? (
                              <input
                                autoFocus
                                style={S.renameInput}
                                value={editing.draft}
                                onChange={(e) => setEditing({ name: c.name, draft: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") saveRename();
                                  if (e.key === "Escape") setEditing(null);
                                }}
                                onBlur={saveRename}
                              />
                            ) : (
                              <>
                                <button
                                  className="pc-row"
                                  style={S.callMain}
                                  onClick={() => viewCall(c.name)}
                                >
                                  <span style={S.callChevron}>{open ? "▾" : "▸"}</span>
                                  <span style={S.callTitle}>{c.title || "Untitled call"}</span>
                                  <span style={S.callMeta}>
                                    {fmtClock(when)}
                                    {dur ? ` · ${dur}` : ""}
                                    {c.summaryPending ? " · Summarizing…" : ""}
                                  </span>
                                </button>
                                <button
                                  style={S.renameBtn}
                                  title="Rename"
                                  aria-label="Rename call"
                                  onClick={() => setEditing({ name: c.name, draft: c.title || "" })}
                                >
                                  ✎
                                </button>
                              </>
                            )}
                          </div>
                          {open && <CallCard call={openCall.call} />}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))
            )}
          </section>
          )}
        </>
      ) : tab === "memory" ? (
        <>
          <section style={S.card}>
            <div style={S.cardHead}>
              <span style={S.label}>Memory</span>
            </div>
            <div style={S.memIntro}>
              Tell Ruby how to coach you. These apply to every call — nudge
              frequency, tone, things to always watch for.
            </div>
            <div style={S.memAddRow}>
              <input
                data-testid="memory-input"
                style={S.memInput}
                value={newMemory}
                placeholder="e.g. Nudge me rarely — only when it really matters."
                onChange={(e) => setNewMemory(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addMemoryItem();
                }}
              />
              <button
                style={S.btnAccent}
                data-testid="memory-add"
                onClick={addMemoryItem}
                disabled={!newMemory.trim()}
              >
                Add
              </button>
            </div>
            {memories.length === 0 ? (
              <div style={S.empty} data-testid="memory-empty">
                No memories yet — add one above and Ruby will keep it in mind.
              </div>
            ) : (
              <ul style={S.list} data-testid="memory-list">
                {memories.map((m) => {
                  const isEditing = editingMem?.id === m.id;
                  return (
                    <li key={m.id}>
                      <div className="pc-rowwrap" style={S.memRowWrap} data-testid="memory-item">
                        {isEditing ? (
                          <input
                            autoFocus
                            style={S.renameInput}
                            value={editingMem.draft}
                            onChange={(e) => setEditingMem({ id: m.id, draft: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveMemoryEdit();
                              if (e.key === "Escape") setEditingMem(null);
                            }}
                            onBlur={saveMemoryEdit}
                          />
                        ) : (
                          <>
                            <span style={S.memText}>{m.text}</span>
                            {m.source === "suggested" && (
                              <span style={S.memTag} title="Suggested by Ruby">
                                suggested
                              </span>
                            )}
                            <button
                              style={S.renameBtn}
                              title="Edit"
                              aria-label="Edit memory"
                              onClick={() => setEditingMem({ id: m.id, draft: m.text })}
                            >
                              ✎
                            </button>
                            <button
                              style={S.renameBtn}
                              title="Delete"
                              aria-label="Delete memory"
                              data-testid="memory-delete"
                              onClick={() => deleteMemoryItem(m.id)}
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      ) : (
        <>
          <section style={S.card}>
            <Setting
              label="Microphone"
              value={micStatus ?? "checking…"}
              tone={micOk ? "green" : micBlocked ? "red" : "amber"}
            >
              {!micOk &&
                (micBlocked ? (
                  <button
                    style={S.btnGhost}
                    onClick={() => window.prompty.invoke("onboarding:open-external", { url: MIC_SETTINGS_URL })}
                  >
                    Open System Settings
                  </button>
                ) : (
                  <button style={S.btnAccent} onClick={grantMic}>
                    Grant microphone
                  </button>
                ))}
            </Setting>

            <Setting
              label="Claude Code"
              value={claude ? (claude.found ? claude.path ?? "found" : "not found") : "checking…"}
              tone={claude?.found ? "green" : claude ? "red" : "amber"}
            >
              <button style={S.btnGhost} onClick={refreshClaude}>
                Re-check
              </button>
            </Setting>
          </section>

          <section style={S.card}>
            <Setting label="Debug logging" value={debug ? "on" : "off"} tone="muted">
              <input type="checkbox" checked={debug} onChange={toggleDebug} />
            </Setting>
            <Setting label="Reveal debug logs" value="~/.prompty/debug" tone="muted">
              <button
                style={S.btnGhost}
                onClick={() => window.prompty.invoke("debug:reveal", undefined as never)}
              >
                Open folder
              </button>
            </Setting>
            <Setting label="Hotkey (ask)" value={hotkey} tone="muted" />
          </section>
        </>
      )}
    </div>
  );
}

function Setting(props: {
  label: string;
  value: string;
  tone: "green" | "red" | "amber" | "muted";
  children?: React.ReactNode;
}): JSX.Element {
  const toneColor =
    props.tone === "green"
      ? v("--green", "#46c46a")
      : props.tone === "red"
        ? v("--red", "#d05050")
        : props.tone === "amber"
          ? v("--amber", "#e0a23a")
          : v("--muted", "#9a9aa2");
  return (
    <div style={S.settingRow}>
      <div style={{ minWidth: 0 }}>
        <div style={S.settingLabel}>{props.label}</div>
        <div style={{ ...S.settingValue, color: toneColor }}>{props.value}</div>
      </div>
      <div style={S.settingControl}>{props.children}</div>
    </div>
  );
}

// The post-call card (RUBY_MVP decision #9): Recap / Insights & quotes (✦ marks
// Ruby-assisted ones) / Questions you didn't ask, plus one quiet stat line. Falls
// back to the raw JSON for older logs (or a call that never produced a summary).
function CallCard(props: { call: ParsedCall }): JSX.Element {
  const { title, summary, raw, attendee, startedAt, endedAt, summaryPending } = props.call;
  if (!summary) {
    if (summaryPending) {
      return (
        <div style={S.card2} data-testid="call-summarizing">
          <div style={S.summarizing}>
            <span className="mw-spinner" aria-hidden /> Summarizing this call…
          </div>
        </div>
      );
    }
    return (
      <div style={S.card2}>
        <div style={S.cardNote}>No summary card for this call — showing the raw log.</div>
        <pre style={S.pre}>{raw}</pre>
      </div>
    );
  }
  const name = title?.trim() || attendee?.name?.trim() || "Call";
  const mins =
    startedAt && endedAt && endedAt > startedAt
      ? Math.max(1, Math.round((endedAt - startedAt) / 60000))
      : null;
  return (
    <div style={S.card2} data-testid="call-card">
      <div style={S.receiptHead}>
        {name}
        {mins != null && <span style={S.receiptMeta}> · {mins} min</span>}
      </div>
      <section style={S.sec}>
        <div style={S.secHead}>Recap</div>
        <p style={S.recap}>{summary.recap}</p>
      </section>

      <section style={S.sec}>
        <div style={S.secHead}>Insights &amp; quotes</div>
        {summary.insights.length === 0 ? (
          <div style={S.cardNote}>Nothing notable surfaced.</div>
        ) : (
          <ul style={S.insightList}>
            {summary.insights.map((ins, i) => (
              <li key={i} style={S.insight}>
                <span style={ins.assisted ? S.checkOn : S.checkOff} aria-hidden>
                  {ins.assisted ? "✓" : "·"}
                </span>
                <span>
                  {ins.text}
                  {ins.assisted && ins.via && <span style={S.via}> — {ins.via}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={S.sec}>
        <div style={S.secHead}>Questions you didn't ask</div>
        {summary.questionsNotAsked.length === 0 ? (
          <div style={S.cardNote}>You picked up everything Ruby surfaced.</div>
        ) : (
          <ul style={S.qList}>
            {summary.questionsNotAsked.map((q, i) => (
              <li key={i} style={S.qItem}>{q.text}</li>
            ))}
          </ul>
        )}
      </section>

      <div style={S.stat} data-testid="call-stat">
        Ruby surfaced {summary.stat.surfaced}, you used {summary.stat.used}.
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: {
    font: v("--font", "14px system-ui, sans-serif"),
    color: v("--text", "#211d15"),
    background: v("--bg", "#faf7e9"),
    minHeight: "100vh",
    padding: "44px 32px 40px",
    boxSizing: "border-box",
    maxWidth: 760,
    margin: "0 auto",
  },
  header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, gap: 16 },
  title: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    fontFamily: v("--serif", "Georgia, serif"),
    fontSize: 26,
    fontWeight: 500,
    letterSpacing: "-0.015em",
    color: v("--ink", "#211d15"),
  },
  subtitle: { fontSize: 13, color: v("--muted", "#6e6757"), marginTop: 6 },
  nav: { display: "flex", gap: 4, flexShrink: 0 },
  navBtn: {
    padding: "6px 12px",
    fontSize: 13,
    color: v("--muted", "#9a9aa2"),
    background: "transparent",
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: 8,
    cursor: "pointer",
  },
  navBtnActive: { color: v("--text-strong", "#fff"), background: v("--surface-raised", "#2a2a32"), borderColor: v("--border-strong", "#3a3a44") },
  warn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 14px",
    marginBottom: 14,
    fontSize: 13,
    color: v("--amber", "#e0a23a"),
    background: "rgba(224,162,58,0.10)",
    border: `1px solid ${v("--amber", "#e0a23a")}`,
    borderRadius: 8,
  },
  card: {
    background: v("--surface", "#1e1e24"),
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: 12,
    padding: 18,
    marginBottom: 18,
  },
  label: { fontSize: 13, fontWeight: 600, color: v("--text-strong", "#fff") },
  textarea: {
    width: "100%",
    minHeight: 220,
    marginTop: 8,
    padding: 12,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    lineHeight: 1.5,
    color: v("--text", "#e8e8ea"),
    background: v("--surface-2", "#141418"),
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: 8,
    resize: "vertical",
    boxSizing: "border-box",
  },
  row: { display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" },
  live: { marginTop: 12, fontSize: 13, color: v("--green", "#46c46a"), display: "flex", alignItems: "center", gap: 8 },
  ending: { marginTop: 12, fontSize: 13, color: v("--gold", "#c98e2e"), display: "flex", alignItems: "center", gap: 8 },
  summarizing: { fontSize: 13, color: v("--gold", "#c98e2e"), display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: "50%", background: v("--green", "#46c46a"), display: "inline-block" },
  error: {
    marginTop: 12,
    padding: "10px 12px",
    fontSize: 13,
    color: v("--danger-text", "#ffb4b4"),
    background: "rgba(220,80,80,0.12)",
    border: `1px solid ${v("--red", "#d05050")}`,
    borderRadius: 8,
  },
  cardHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  empty: { fontSize: 13, color: v("--muted-dim", "#6a6a72") },
  memIntro: { fontSize: 13, lineHeight: 1.5, color: v("--muted", "#6e6757"), marginBottom: 14 },
  memAddRow: { display: "flex", gap: 10, marginBottom: 8 },
  memInput: {
    flex: 1,
    padding: "10px 12px",
    fontSize: 13,
    color: v("--ink", "#211d15"),
    background: v("--card", "#fff"),
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: 10,
    outline: "none",
    fontFamily: "inherit",
  },
  memRowWrap: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    borderRadius: 10,
  },
  memText: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.45, color: v("--ink", "#211d15") },
  prepSplit: { display: "flex", gap: 16, alignItems: "stretch" },
  prepRight: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  chatCard: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    background: v("--surface", "#fff"),
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: 12,
    padding: 18,
    marginBottom: 18,
  },
  chatHead: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  chatLog: {
    flex: 1,
    minHeight: 240,
    maxHeight: 360,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginBottom: 12,
  },
  bubbleUser: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    padding: "8px 12px",
    fontSize: 13,
    lineHeight: 1.45,
    color: "#fff",
    background: `linear-gradient(140deg, ${v("--ruby", "#d61f47")}, ${v("--ruby-deep", "#b01238")})`,
    borderRadius: "12px 12px 4px 12px",
    whiteSpace: "pre-wrap",
  },
  bubbleAsst: {
    alignSelf: "flex-start",
    maxWidth: "85%",
    padding: "8px 12px",
    fontSize: 13,
    lineHeight: 1.45,
    color: v("--ink", "#211d15"),
    background: v("--surface-2", "#f1ecd9"),
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: "12px 12px 12px 4px",
    whiteSpace: "pre-wrap",
  },
  chatInputRow: { display: "flex", gap: 8 },
  memTag: {
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: v("--gold", "#c98e2e"),
    border: `1px solid ${v("--gold", "#c98e2e")}`,
    borderRadius: 6,
    padding: "2px 6px",
  },
  list: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 },
  callRow: {
    width: "100%",
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "8px 10px",
    background: "transparent",
    border: "none",
    borderRadius: 6,
    color: v("--text", "#e8e8ea"),
    cursor: "pointer",
    textAlign: "left",
    fontSize: 13,
  },
  callName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  callDate: { color: v("--muted-dim", "#6a6a72"), flexShrink: 0 },
  callGroup: { marginTop: 6 },
  callDay: {
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: v("--ink-faint", "#a39a82"),
    margin: "14px 0 4px",
    paddingLeft: 4,
  },
  callRowWrap: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    borderRadius: 10,
  },
  callMain: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 10px",
    background: "transparent",
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    textAlign: "left",
    color: v("--ink", "#211d15"),
    font: "inherit",
  },
  callChevron: { flexShrink: 0, width: 10, fontSize: 11, color: v("--ink-faint", "#a39a82") },
  callTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  callMeta: { flexShrink: 0, fontSize: 12, color: v("--ink-faint", "#a39a82") },
  renameBtn: {
    flexShrink: 0,
    width: 32,
    height: 32,
    border: "none",
    background: "transparent",
    color: v("--ink-faint", "#a39a82"),
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 13,
  },
  renameInput: {
    flex: 1,
    padding: "9px 10px",
    fontSize: 14,
    fontWeight: 600,
    color: v("--ink", "#211d15"),
    background: v("--card", "#fff"),
    border: `1px solid ${v("--ruby", "#d61f47")}`,
    borderRadius: 10,
    outline: "none",
    fontFamily: "inherit",
  },
  pre: {
    margin: "4px 0 8px",
    padding: 12,
    maxHeight: 320,
    overflow: "auto",
    fontSize: 12,
    lineHeight: 1.45,
    color: v("--muted", "#bdbdc4"),
    background: v("--surface-2", "#141418"),
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: 8,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  card2: {
    margin: "4px 0 10px",
    padding: 16,
    background: v("--surface-2", "#141418"),
    border: `1px solid ${v("--border", "#2c2c34")}`,
    borderRadius: 10,
  },
  receiptHead: {
    fontFamily: v("--serif", "Georgia, serif"),
    fontSize: 19,
    fontWeight: 600,
    color: v("--ink", "#211d15"),
    marginBottom: 16,
  },
  receiptMeta: { color: v("--ink-faint", "#a39a82"), fontWeight: 400 },
  sec: { marginBottom: 16 },
  secHead: {
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: "0.13em",
    textTransform: "uppercase",
    color: v("--ruby", "#d61f47"),
    marginBottom: 8,
  },
  recap: { margin: 0, fontSize: 13, lineHeight: 1.55, color: v("--text", "#211d15") },
  insightList: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 },
  insight: {
    display: "flex",
    gap: 9,
    fontSize: 13,
    lineHeight: 1.5,
    color: v("--text", "#211d15"),
  },
  checkOn: { color: v("--ok", "#2e9e63"), flexShrink: 0, fontWeight: 800 },
  checkOff: { color: v("--ink-faint", "#a39a82"), flexShrink: 0, fontWeight: 700 },
  via: { color: v("--gold", "#c98e2e"), fontStyle: "italic" },
  qList: { listStyle: "disc", margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 },
  qItem: { fontSize: 13, lineHeight: 1.5, color: v("--text", "#e8e8ea") },
  cardNote: { fontSize: 13, color: v("--muted-dim", "#6a6a72") },
  stat: {
    marginTop: 4,
    paddingTop: 12,
    borderTop: `1px solid ${v("--border", "#2c2c34")}`,
    fontSize: 12,
    color: v("--muted", "#9a9aa2"),
  },
  settingRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    padding: "12px 0",
    borderBottom: `1px solid ${v("--border", "#2c2c34")}`,
  },
  settingLabel: { fontSize: 13, fontWeight: 600, color: v("--text-strong", "#fff") },
  settingValue: { fontSize: 12, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 420 },
  settingControl: { flexShrink: 0 },
  btnAccent: {
    padding: "9px 18px",
    fontSize: 13,
    fontWeight: 700,
    color: "#fff",
    background: `linear-gradient(140deg, ${v("--ruby", "#d61f47")}, ${v("--ruby-deep", "#b01238")})`,
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    boxShadow: "0 4px 14px rgba(214,31,71,0.28)",
  },
  btnDanger: {
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 600,
    color: "#fff",
    background: v("--red", "#d05050"),
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  },
  btnBusy: { opacity: 0.6, cursor: "default" },
  btnGhost: {
    padding: "8px 14px",
    fontSize: 13,
    color: v("--text", "#e8e8ea"),
    background: "transparent",
    border: `1px solid ${v("--border-strong", "#3a3a44")}`,
    borderRadius: 8,
    cursor: "pointer",
  },
  linkBtn: {
    padding: 0,
    fontSize: 13,
    color: v("--accent", "#5b7cfa"),
    background: "transparent",
    border: "none",
    cursor: "pointer",
  },
};
