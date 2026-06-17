import React, { useCallback, useEffect, useRef, useState } from "react";
import Gem from "../shared/Gem";
import RubyLogo from "./RubyLogo";
import DiamondShader from "./DiamondShader";
import "../shared/tokens.css";
import "./main-window.css";

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionState = "idle" | "starting" | "live" | "ending" | "ended" | "error";
type CallMeta = {
  name: string;
  mtimeMs: number;
  title: string;
  startedAt?: number;
  endedAt?: number;
  summaryPending?: boolean;
};
type Mem = { id: string; text: string; createdAt: number; source: "manual" | "suggested" };
type ChecklistItemR = { id: string; text: string; done: boolean };
type PrepComp =
  | { type: "goal"; id: string; text: string }
  | { type: "checklist"; id: string; title?: string; items: ChecklistItemR[] };
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
  components?: PrepComp[];
  summaryPending?: boolean;
  raw: string;
};
type Screen =
  | { id: "home" }
  | { id: "prep" }
  | { id: "live" }
  | { id: "post-call"; callName: string }
  | { id: "memory" }
  | { id: "settings" };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDur(start?: number, end?: number): string | null {
  if (!start || !end || end <= start) return null;
  return `${Math.max(1, Math.round((end - start) / 60000))} min`;
}

function dayGroupLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString([], opts).toUpperCase();
}

function groupCallsByDay(calls: CallMeta[]): { label: string; items: CallMeta[] }[] {
  const groups: { label: string; items: CallMeta[] }[] = [];
  for (const c of calls) {
    const label = dayGroupLabel(c.startedAt ?? c.mtimeMs);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(c);
    else groups.push({ label, items: [c] });
  }
  return groups;
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>({ id: "home" });

  // Shared state
  const [direction, setDirection] = useState("");
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hotkey, setHotkey] = useState("Alt+Shift+Space");
  const [calls, setCalls] = useState<CallMeta[]>([]);
  const [micStatus, setMicStatus] = useState<string | null>(null);
  const [claude, setClaude] = useState<{ found: boolean; path: string | null } | null>(null);
  const [memories, setMemories] = useState<Mem[]>([]);
  const [newMemory, setNewMemory] = useState("");
  const [editingMem, setEditingMem] = useState<{ id: string; draft: string } | null>(null);

  // Prep state
  const [prepMessages, setPrepMessages] = useState<{ role: "user" | "assistant"; text: string }[]>([]);
  const [prepInput, setPrepInput] = useState("");
  const [prepThinking, setPrepThinking] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [prepComponents, setPrepComponents] = useState<PrepComp[]>([]);
  const seeded = useRef(false);
  const prepInputRef = useRef<HTMLTextAreaElement>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const streamingRef = useRef(false);

  // Live timer
  const liveStartRef = useRef<number>(0);
  const [liveSeconds, setLiveSeconds] = useState(0);
  const isLive = sessionState === "starting" || sessionState === "live" || sessionState === "ending";
  const isEnding = sessionState === "ending";

  // ── Refreshers ──────────────────────────────────────────────────────────────

  const refreshCalls = useCallback(() => {
    window.prompty.invoke("calls:list", undefined as never).then((r) => setCalls(r.files)).catch(() => {});
  }, []);
  const refreshMic = useCallback(() => {
    window.prompty.invoke("onboarding:permission-status", undefined as never).then((p) => setMicStatus(p.microphone)).catch(() => {});
  }, []);
  const refreshClaude = useCallback(() => {
    window.prompty.invoke("onboarding:check-claude", undefined as never).then((r) => setClaude(r)).catch(() => {});
  }, []);
  const refreshMemories = useCallback(() => {
    window.prompty.invoke("memory:list", undefined as never).then((r) => setMemories(r.items)).catch(() => {});
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
          components: obj.components as PrepComp[] | undefined,
          summaryPending: obj.summaryPending as boolean | undefined,
          raw: JSON.stringify(obj, null, 2),
        };
      } catch {}
      return parsed;
    } catch { return null; }
  }, []);

  // ── Session ─────────────────────────────────────────────────────────────────

  const startCall = useCallback(async (dir: string) => {
    setError(null);
    if (!dir.trim()) { setError("Describe the call first."); return; }
    const r = await window.prompty.invoke("call:start", { direction: dir });
    if (!r.ok) {
      const pf = await window.prompty.invoke("preflight:get", undefined as never).catch(() => null);
      setError(pf?.message ?? r.error ?? "Couldn't start the call.");
      if (pf?.code === "mic") refreshMic();
    }
  }, [refreshMic]);

  const endCall = useCallback(() => {
    void window.prompty.invoke("call:end", undefined as never);
  }, []);

  // ── Prep ────────────────────────────────────────────────────────────────────

  const openPrep = useCallback(async (initialMessage: string) => {
    setPrepError(null);
    setPrepMessages([]);
    setPrepComponents([]);
    streamingRef.current = false;
    setDirection(initialMessage);
    const r = await window.prompty.invoke("prep:start", { direction: initialMessage });
    if (r.ok) {
      setPrepMessages([{ role: "user", text: initialMessage }]);
      void window.prompty.invoke("main:set-prep-layout", { wide: true });
      setScreen({ id: "prep" });
    } else {
      setPrepError("Couldn't start prep — is Claude Code installed?");
    }
  }, []);

  const sendPrep = useCallback(() => {
    const msg = prepInput.trim();
    if (!msg || prepThinking) return;
    setPrepInput("");
    if (prepInputRef.current) prepInputRef.current.style.height = "auto";
    streamingRef.current = false;
    setPrepMessages((m) => [...m, { role: "user", text: msg }]);
    void window.prompty.invoke("prep:send", { message: msg });
  }, [prepInput, prepThinking]);

  const closePrep = useCallback(() => {
    void window.prompty.invoke("prep:end", undefined as never);
    void window.prompty.invoke("main:set-prep-layout", { wide: false });
    setScreen({ id: "home" });
  }, []);

  const syncComponents = useCallback((next: PrepComp[]) => {
    setPrepComponents(next);
    void window.prompty.invoke("prep:set-components", { components: next as never });
  }, []);

  // ── Memory ──────────────────────────────────────────────────────────────────

  const addMemory = useCallback(() => {
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

  const deleteMemory = useCallback((id: string) => {
    void window.prompty.invoke("memory:delete", { id }).then((r) => {
      if (r.ok) setMemories((list) => list.filter((m) => m.id !== id));
    });
  }, []);

  // ── Auto-scroll prep chat ───────────────────────────────────────────────────

  useEffect(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [prepMessages, prepThinking]);

  // ── Live timer ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isLive) { setLiveSeconds(0); liveStartRef.current = 0; return; }
    if (liveStartRef.current === 0) liveStartRef.current = Date.now();
    const id = setInterval(() => setLiveSeconds(Math.floor((Date.now() - liveStartRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [isLive]);

  // ── Session auto-navigate ───────────────────────────────────────────────────

  useEffect(() => {
    if (sessionState === "starting" || sessionState === "live") setScreen({ id: "live" });
    if (sessionState === "ended") { setScreen({ id: "home" }); refreshCalls(); }
  }, [sessionState, refreshCalls]);

  // ── IPC setup ───────────────────────────────────────────────────────────────

  useEffect(() => {
    window.prompty.invoke("session:state", undefined as never).then((r) => {
      setSessionState(r.state);
      if (!seeded.current && r.setup?.direction) { setDirection(r.setup.direction); seeded.current = true; }
    }).catch(() => {});
    window.prompty.invoke("settings:get", undefined as never).then((s: { hotkey?: string }) => {
      if (s.hotkey) setHotkey(s.hotkey);
    }).catch(() => {});
    window.prompty.invoke("preflight:get", undefined as never).then((pf) => pf && setError(pf.message)).catch(() => {});
    refreshCalls(); refreshMic(); refreshClaude(); refreshMemories();

    const offState = window.prompty.on("session:state-changed", (p) => {
      setSessionState(p.state);
      if (p.state === "ended" || p.state === "idle") refreshCalls();
    });
    const offPf = window.prompty.on("preflight:failed", (p) => {
      setError(p.message);
      if (p.code === "mic") refreshMic();
    });
    const offCallsUpdated = window.prompty.on("calls:updated", () => refreshCalls());
    const offPrepDelta = window.prompty.on("prep:assistant-delta", (p) => {
      setPrepThinking(false);
      setPrepMessages((m) => {
        const last = m[m.length - 1];
        if (streamingRef.current && last?.role === "assistant")
          return [...m.slice(0, -1), { ...last, text: last.text + p.text }];
        streamingRef.current = true;
        return [...m, { role: "assistant", text: p.text }];
      });
    });
    const offPrepAsst = window.prompty.on("prep:assistant", (p) => {
      setPrepMessages((m) => {
        const last = m[m.length - 1];
        if (streamingRef.current && last?.role === "assistant")
          return [...m.slice(0, -1), { ...last, text: p.text }];
        return [...m, { role: "assistant", text: p.text }];
      });
      streamingRef.current = false;
    });
    const offPrepDir = window.prompty.on("prep:direction", (p) => { setDirection(p.direction); seeded.current = true; });
    const offPrepThinking = window.prompty.on("prep:thinking", (p) => setPrepThinking(p.thinking));
    const offPrepError = window.prompty.on("prep:error", (p) => setPrepError(p.message));
    const offPrepComps = window.prompty.on("prep:components", (p) => setPrepComponents(p.components as PrepComp[]));

    return () => {
      offState(); offPf(); offCallsUpdated(); offPrepDelta(); offPrepAsst();
      offPrepDir(); offPrepThinking(); offPrepError(); offPrepComps();
    };
  }, [refreshCalls, refreshMic, refreshClaude, refreshMemories]);

  // ── Routing ──────────────────────────────────────────────────────────────────

  if (screen.id === "live") {
    const mm = String(Math.floor(liveSeconds / 60)).padStart(2, "0");
    const ss = String(liveSeconds % 60).padStart(2, "0");
    return (
      <LiveScreen
        timer={`${mm}:${ss}`}
        isEnding={isEnding}
        direction={direction}
        prepComponents={prepComponents}
        onEnd={endCall}
      />
    );
  }

  if (screen.id === "prep") {
    return (
      <PrepScreen
        direction={direction}
        setDirection={setDirection}
        prepMessages={prepMessages}
        prepThinking={prepThinking}
        prepError={prepError}
        prepInput={prepInput}
        setPrepInput={setPrepInput}
        prepInputRef={prepInputRef}
        chatLogRef={chatLogRef}
        prepComponents={prepComponents}
        syncComponents={syncComponents}
        sendPrep={sendPrep}
        onClose={closePrep}
        onBeginCall={() => startCall(direction)}
        error={error}
      />
    );
  }

  if (screen.id === "post-call") {
    return (
      <PostCallScreen
        callName={screen.callName}
        readCall={readCall}
        onBack={() => setScreen({ id: "home" })}
        setMemories={setMemories}
      />
    );
  }

  if (screen.id === "memory") {
    return (
      <MemoryScreen
        memories={memories}
        newMemory={newMemory}
        setNewMemory={setNewMemory}
        editingMem={editingMem}
        setEditingMem={setEditingMem}
        addMemory={addMemory}
        saveMemoryEdit={saveMemoryEdit}
        deleteMemory={deleteMemory}
        onBack={() => setScreen({ id: "home" })}
      />
    );
  }

  if (screen.id === "settings") {
    return (
      <SettingsScreen
        micStatus={micStatus}
        claude={claude}
        hotkey={hotkey}
        refreshMic={refreshMic}
        refreshClaude={refreshClaude}
        onBack={() => setScreen({ id: "home" })}
      />
    );
  }

  return (
    <HomeScreen
      calls={calls}
      isLive={isLive}
      isEnding={isEnding}
      error={error}
      onSend={openPrep}
      onViewCall={(name) => setScreen({ id: "post-call", callName: name })}
      onMemory={() => setScreen({ id: "memory" })}
      onSettings={() => setScreen({ id: "settings" })}
      onEndCall={endCall}
    />
  );
}

// ─── Home screen ──────────────────────────────────────────────────────────────

function HomeScreen(props: {
  calls: CallMeta[];
  isLive: boolean;
  isEnding: boolean;
  error: string | null;
  onSend: (message: string) => void;
  onViewCall: (name: string) => void;
  onMemory: () => void;
  onSettings: () => void;
  onEndCall: () => void;
}): JSX.Element {
  const { calls, isLive, isEnding, error, onSend, onViewCall, onMemory, onSettings, onEndCall } = props;
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    const msg = input.trim();
    if (!msg) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    onSend(msg);
  };

  const groups = groupCallsByDay(calls);

  return (
    <div className="home-root">
      <div className="app-dragbar" />

      {/* Topbar */}
      <header className="home-topbar app-drag">
        <div className="home-brand">
          <Gem variant="mini" size={20} />
          <span className="home-wordmark">Prompty</span>
        </div>
        <div className="home-topbar-actions app-no-drag">
          {isLive && (
            <button
              className={`home-live-btn${isEnding ? " busy" : ""}`}
              onClick={onEndCall}
              disabled={isEnding}
            >
              <span className="home-live-dot" />
              {isEnding ? "Ending…" : "End call"}
            </button>
          )}
          <button className="home-icon-btn" onClick={onMemory} title="Memory" aria-label="Memory">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <circle cx="7.5" cy="5" r="3.25" stroke="currentColor" strokeWidth="1.25"/>
              <path d="M1.5 13.5c0-3.314 2.686-5 6-5s6 1.686 6 5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
            </svg>
          </button>
          <button className="home-icon-btn" onClick={onSettings} title="Settings" aria-label="Settings">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <circle cx="7.5" cy="7.5" r="2.25" stroke="currentColor" strokeWidth="1.25"/>
              <path d="M7.5 1v1.5M7.5 12.5V14M1 7.5h1.5M12.5 7.5H14M3.05 3.05l1.06 1.06M10.89 10.89l1.06 1.06M10.89 4.11l1.06-1.06M3.05 11.95l1.06-1.06" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </header>

      {/* Scrollable body */}
      <div className="home-body">

        <div className="home-chat-bg">
        <DiamondShader />
        <div className="home-chat-container">
          <div className="home-logo"><RubyLogo size={52} /></div>
          <h2 className="home-section-heading">Your next call</h2>

          {/* Chat input bar */}
          <div className={`home-bar${focused ? " focused" : ""}`}>
            <div className="home-bar-bottom">
            <textarea
              ref={textareaRef}
              className="home-bar-input"
              value={input}
              rows={2}
              placeholder="Who's this call with? What's it about?"
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.target;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
              }}
            />
            <button
              className="home-bar-send"
              onClick={handleSend}
              disabled={!input.trim()}
              aria-label="Send"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 12V2M7 2L2.5 6.5M7 2L11.5 6.5" stroke="white" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            </div>
          </div>
        </div>
        </div>

        {error && <div className="home-error">{error}</div>}

        {/* Past calls list */}
        {calls.length === 0 ? (
          <div className="home-empty">No calls yet — start one above.</div>
        ) : (
          <div className="home-calls">
            {groups.map((group) => (
              <div key={group.label} className="home-day-group">
                <div className="home-day-label">
                  <span className="home-day-text">{group.label}</span>
                  <span className="home-day-line" />
                </div>
                <ul className="home-call-list">
                  {group.items.map((c) => {
                    const when = c.startedAt ?? c.mtimeMs;
                    const prepped = false; // future: detect from call components
                    return (
                      <li key={c.name}>
                        <button
                          className="home-call-row"
                          onClick={() => onViewCall(c.name)}
                        >
                          <span className={`home-call-dot${prepped ? " prepped" : ""}`} />
                          <span className="home-call-title">{c.title || "Untitled call"}</span>
                          <span className="home-call-time">{fmtClock(when)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Prep screen ──────────────────────────────────────────────────────────────

function PrepScreen(props: {
  direction: string;
  setDirection: (d: string) => void;
  prepMessages: { role: "user" | "assistant"; text: string }[];
  prepThinking: boolean;
  prepError: string | null;
  prepInput: string;
  setPrepInput: (v: string) => void;
  prepInputRef: React.RefObject<HTMLTextAreaElement>;
  chatLogRef: React.RefObject<HTMLDivElement>;
  prepComponents: PrepComp[];
  syncComponents: (next: PrepComp[]) => void;
  sendPrep: () => void;
  onClose: () => void;
  onBeginCall: () => void;
  error: string | null;
}): JSX.Element {
  const {
    direction, setDirection, prepMessages, prepThinking, prepError,
    prepInput, setPrepInput, prepInputRef, chatLogRef, prepComponents, syncComponents,
    sendPrep, onClose, onBeginCall, error,
  } = props;

  const editGoal = (id: string, text: string) =>
    syncComponents(prepComponents.map((c) => (c.id === id && c.type === "goal" ? { ...c, text } : c)));
  const editItem = (cid: string, iid: string, text: string) =>
    syncComponents(prepComponents.map((c) =>
      c.id === cid && c.type === "checklist"
        ? { ...c, items: c.items.map((it) => (it.id === iid ? { ...it, text } : it)) }
        : c,
    ));
  const deleteItem = (cid: string, iid: string) =>
    syncComponents(prepComponents.map((c) =>
      c.id === cid && c.type === "checklist"
        ? { ...c, items: c.items.filter((it) => it.id !== iid) }
        : c,
    ));
  const addItem = (cid: string) =>
    syncComponents(prepComponents.map((c) =>
      c.id === cid && c.type === "checklist"
        ? { ...c, items: [...c.items, { id: `it_${Date.now()}`, text: "", done: false }] }
        : c,
    ));
  const deleteComponent = (id: string) => syncComponents(prepComponents.filter((c) => c.id !== id));

  const [sidebarWidth, setSidebarWidth] = React.useState(400);
  const dragging = React.useRef(false);

  const onHandleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const bodyW = document.body.clientWidth;
      const newW = Math.min(600, Math.max(280, bodyW - ev.clientX));
      setSidebarWidth(newW);
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="prep-root">
      <div className="app-dragbar" />

      {error && <div className="prep-error-banner">{error}</div>}
      <div className="prep-body">
        <section className="prep-chat-col">
          <div className="prep-chat-toprow">
            <button className="prep-back app-no-drag" onClick={onClose}>← Back</button>
            <div className="prep-chat-label"><span className="prep-chat-dot" />Prep with Ruby</div>
          </div>
          <div className="prep-chat-log" ref={chatLogRef}>
            {prepMessages.length === 0 && !prepThinking
              ? <div className="prep-chat-empty">Tell Ruby about the call you're about to have.</div>
              : prepMessages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "prep-bubble-user" : "prep-bubble-asst"}>{m.text}</div>
              ))}
            {prepThinking && <div className="prep-bubble-asst prep-thinking">…</div>}
          </div>
          {prepError && <div className="prep-chat-error">{prepError}</div>}
          <div className="prep-chat-input-row">
            <div className="prep-chat-input-bar">
              <textarea
                ref={prepInputRef}
                className="prep-chat-input"
                value={prepInput}
                rows={1}
                placeholder="Message Ruby…  (Enter to send · Shift+Enter for new line)"
                onChange={(e) => {
                  setPrepInput(e.target.value);
                  const el = e.target;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrep(); } }}
              />
              <button className="prep-send-btn" onClick={sendPrep} disabled={!prepInput.trim() || prepThinking}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
              </button>
            </div>
          </div>
        </section>
        <div className="prep-resize-handle" onMouseDown={onHandleMouseDown} />
        <aside className="prep-panel" style={{ flexBasis: sidebarWidth, minWidth: 280, maxWidth: 600 }}>
          <div className="prep-panel-body">
          <div className="prep-sticky-note">
            <svg className="prep-sticky-pin" width="20" height="20" viewBox="0 0 522 516" fill="none" xmlns="http://www.w3.org/2000/svg">
              <g clipPath="url(#clip0_1681_7856)">
                <mask id="mask0_1681_7856" style={{maskType:"alpha"}} maskUnits="userSpaceOnUse" x="-37" y="-45" width="597" height="573">
                  <path d="M-36.3779 -44.4694L559.747 -44.4694L559.747 527.061L-36.3789 527.061L-36.3779 -44.4694ZM40.0918 419.951L201.535 395.776L218.482 387.718L430.768 197.904L362.087 103.892L262.188 125.38L40.0918 307.136L40.0918 419.951Z" fill="#D9D9D9"/>
                </mask>
                <g mask="url(#mask0_1681_7856)">
                  <path d="M480.608 46.475C430.437 -11.4802 353.471 -15.3839 293.514 36.9516L86.5901 217.509C82.9148 220.684 105.949 247.28 109.624 244.063L316.548 63.5055C354.069 30.7743 411.206 19.9211 454.155 69.5541C482.831 102.671 493.685 155.35 438.087 203.868L171.804 436.246C140.394 463.658 85.1371 486.565 49.8806 445.898C11.7181 401.842 57.4874 353.539 78.9405 334.835L238.727 195.46C259.326 177.485 302.787 160.112 317.616 174.997C332.445 189.883 345.779 220.298 300.522 265.769L203.898 351.093C200.693 353.925 223.043 381.079 227.061 377.519L323.685 292.195C353.728 265.598 397.36 213.262 352.531 161.484C318.471 122.147 266.035 124.978 215.736 168.863L55.9489 308.238C-4.35037 360.917 -16.829 422.519 23.4275 469.02C65.0515 517.109 133.043 516.765 188.727 468.162L461.121 230.464C522.061 177.314 529.882 103.358 480.608 46.475Z" fill="#E453D5"/>
                  <path d="M284.197 163.243C262.061 163.243 241.12 176.971 228.684 187.824L68.9404 327.242C51.4617 342.557 32.8292 364.263 31.2053 392.104C29.0685 429.039 50.778 447.786 47.701 443.71C13.7266 398.539 57.4874 353.539 78.9405 334.835L238.727 195.46C266.847 173.11 297.274 165.474 314.625 172.638C314.582 172.638 307.488 163.243 284.197 163.243Z" fill="#80117A"/>
                  <path d="M428.429 47.6333C388.172 16.7468 339.369 27.2568 306.505 55.9556C306.505 55.9556 99.4106 237.157 99.026 237.157C103 240.932 107.958 245.479 109.197 244.363L316.548 63.5914C344.283 39.354 389.924 23.7392 428.429 47.6333Z" fill="#80117A"/>
                  <path d="M187.531 469.192L461.121 230.465C526.121 171.694 527.702 101.17 478.429 44.2874C468.856 33.2197 477.531 43.6868 480.053 47.1615C520.096 102.457 508.429 172.853 451.078 222.872L178.684 460.569C132.83 500.593 78.5986 507.843 37.6156 482.233C77.8294 516.036 138.642 511.875 187.531 469.192Z" fill="#80117A"/>
                  <path d="M350.351 159.297C343.984 152.219 337.317 147.285 329.967 142.91C334.369 146.342 338.514 149.344 342.488 153.892C387.36 205.67 343.685 258.005 313.642 284.602L216.505 370.87C216.505 370.87 224.625 380.093 227.36 377.304L334.753 281.728C363.087 253.286 392.873 206.485 350.351 159.297Z" fill="#80117A"/>
                  <path d="M122.146 482.404C108.342 490.726 89.026 491.027 76.59 488.582C56.7609 484.635 39.7951 476.055 27.1455 460.312C11.248 440.45 2.7864 410.121 9.7095 382.624C9.7095 382.624 12.1454 372.156 19.1112 373.787C26.0771 375.417 23.3848 391.975 23.3848 391.975C19.9232 408.062 23.983 435.259 37.4019 451.99C46.2053 462.971 58.4703 471.465 72.0601 475.412C109.112 486.136 140.052 471.637 122.146 482.404Z" fill="#EAB9E9"/>
                  <path d="M459.241 39.3542C468.301 48.5773 474.583 58.8728 471.036 64.7069C469.283 67.624 463.984 66.766 459.497 62.0901C448.813 50.8509 437.403 41.9281 434.112 39.7832C399.198 16.8328 376.976 17.5192 345.351 25.0263C336.762 27.0425 335.992 22.9672 339.924 19.8356C345.736 15.2027 359.24 12.543 365.352 11.5563C424.668 2.20458 455.138 35.1502 459.241 39.3542Z" fill="#EAB9E9"/>
                  <path d="M335.095 162.042C348.087 177.657 335.779 187.095 326.975 178.815C315.651 168.134 301.676 147.843 261.291 161.227C254.582 163.458 247.873 160.498 258.984 154.321C295.821 133.858 322.104 146.427 335.095 162.042Z" fill="#EAB9E9"/>
                </g>
              </g>
              <defs>
                <clipPath id="clip0_1681_7856">
                  <rect width="516" height="522" fill="white" transform="translate(2.25551e-05 516) rotate(-90)"/>
                </clipPath>
              </defs>
            </svg>
            <div className="prep-sticky-label">Note to Ruby</div>
            <textarea
              className="prep-direction-input"
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              placeholder="What a good call looks like…"
              spellCheck={false}
              rows={1}
            />
          </div>

          {prepComponents.length > 0 && (
            <div className="prep-components">
              {prepComponents.map((c) =>
                c.type === "goal" ? (
                  <div key={c.id} className="prep-comp-block">
                    <div className="prep-comp-head">
                      <span className="prep-comp-kind">Goal</span>
                      <button className="prep-comp-del" onClick={() => deleteComponent(c.id)}>✕</button>
                    </div>
                    <textarea className="prep-comp-goal-input" value={c.text} rows={2}
                      placeholder="The one outcome that makes this call a success…"
                      onChange={(e) => editGoal(c.id, e.target.value)} />
                  </div>
                ) : (
                  <div key={c.id} className="prep-comp-block">
                    <div className="prep-comp-head">
                      <span className="prep-comp-kind">{c.title?.trim() || "Checklist"}</span>
                      <button className="prep-comp-del" onClick={() => deleteComponent(c.id)}>✕</button>
                    </div>
                    <ul className="prep-comp-list">
                      {c.items.map((it) => (
                        <li key={it.id} className="prep-comp-item">
                          <span className="prep-comp-dot">○</span>
                          <input className="prep-comp-item-input" value={it.text}
                            onChange={(e) => editItem(c.id, it.id, e.target.value)} />
                          <button className="prep-comp-del" onClick={() => deleteItem(c.id, it.id)}>✕</button>
                        </li>
                      ))}
                    </ul>
                    <button className="prep-add-item" onClick={() => addItem(c.id)}>+ Add item</button>
                  </div>
                ),
              )}
            </div>
          )}
          {prepComponents.length === 0 && (
            <>
              <div className="prep-panel-hints">
                <div className="prep-hint-item">Goal will appear here</div>
                <div className="prep-hint-item">Checklist will appear here</div>
              </div>
            </>
          )}
          </div>
          <div className="prep-panel-begin">
            <button className="prep-begin-btn" onClick={onBeginCall}>Start listening</button>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── Live screen ─────────────────────────────────────────────────────────────

function LiveScreen(props: {
  timer: string;
  isEnding: boolean;
  direction: string;
  prepComponents: PrepComp[];
  onEnd: () => void;
}): JSX.Element {
  const { timer, isEnding, direction, prepComponents, onEnd } = props;
  const goal = prepComponents.find((c) => c.type === "goal") as { type: "goal"; id: string; text: string } | undefined;
  const checklist = prepComponents.find((c) => c.type === "checklist") as { type: "checklist"; id: string; title?: string; items: ChecklistItemR[] } | undefined;

  return (
    <div className="live-root">
      <header className="live-topbar">
        <div className="live-topbar-left">
          <span className="live-pulse" />
          <span className="live-label">Live</span>
        </div>
        <div className="live-timer">{timer}</div>
        <button className={`live-end-btn${isEnding ? " busy" : ""}`} onClick={onEnd} disabled={isEnding}>
          {isEnding ? "Ending…" : "End session"}
        </button>
      </header>
      <div className="live-body">
        <div className="live-left">
          {goal && (
            <div className="live-goal-pill">
              <span className="live-goal-label">Goal</span>
              <span className="live-goal-text">{goal.text}</span>
            </div>
          )}
          {checklist && checklist.items.length > 0 && (
            <div className="live-checklist-card">
              <div className="live-card-label">{checklist.title || "Checklist"}</div>
              <ul className="live-checklist">
                {checklist.items.map((it) => (
                  <li key={it.id} className={`live-check-item${it.done ? " done" : ""}`}>
                    <span className="live-check-glyph">{it.done ? "✓" : "○"}</span>
                    <span>{it.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!goal && !checklist && (
            <div className="live-direction-card">
              <div className="live-card-label">Direction</div>
              <div className="live-direction-text">{direction || "No direction set."}</div>
            </div>
          )}
          <div className="live-overlay-note">Ruby is coaching you via the floating overlay.</div>
        </div>
        <div className="live-right">
          <div className="live-card-label">Transcript</div>
          <div className="live-transcript-empty">Transcript appears here during the call.</div>
        </div>
      </div>
      <div className="live-teleprompter">
        <span className="live-tp-label">Ruby says</span>
        <span className="live-tp-text">Listening…</span>
      </div>
    </div>
  );
}

// ─── Post-call screen ─────────────────────────────────────────────────────────

function PostCallScreen(props: {
  callName: string;
  readCall: (name: string) => Promise<ParsedCall | null>;
  onBack: () => void;
  setMemories: React.Dispatch<React.SetStateAction<Mem[]>>;
}): JSX.Element {
  const { callName, readCall, onBack, setMemories } = props;
  const [call, setCall] = useState<ParsedCall | null>(null);
  const [loading, setLoading] = useState(true);
  const [suggestSaved, setSuggestSaved] = useState(false);

  useEffect(() => {
    setLoading(true);
    readCall(callName).then((c) => { setCall(c); setLoading(false); });
  }, [callName, readCall]);

  const saveMemory = (text: string) => {
    void window.prompty.invoke("memory:add", { text }).then((r) => {
      if (r.item) setMemories((list) => [...list, r.item as Mem]);
      setSuggestSaved(true);
    });
  };

  const title = call?.title || call?.attendee?.name || "Call";
  const mins = call?.startedAt && call?.endedAt && call.endedAt > call.startedAt
    ? Math.max(1, Math.round((call.endedAt - call.startedAt) / 60000)) : null;
  const summary = call?.summary;

  return (
    <div className="pcs-root">
      <div className="app-dragbar" />
      <div className="pcs-body">
        <div className="pcs-toprow app-drag">
          <button className="pcs-back app-no-drag" onClick={onBack}>← Back</button>
        </div>
        {loading ? (
          <div className="pcs-loading">Loading…</div>
        ) : !call ? (
          <div className="pcs-loading">Couldn't load this call.</div>
        ) : call.summaryPending ? (
          <div className="pcs-loading"><span className="mw-spinner" /> Summarizing…</div>
        ) : !summary ? (
          <>
            <div className="pcs-title">{title}</div>
            {mins && <div className="pcs-meta">{mins} min</div>}
            <pre className="pcs-raw">{call.raw}</pre>
          </>
        ) : (
          <>
            <div className="pcs-hero">
              {call.attendee?.company && (
                <div className="pcs-hero-company">{call.attendee.company}</div>
              )}
              <h1 className="pcs-title">{title}</h1>
              <div className="pcs-meta-row">
                {mins && <span className="pcs-meta-chip">{mins} min</span>}
                {call.startedAt && (
                  <span className="pcs-meta-chip">
                    {new Date(call.startedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                  </span>
                )}
              </div>
            </div>

            <div className="pcs-stats">
              <div className="pcs-stat-card">
                <div className="pcs-stat-num">{summary.stat.surfaced}</div>
                <div className="pcs-stat-label">Nudges surfaced</div>
              </div>
              <div className="pcs-stat-card">
                <div className="pcs-stat-num">{summary.stat.used}</div>
                <div className="pcs-stat-label">Used by you</div>
              </div>
              <div className="pcs-stat-card">
                <div className="pcs-stat-num">{(() => {
                  const cl = call.components?.find((c) => c.type === "checklist") as { items: ChecklistItemR[] } | undefined;
                  if (!cl || cl.items.length === 0) return "—";
                  return `${cl.items.filter((it) => it.done).length}/${cl.items.length}`;
                })()}</div>
                <div className="pcs-stat-label">Checklist done</div>
              </div>
            </div>

            <div className="pcs-section">
              <div className="pcs-section-label">Recap</div>
              <p className="pcs-recap">{summary.recap}</p>
            </div>

            {summary.insights.length > 0 && (
              <div className="pcs-section">
                <div className="pcs-section-label">Insights &amp; quotes</div>
                <ul className="pcs-insight-list">
                  {summary.insights.map((ins, i) => (
                    <li key={i} className="pcs-insight-item">
                      <p className="pcs-insight-text">{ins.text}</p>
                      {ins.assisted && (
                        <span className="pcs-assisted-pill">✓ {ins.via || "Ruby"}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {summary.questionsNotAsked.length > 0 && (
              <div className="pcs-section">
                <div className="pcs-section-label pcs-label-missed">Questions you didn't ask</div>
                <ul className="pcs-q-list">
                  {summary.questionsNotAsked.map((q, i) => (
                    <li key={i} className="pcs-q-item">
                      <span className="pcs-q-mark">?</span>
                      <span className="pcs-q-text">{q.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!suggestSaved && summary.insights.length > 0 && (
              <div className="pcs-memory-card">
                <div className="pcs-memory-icon">
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <path d="M9 2.5L10.3 6.4H14.5L11.1 8.8L12.4 12.7L9 10.3L5.6 12.7L6.9 8.8L3.5 6.4H7.7L9 2.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round"/>
                  </svg>
                </div>
                <div className="pcs-memory-content">
                  <div className="pcs-memory-title">Save to memory</div>
                  <div className="pcs-memory-desc">Ruby will apply this coaching preference to future calls.</div>
                </div>
                <button className="pcs-memory-btn" onClick={() => saveMemory(`Based on "${title}": ${summary.insights[0].text}`)}>
                  Save
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Memory screen ────────────────────────────────────────────────────────────

function MemoryScreen(props: {
  memories: Mem[];
  newMemory: string;
  setNewMemory: (v: string) => void;
  editingMem: { id: string; draft: string } | null;
  setEditingMem: (v: { id: string; draft: string } | null) => void;
  addMemory: () => void;
  saveMemoryEdit: () => void;
  deleteMemory: (id: string) => void;
  onBack: () => void;
}): JSX.Element {
  const { memories, newMemory, setNewMemory, editingMem, setEditingMem, addMemory, saveMemoryEdit, deleteMemory, onBack } = props;
  return (
    <div className="fullscreen-root">
      <div className="app-dragbar" />
      <header className="fullscreen-topbar app-drag">
        <button className="fullscreen-back app-no-drag" onClick={onBack}>← Back</button>
        <span className="fullscreen-title">Memory</span>
        <span />
      </header>
      <div className="fullscreen-body">
        <p className="fullscreen-intro">Tell Ruby how to coach you. These apply to every call.</p>
        <div className="mem-add-row">
          <input className="mem-input" value={newMemory} placeholder="e.g. Nudge me rarely — only when it really matters."
            onChange={(e) => setNewMemory(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addMemory(); }} />
          <button className="mem-add-btn" onClick={addMemory} disabled={!newMemory.trim()}>Add</button>
        </div>
        {memories.length === 0
          ? <div className="fullscreen-empty">No memories yet.</div>
          : <ul className="mem-list">{memories.map((m) => {
            const isEdit = editingMem?.id === m.id;
            return (
              <li key={m.id} className="mem-item">
                {isEdit ? (
                  <input autoFocus className="mem-edit-input" value={editingMem.draft}
                    onChange={(e) => setEditingMem({ id: m.id, draft: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") saveMemoryEdit(); if (e.key === "Escape") setEditingMem(null); }}
                    onBlur={saveMemoryEdit} />
                ) : (
                  <>
                    <span className="mem-text">{m.text}</span>
                    {m.source === "suggested" && <span className="mem-tag">suggested</span>}
                    <button className="mem-action-btn" onClick={() => setEditingMem({ id: m.id, draft: m.text })}>✎</button>
                    <button className="mem-action-btn" onClick={() => deleteMemory(m.id)}>✕</button>
                  </>
                )}
              </li>
            );
          })}</ul>}
      </div>
    </div>
  );
}

// ─── Settings screen ──────────────────────────────────────────────────────────

const MIC_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

function SettingsScreen(props: {
  micStatus: string | null;
  claude: { found: boolean; path: string | null } | null;
  hotkey: string;
  refreshMic: () => void;
  refreshClaude: () => void;
  onBack: () => void;
}): JSX.Element {
  const { micStatus, claude, hotkey, refreshMic, refreshClaude, onBack } = props;
  const micOk = micStatus === "granted";
  const micBlocked = micStatus === "denied" || micStatus === "restricted";
  return (
    <div className="fullscreen-root">
      <div className="app-dragbar" />
      <header className="fullscreen-topbar app-drag">
        <button className="fullscreen-back app-no-drag" onClick={onBack}>← Back</button>
        <span className="fullscreen-title">Settings</span>
        <span />
      </header>
      <div className="fullscreen-body">
        <div className="set-group">
          <SettingRow label="Microphone" value={micStatus ?? "checking…"} tone={micOk ? "green" : micBlocked ? "red" : "amber"}>
            {!micOk && (micBlocked
              ? <button className="set-btn" onClick={() => window.prompty.invoke("onboarding:open-external", { url: MIC_SETTINGS_URL })}>Open System Settings</button>
              : <button className="set-btn set-btn-accent" onClick={() => { window.prompty.invoke("onboarding:request-mic", undefined as never).catch(() => {}); refreshMic(); }}>Grant access</button>
            )}
          </SettingRow>
          <SettingRow label="Claude Code" value={claude ? (claude.found ? claude.path ?? "found" : "not found") : "checking…"} tone={claude?.found ? "green" : claude ? "red" : "amber"}>
            <button className="set-btn" onClick={refreshClaude}>Re-check</button>
          </SettingRow>
        </div>
        <div className="set-group">
          <SettingRow label="Hotkey (ask)" value={hotkey} tone="muted" />
          <SettingRow label="Debug logs" value="~/.prompty/debug" tone="muted">
            <button className="set-btn" onClick={() => window.prompty.invoke("debug:reveal", undefined as never)}>Open folder</button>
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function SettingRow(props: { label: string; value: string; tone: "green" | "red" | "amber" | "muted"; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="set-row">
      <div className="set-row-main">
        <div className="set-label">{props.label}</div>
        <div className={`set-val set-val-${props.tone}`}>{props.value}</div>
      </div>
      {props.children && <div className="set-control">{props.children}</div>}
    </div>
  );
}
