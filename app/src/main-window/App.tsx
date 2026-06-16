import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Gem from "../shared/Gem";
import "../shared/tokens.css";

// ─── Types ───────────────────────────────────────────────────────────────────

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
  | { id: "main" }
  | { id: "prep"; callName?: string }
  | { id: "live" }
  | { id: "post-call"; callName: string }
  | { id: "memory" }
  | { id: "settings" };

// ─── Date helpers ─────────────────────────────────────────────────────────────

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayKey(): string { return dateKey(new Date()); }
function msToDateKey(ms: number): string { return dateKey(new Date(ms)); }
function parseKey(key: string): Date { return new Date(key + "T00:00:00"); }

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDur(start?: number, end?: number): string | null {
  if (!start || !end || end <= start) return null;
  return `${Math.max(1, Math.round((end - start) / 60000))} min`;
}
function fmtDayLong(d: Date): string {
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}
function fmtMonthYear(d: Date): string {
  return d.toLocaleDateString([], { month: "long", year: "numeric" });
}
function fmtMonthShort(d: Date): string {
  return d.toLocaleDateString([], { month: "short", year: "numeric" });
}

const DAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function getDateRange(): Date[] {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - 90);
  const end = new Date(today); end.setDate(end.getDate() + 30);
  const out: Date[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) out.push(new Date(d));
  return out;
}

function buildCallMap(calls: CallMeta[]): Map<string, CallMeta[]> {
  const map = new Map<string, CallMeta[]>();
  for (const c of calls) {
    const key = msToDateKey(c.startedAt ?? c.mtimeMs);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(c);
  }
  return map;
}

// ─── Root app — screen router ────────────────────────────────────────────────

export default function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>({ id: "main" });

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
  // When live began (for timer)
  const liveStartRef = useRef<number>(0);
  const [liveSeconds, setLiveSeconds] = useState(0);

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

  const isLive = sessionState === "starting" || sessionState === "live" || sessionState === "ending";
  const isEnding = sessionState === "ending";

  const startCall = useCallback(async () => {
    setError(null);
    if (!direction.trim()) { setError("Add a direction first."); return; }
    const r = await window.prompty.invoke("call:start", { direction });
    if (!r.ok) {
      const pf = await window.prompty.invoke("preflight:get", undefined as never).catch(() => null);
      setError(pf?.message ?? r.error ?? "Couldn't start the call.");
      if (pf?.code === "mic") refreshMic();
    }
  }, [direction, refreshMic]);

  const endCall = useCallback(() => {
    void window.prompty.invoke("call:end", undefined as never);
  }, []);

  const openPrep = useCallback(async (callName?: string) => {
    setPrepError(null);
    setPrepMessages([]);
    setPrepComponents([]);
    streamingRef.current = false;
    const r = await window.prompty.invoke("prep:start", { direction });
    if (r.ok) {
      setScreen({ id: "prep", callName });
    } else {
      setPrepError("Couldn't start prep — is Claude Code installed?");
    }
  }, [direction]);

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
    setScreen({ id: "main" });
  }, []);

  const syncComponents = useCallback((next: PrepComp[]) => {
    setPrepComponents(next);
    void window.prompty.invoke("prep:set-components", { components: next as never });
  }, []);

  // Memory actions
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

  // Auto-scroll prep chat
  useEffect(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [prepMessages, prepThinking]);

  // Live timer
  useEffect(() => {
    if (!isLive) { setLiveSeconds(0); return; }
    if (liveStartRef.current === 0) liveStartRef.current = Date.now();
    const id = setInterval(() => {
      setLiveSeconds(Math.floor((Date.now() - liveStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [isLive]);

  useEffect(() => {
    if (!isLive) liveStartRef.current = 0;
  }, [isLive]);

  // Session auto-navigate
  useEffect(() => {
    if (sessionState === "starting" || sessionState === "live") {
      setScreen({ id: "live" });
    }
    if (sessionState === "ended") {
      setScreen({ id: "main" });
      refreshCalls();
    }
  }, [sessionState, refreshCalls]);

  // IPC setup
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

  // ── Screen routing ──────────────────────────────────────────────────────────

  if (screen.id === "live") {
    return (
      <LiveScreen
        isEnding={isEnding}
        liveSeconds={liveSeconds}
        direction={direction}
        prepComponents={prepComponents}
        onEnd={endCall}
      />
    );
  }

  if (screen.id === "prep") {
    return (
      <PrepScreen
        callName={screen.callName}
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
        onBeginCall={startCall}
        error={error}
      />
    );
  }

  if (screen.id === "post-call") {
    return (
      <PostCallScreen
        callName={screen.callName}
        readCall={readCall}
        onBack={() => setScreen({ id: "main" })}
        memories={memories}
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
        onBack={() => setScreen({ id: "main" })}
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
        onBack={() => setScreen({ id: "main" })}
      />
    );
  }

  return (
    <MainScreen
      calls={calls}
      isLive={isLive}
      sessionState={sessionState}
      error={error}
      micStatus={micStatus}
      refreshCalls={refreshCalls}
      onNewCall={() => openPrep()}
      onViewCall={(name) => setScreen({ id: "post-call", callName: name })}
      onPrepCall={(name) => openPrep(name)}
      onMemory={() => setScreen({ id: "memory" })}
      onSettings={() => setScreen({ id: "settings" })}
      onEndCall={endCall}
      isEnding={isEnding}
    />
  );
}

// ─── Main screen — calendar view ──────────────────────────────────────────────

function MainScreen(props: {
  calls: CallMeta[];
  isLive: boolean;
  isEnding: boolean;
  sessionState: SessionState;
  error: string | null;
  micStatus: string | null;
  refreshCalls: () => void;
  onNewCall: () => void;
  onViewCall: (name: string) => void;
  onPrepCall: (name: string) => void;
  onMemory: () => void;
  onSettings: () => void;
  onEndCall: () => void;
}): JSX.Element {
  const {
    calls, isLive, isEnding, error, micStatus,
    onNewCall, onViewCall, onPrepCall, onMemory, onSettings, onEndCall, refreshCalls,
  } = props;

  const [selectedKey, setSelectedKey] = useState(todayKey());
  const [calOpen, setCalOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(new Date());

  const stripRef = useRef<HTMLDivElement>(null);
  const pillRefs = useRef(new Map<string, HTMLButtonElement>());

  const dates = useMemo(() => getDateRange(), []);
  const callMap = useMemo(() => buildCallMap(calls), [calls]);

  // Scroll strip to today on mount
  useEffect(() => {
    const el = pillRefs.current.get(todayKey());
    if (el && stripRef.current) {
      el.scrollIntoView({ inline: "center", block: "nearest", behavior: "instant" });
    }
  }, []);

  const handleStripScroll = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const centerX = strip.scrollLeft + strip.clientWidth / 2;
    let best: Date | null = null;
    let bestDist = Infinity;
    pillRefs.current.forEach((el, key) => {
      const elCenter = el.offsetLeft + el.offsetWidth / 2;
      const dist = Math.abs(elCenter - centerX);
      if (dist < bestDist) { bestDist = dist; best = parseKey(key); }
    });
    if (best) setVisibleMonth(best as Date);
  }, []);

  const selectDate = useCallback((key: string) => {
    setSelectedKey(key);
    setCalOpen(false);
    setTimeout(() => {
      const el = pillRefs.current.get(key);
      if (el) el.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    }, 50);
  }, []);

  const today = todayKey();
  const selectedCalls = callMap.get(selectedKey) ?? [];
  const selectedDate = parseKey(selectedKey);
  const isPast = selectedKey < today;
  const isFuture = selectedKey > today;
  const isToday = selectedKey === today;

  const now = Date.now();
  const earlierToday = isToday ? selectedCalls.filter((c) => (c.endedAt ?? c.startedAt ?? c.mtimeMs) < now) : [];
  const upcomingToday = isToday ? selectedCalls.filter((c) => (c.startedAt ?? c.mtimeMs) > now) : [];

  return (
    <div className="cal-root">
      <div className="app-dragbar" />

      {/* Topbar */}
      <header className="cal-topbar app-drag">
        <div className="cal-brand">
          <Gem variant="mini" size={18} />
          <span className="cal-wordmark">Prompty</span>
        </div>
        <div className="cal-topbar-right app-no-drag">
          {isLive ? (
            <button
              className={`cal-live-btn${isEnding ? " busy" : ""}`}
              onClick={onEndCall}
              disabled={isEnding}
            >
              <span className="cal-live-dot" />
              {isEnding ? "Ending…" : "End call"}
            </button>
          ) : (
            <button className="cal-new-btn" onClick={onNewCall}>+ New call</button>
          )}
          <button className="cal-icon-btn" onClick={onMemory} title="Memory" aria-label="Memory">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5"/>
              <circle cx="8" cy="8" r="2.5" fill="currentColor"/>
            </svg>
          </button>
          <button className="cal-icon-btn" onClick={onSettings} title="Settings" aria-label="Settings">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </header>

      {/* Date strip area */}
      <div className="cal-strip-wrap">
        <div className="cal-strip-header">
          <span className="cal-month-label">{fmtMonthYear(visibleMonth)}</span>
          <button className="cal-calendar-toggle" onClick={() => setCalOpen((o) => !o)}>
            {calOpen ? "Close" : "Calendar"}
          </button>
        </div>

        {calOpen ? (
          <MonthGrid
            month={visibleMonth}
            callMap={callMap}
            selectedKey={selectedKey}
            today={today}
            onSelect={selectDate}
            onPrevMonth={() => setVisibleMonth((m) => { const n = new Date(m); n.setMonth(n.getMonth() - 1); return n; })}
            onNextMonth={() => setVisibleMonth((m) => { const n = new Date(m); n.setMonth(n.getMonth() + 1); return n; })}
          />
        ) : (
          <div className="cal-strip" ref={stripRef} onScroll={handleStripScroll}>
            {dates.map((d) => {
              const key = dateKey(d);
              const dayCalls = callMap.get(key) ?? [];
              const isSelected = key === selectedKey;
              const isT = key === today;
              const dots = Math.min(3, dayCalls.length);
              return (
                <button
                  key={key}
                  ref={(el) => { if (el) pillRefs.current.set(key, el); else pillRefs.current.delete(key); }}
                  className={`cal-pill${isSelected ? " selected" : ""}${isT ? " today" : ""}`}
                  onClick={() => setSelectedKey(key)}
                >
                  <span className="cal-pill-day">{DAY_ABBR[d.getDay()]}</span>
                  <span className="cal-pill-num">{d.getDate()}</span>
                  <span className="cal-pill-dots">
                    {Array.from({ length: Math.max(1, dots) }).map((_, i) => (
                      <span key={i} className={i < dots ? "cal-dot filled" : "cal-dot"} />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Day hero */}
      <div className="cal-hero">
        <div className="cal-hero-date">{fmtDayLong(selectedDate)}</div>
        <div className="cal-hero-sub">
          {selectedCalls.length === 0
            ? "Nothing scheduled"
            : `${selectedCalls.length} call${selectedCalls.length > 1 ? "s" : ""}${isToday ? " today" : ""}`}
        </div>
        {error && <div className="cal-error">{error}</div>}
      </div>

      {/* Events list */}
      <div className="cal-events">
        {isToday ? (
          <>
            {earlierToday.length > 0 && (
              <div className="cal-section">
                <div className="cal-section-label">Earlier today</div>
                {earlierToday.map((c) => (
                  <EventCard key={c.name} call={c} onSummary={() => onViewCall(c.name)} onPrep={() => onPrepCall(c.name)} />
                ))}
              </div>
            )}
            {upcomingToday.length > 0 && (
              <div className="cal-section">
                <div className="cal-section-label">Upcoming</div>
                {upcomingToday.map((c) => (
                  <EventCard key={c.name} call={c} upcoming onSummary={() => onViewCall(c.name)} onPrep={() => onPrepCall(c.name)} />
                ))}
              </div>
            )}
            {selectedCalls.length === 0 && (
              <EmptyDay onNewCall={onNewCall} />
            )}
          </>
        ) : isPast ? (
          selectedCalls.length === 0 ? (
            <div className="cal-empty"><span className="cal-empty-text">No calls that day</span></div>
          ) : (
            <div className="cal-section">
              <div className="cal-section-label">Past calls</div>
              {selectedCalls.map((c) => (
                <EventCard key={c.name} call={c} onSummary={() => onViewCall(c.name)} onPrep={() => onPrepCall(c.name)} />
              ))}
            </div>
          )
        ) : (
          selectedCalls.length === 0 ? (
            <EmptyDay onNewCall={onNewCall} />
          ) : (
            <div className="cal-section">
              <div className="cal-section-label">Scheduled</div>
              {selectedCalls.map((c) => (
                <EventCard key={c.name} call={c} upcoming onSummary={() => onViewCall(c.name)} onPrep={() => onPrepCall(c.name)} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function EmptyDay({ onNewCall }: { onNewCall: () => void }): JSX.Element {
  return (
    <div className="cal-empty">
      <span className="cal-empty-text">Nothing here</span>
      <button className="cal-empty-cta" onClick={onNewCall}>+ New call</button>
    </div>
  );
}

// ─── Month grid ───────────────────────────────────────────────────────────────

function MonthGrid(props: {
  month: Date;
  callMap: Map<string, CallMeta[]>;
  selectedKey: string;
  today: string;
  onSelect: (key: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
}): JSX.Element {
  const { month, callMap, selectedKey, today, onSelect, onPrevMonth, onNextMonth } = props;

  const year = month.getFullYear();
  const mo = month.getMonth();
  const firstDay = new Date(year, mo, 1);
  const lastDay = new Date(year, mo + 1, 0);
  const startPad = firstDay.getDay(); // 0=Sun
  const days: (Date | null)[] = [
    ...Array(startPad).fill(null),
    ...Array.from({ length: lastDay.getDate() }, (_, i) => new Date(year, mo, i + 1)),
  ];
  // Pad to full weeks
  while (days.length % 7 !== 0) days.push(null);

  return (
    <div className="cal-month-grid">
      <div className="cal-month-nav">
        <button className="cal-month-arrow" onClick={onPrevMonth}>‹</button>
        <span className="cal-month-title">{fmtMonthShort(month)}</span>
        <button className="cal-month-arrow" onClick={onNextMonth}>›</button>
      </div>
      <div className="cal-grid-dow">
        {["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => (
          <span key={d} className="cal-grid-dow-cell">{d}</span>
        ))}
      </div>
      <div className="cal-grid-days">
        {days.map((d, i) => {
          if (!d) return <span key={`pad-${i}`} className="cal-grid-cell empty" />;
          const key = dateKey(d);
          const hasCalls = (callMap.get(key)?.length ?? 0) > 0;
          const isSelected = key === selectedKey;
          const isT = key === today;
          return (
            <button
              key={key}
              className={`cal-grid-cell${isSelected ? " selected" : ""}${isT ? " today" : ""}`}
              onClick={() => onSelect(key)}
            >
              <span>{d.getDate()}</span>
              {hasCalls && <span className="cal-grid-dot" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Event card ───────────────────────────────────────────────────────────────

function EventCard(props: {
  call: CallMeta;
  upcoming?: boolean;
  onSummary: () => void;
  onPrep: () => void;
}): JSX.Element {
  const { call, upcoming, onSummary, onPrep } = props;
  const when = call.startedAt ?? call.mtimeMs;
  const dur = fmtDur(call.startedAt, call.endedAt);
  const isPast = !upcoming;

  return (
    <div className={`ev-card${upcoming ? " ev-upcoming" : " ev-past"}`}>
      <div className="ev-accent" />
      <div className="ev-body">
        <div className="ev-meta-row">
          <span className="ev-time">{fmtClock(when)}</span>
          {dur && <span className="ev-dur">{dur}</span>}
          {call.summaryPending && <span className="ev-tag">Summarizing…</span>}
        </div>
        <div className="ev-title">{call.title || "Untitled call"}</div>
      </div>
      <div className="ev-action">
        {isPast ? (
          <button className="ev-btn ev-btn-summary" onClick={onSummary}>
            Summary
          </button>
        ) : (
          <button className="ev-btn ev-btn-prep" onClick={onPrep}>
            ✦ Prep
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Prep screen ──────────────────────────────────────────────────────────────

function PrepScreen(props: {
  callName?: string;
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
    callName, direction, setDirection, prepMessages, prepThinking, prepError,
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

  const hasComponents = prepComponents.length > 0;

  return (
    <div className="prep-root">
      <div className="app-dragbar" />

      {/* Topbar */}
      <header className="prep-topbar app-drag">
        <button className="prep-back app-no-drag" onClick={onClose}>
          ← Back
        </button>
        <span className="prep-topbar-title">
          {callName ? "Prepare for call" : "New call"}
        </span>
        <button className="prep-begin-btn app-no-drag" onClick={onBeginCall}>
          Begin call →
        </button>
      </header>

      {error && <div className="prep-error-banner">{error}</div>}

      {/* Two-column body */}
      <div className="prep-body">
        {/* Left: Ruby chat */}
        <section className="prep-chat-col">
          <div className="prep-chat-label">
            <span className="prep-chat-dot" />
            Prep with Ruby
          </div>
          <div className="prep-chat-log" ref={chatLogRef}>
            {prepMessages.length === 0 && !prepThinking ? (
              <div className="prep-chat-empty">
                Tell Ruby about the call you're about to have.
              </div>
            ) : (
              prepMessages.map((m, i) => (
                <div key={i} className={m.role === "user" ? "prep-bubble-user" : "prep-bubble-asst"}>
                  {m.text}
                </div>
              ))
            )}
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
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrep(); }
              }}
            />
            <button
              className="prep-send-btn"
              onClick={sendPrep}
              disabled={!prepInput.trim() || prepThinking}
            >
              Send
            </button>
          </div>
        </section>

        {/* Right: Direction panel */}
        <aside className="prep-panel">
          <div className="prep-panel-label">Direction</div>
          <textarea
            className="prep-direction-input"
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            placeholder="Describe what a good call looks like — goals, stance, when to speak up…"
            spellCheck={false}
          />

          {hasComponents && (
            <div className="prep-components">
              {prepComponents.map((c) =>
                c.type === "goal" ? (
                  <div key={c.id} className="prep-comp-block">
                    <div className="prep-comp-head">
                      <span className="prep-comp-kind">Goal</span>
                      <button className="prep-comp-del" onClick={() => deleteComponent(c.id)}>✕</button>
                    </div>
                    <textarea
                      className="prep-comp-goal-input"
                      value={c.text}
                      rows={2}
                      placeholder="The one outcome that makes this call a success…"
                      onChange={(e) => editGoal(c.id, e.target.value)}
                    />
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
                          <input
                            className="prep-comp-item-input"
                            value={it.text}
                            onChange={(e) => editItem(c.id, it.id, e.target.value)}
                          />
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

          {!hasComponents && (
            <div className="prep-panel-hints">
              <div className="prep-hint-item">Goal will appear here</div>
              <div className="prep-hint-item">Checklist will appear here</div>
              <div className="prep-hint-item">Brief will appear here</div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ─── Live session screen ──────────────────────────────────────────────────────

function LiveScreen(props: {
  isEnding: boolean;
  liveSeconds: number;
  direction: string;
  prepComponents: PrepComp[];
  onEnd: () => void;
}): JSX.Element {
  const { isEnding, liveSeconds, direction, prepComponents, onEnd } = props;

  const mm = String(Math.floor(liveSeconds / 60)).padStart(2, "0");
  const ss = String(liveSeconds % 60).padStart(2, "0");

  const goal = prepComponents.find((c) => c.type === "goal") as { type: "goal"; id: string; text: string } | undefined;
  const checklist = prepComponents.find((c) => c.type === "checklist") as { type: "checklist"; id: string; title?: string; items: ChecklistItemR[] } | undefined;

  return (
    <div className="live-root">
      {/* Accent topbar */}
      <header className="live-topbar">
        <div className="live-topbar-left">
          <span className="live-pulse" />
          <span className="live-label">Live session</span>
        </div>
        <div className="live-timer">{mm}:{ss}</div>
        <button
          className={`live-end-btn${isEnding ? " busy" : ""}`}
          onClick={onEnd}
          disabled={isEnding}
        >
          {isEnding ? "Ending…" : "End session"}
        </button>
      </header>

      {/* Body */}
      <div className="live-body">
        {/* Left: plan + nudges */}
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

          <div className="live-overlay-note">
            Ruby is coaching you via the floating overlay in the top-right corner of your screen.
          </div>
        </div>

        {/* Right: transcript placeholder */}
        <div className="live-right">
          <div className="live-card-label">Transcript</div>
          <div className="live-transcript-empty">
            Transcript appears here during the call.
          </div>
        </div>
      </div>

      {/* Teleprompter bar */}
      <div className="live-teleprompter">
        <span className="live-tp-label">Ruby says</span>
        <span className="live-tp-text">Listening…</span>
      </div>
    </div>
  );
}

// ─── Post-call screen ────────────────────────────────────────────────────────

function PostCallScreen(props: {
  callName: string;
  readCall: (name: string) => Promise<ParsedCall | null>;
  onBack: () => void;
  memories: Mem[];
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

  const saveMemory = useCallback((text: string) => {
    void window.prompty.invoke("memory:add", { text }).then((r) => {
      if (r.item) setMemories((list) => [...list, r.item as Mem]);
      setSuggestSaved(true);
    });
  }, [setMemories]);

  const title = call?.title || call?.attendee?.name || "Call";
  const mins = call?.startedAt && call?.endedAt && call.endedAt > call.startedAt
    ? Math.max(1, Math.round((call.endedAt - call.startedAt) / 60000))
    : null;
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
          <div className="pcs-loading">Loading summary…</div>
        ) : !call ? (
          <div className="pcs-loading">Couldn't load this call.</div>
        ) : call.summaryPending ? (
          <div className="pcs-loading">
            <span className="mw-spinner" /> Summarizing this call…
          </div>
        ) : !summary ? (
          <div className="pcs-no-summary">
            <div className="pcs-no-summary-title">{title}</div>
            {mins && <div className="pcs-meta">{mins} min</div>}
            <pre className="pcs-raw">{call.raw}</pre>
          </div>
        ) : (
          <>
            <div className="pcs-title">{title}</div>
            {mins && <div className="pcs-meta">{mins} min</div>}

            {/* Stats row */}
            <div className="pcs-stats">
              <div className="pcs-stat-card">
                <div className="pcs-stat-num">{summary.stat.surfaced}</div>
                <div className="pcs-stat-label">Nudges surfaced</div>
              </div>
              <div className="pcs-stat-card">
                <div className="pcs-stat-num">{summary.stat.used}</div>
                <div className="pcs-stat-label">Nudges used</div>
              </div>
              <div className="pcs-stat-card">
                <div className="pcs-stat-num">
                  {call.components
                    ? (() => {
                        const cl = call.components.find((c) => c.type === "checklist") as { items: ChecklistItemR[] } | undefined;
                        if (!cl || cl.items.length === 0) return "—";
                        const done = cl.items.filter((it) => it.done).length;
                        return `${done}/${cl.items.length}`;
                      })()
                    : "—"}
                </div>
                <div className="pcs-stat-label">Checklist</div>
              </div>
            </div>

            {/* Recap */}
            <div className="pcs-section">
              <div className="pcs-section-label">Recap</div>
              <p className="pcs-recap">{summary.recap}</p>
            </div>

            {/* Insights */}
            {summary.insights.length > 0 && (
              <div className="pcs-section">
                <div className="pcs-section-label">Insights &amp; quotes</div>
                <ul className="pcs-insight-list">
                  {summary.insights.map((ins, i) => (
                    <li key={i} className="pcs-insight">
                      <span className={ins.assisted ? "pcs-insight-dot assisted" : "pcs-insight-dot"}>
                        {ins.assisted ? "✓" : "·"}
                      </span>
                      <span>
                        {ins.text}
                        {ins.assisted && ins.via && <span className="pcs-via"> — {ins.via}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Questions */}
            {summary.questionsNotAsked.length > 0 && (
              <div className="pcs-section">
                <div className="pcs-section-label">Questions you didn't ask</div>
                <ul className="pcs-q-list">
                  {summary.questionsNotAsked.map((q, i) => (
                    <li key={i} className="pcs-q-item">{q.text}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Memory suggestion */}
            {!suggestSaved && summary.insights.length > 0 && (
              <div className="pcs-memory-suggest">
                <div className="pcs-memory-label">Save a coaching preference?</div>
                <div className="pcs-memory-hint">
                  Based on this call, Ruby can remember something for next time.
                </div>
                <button
                  className="pcs-memory-btn"
                  onClick={() => saveMemory(`Based on the call "${title}": ${summary.insights[0].text}`)}
                >
                  ✦ Save as memory
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
  const {
    memories, newMemory, setNewMemory, editingMem, setEditingMem,
    addMemory, saveMemoryEdit, deleteMemory, onBack,
  } = props;

  return (
    <div className="fullscreen-root">
      <div className="app-dragbar" />
      <header className="fullscreen-topbar app-drag">
        <button className="fullscreen-back app-no-drag" onClick={onBack}>← Back</button>
        <span className="fullscreen-title">Memory</span>
        <span />
      </header>
      <div className="fullscreen-body">
        <p className="fullscreen-intro">
          Tell Ruby how to coach you. These apply to every call — nudge frequency, tone, things to always watch for.
        </p>
        <div className="mem-add-row">
          <input
            className="mem-input"
            value={newMemory}
            placeholder="e.g. Nudge me rarely — only when it really matters."
            onChange={(e) => setNewMemory(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addMemory(); }}
          />
          <button className="mem-add-btn" onClick={addMemory} disabled={!newMemory.trim()}>
            Add
          </button>
        </div>
        {memories.length === 0 ? (
          <div className="fullscreen-empty">No memories yet.</div>
        ) : (
          <ul className="mem-list">
            {memories.map((m) => {
              const isEdit = editingMem?.id === m.id;
              return (
                <li key={m.id} className="mem-item">
                  {isEdit ? (
                    <input
                      autoFocus
                      className="mem-edit-input"
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
                      <span className="mem-text">{m.text}</span>
                      {m.source === "suggested" && <span className="mem-tag">suggested</span>}
                      <button className="mem-action-btn" onClick={() => setEditingMem({ id: m.id, draft: m.text })}>✎</button>
                      <button className="mem-action-btn" onClick={() => deleteMemory(m.id)}>✕</button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
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
          <SettingRow
            label="Microphone"
            value={micStatus ?? "checking…"}
            tone={micOk ? "green" : micBlocked ? "red" : "amber"}
          >
            {!micOk && (
              micBlocked ? (
                <button
                  className="set-btn"
                  onClick={() => window.prompty.invoke("onboarding:open-external", { url: MIC_SETTINGS_URL })}
                >
                  Open System Settings
                </button>
              ) : (
                <button
                  className="set-btn set-btn-accent"
                  onClick={() => {
                    window.prompty.invoke("onboarding:request-mic", undefined as never).catch(() => {});
                    refreshMic();
                  }}
                >
                  Grant access
                </button>
              )
            )}
          </SettingRow>
          <SettingRow
            label="Claude Code"
            value={claude ? (claude.found ? claude.path ?? "found" : "not found") : "checking…"}
            tone={claude?.found ? "green" : claude ? "red" : "amber"}
          >
            <button className="set-btn" onClick={refreshClaude}>Re-check</button>
          </SettingRow>
        </div>
        <div className="set-group">
          <SettingRow label="Hotkey (ask)" value={hotkey} tone="muted" />
          <SettingRow label="Debug logs" value="~/.prompty/debug" tone="muted">
            <button
              className="set-btn"
              onClick={() => window.prompty.invoke("debug:reveal", undefined as never)}
            >
              Open folder
            </button>
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function SettingRow(props: {
  label: string;
  value: string;
  tone: "green" | "red" | "amber" | "muted";
  children?: React.ReactNode;
}): JSX.Element {
  const toneClass = `set-val set-val-${props.tone}`;
  return (
    <div className="set-row">
      <div className="set-row-main">
        <div className="set-label">{props.label}</div>
        <div className={toneClass}>{props.value}</div>
      </div>
      {props.children && <div className="set-control">{props.children}</div>}
    </div>
  );
}
