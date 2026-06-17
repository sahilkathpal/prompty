import React, { useCallback, useEffect, useRef, useState } from "react";
import Gem from "../shared/Gem";
import RubyLogo from "./RubyLogo";
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

  return (
    <div className="prep-root">
      <div className="app-dragbar" />
      <header className="prep-topbar app-drag">
        <button className="prep-back app-no-drag" onClick={onClose}>← Back</button>
        <span className="prep-topbar-title">Prep with Ruby</span>
        <button className="prep-begin-btn app-no-drag" onClick={onBeginCall}>Begin call →</button>
      </header>
      {error && <div className="prep-error-banner">{error}</div>}
      <div className="prep-body">
        <section className="prep-chat-col">
          <div className="prep-chat-label"><span className="prep-chat-dot" />Prep with Ruby</div>
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
            <button className="prep-send-btn" onClick={sendPrep} disabled={!prepInput.trim() || prepThinking}>Send</button>
          </div>
        </section>
        <aside className="prep-panel">
          <div className="prep-panel-label">Direction</div>
          <textarea
            className="prep-direction-input"
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            placeholder="What a good call looks like…"
            spellCheck={false}
          />
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
            <div className="prep-panel-hints">
              <div className="prep-hint-item">Goal will appear here</div>
              <div className="prep-hint-item">Checklist will appear here</div>
            </div>
          )}
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
      <header className="pcs-topbar app-drag">
        <button className="pcs-back app-no-drag" onClick={onBack}>← Back</button>
        <span className="pcs-topbar-title">{loading ? "Loading…" : title}</span>
        <span />
      </header>
      <div className="pcs-body">
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
            <div className="pcs-title">{title}</div>
            {mins && <div className="pcs-meta">{mins} min</div>}
            <div className="pcs-stats">
              <div className="pcs-stat-card"><div className="pcs-stat-num">{summary.stat.surfaced}</div><div className="pcs-stat-label">Nudges surfaced</div></div>
              <div className="pcs-stat-card"><div className="pcs-stat-num">{summary.stat.used}</div><div className="pcs-stat-label">Nudges used</div></div>
              <div className="pcs-stat-card">
                <div className="pcs-stat-num">{(() => {
                  const cl = call.components?.find((c) => c.type === "checklist") as { items: ChecklistItemR[] } | undefined;
                  if (!cl || cl.items.length === 0) return "—";
                  return `${cl.items.filter((it) => it.done).length}/${cl.items.length}`;
                })()}</div>
                <div className="pcs-stat-label">Checklist</div>
              </div>
            </div>
            <div className="pcs-section"><div className="pcs-section-label">Recap</div><p className="pcs-recap">{summary.recap}</p></div>
            {summary.insights.length > 0 && (
              <div className="pcs-section">
                <div className="pcs-section-label">Insights &amp; quotes</div>
                <ul className="pcs-insight-list">
                  {summary.insights.map((ins, i) => (
                    <li key={i} className="pcs-insight">
                      <span className={ins.assisted ? "pcs-insight-dot assisted" : "pcs-insight-dot"}>{ins.assisted ? "✓" : "·"}</span>
                      <span>{ins.text}{ins.assisted && ins.via && <span className="pcs-via"> — {ins.via}</span>}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {summary.questionsNotAsked.length > 0 && (
              <div className="pcs-section">
                <div className="pcs-section-label">Questions you didn't ask</div>
                <ul className="pcs-q-list">{summary.questionsNotAsked.map((q, i) => <li key={i} className="pcs-q-item">{q.text}</li>)}</ul>
              </div>
            )}
            {!suggestSaved && summary.insights.length > 0 && (
              <div className="pcs-memory-suggest">
                <div className="pcs-memory-label">Save a coaching preference?</div>
                <div className="pcs-memory-hint">Based on this call, Ruby can remember something for next time.</div>
                <button className="pcs-memory-btn" onClick={() => saveMemory(`Based on "${title}": ${summary.insights[0].text}`)}>✦ Save as memory</button>
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
