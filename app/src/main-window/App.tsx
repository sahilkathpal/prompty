import React, { useCallback, useEffect, useRef, useState } from "react";
import Gem from "../shared/Gem";
import { RubyLogo } from "../shared/RubyLogo";
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
type Mem = { id: string; text: string; createdAt: number; source?: "manual" | "suggested" };
type SkillOpt = { name: string; title: string; description: string };
type Utterance = { speaker: "me" | "them"; text: string; startMs: number };
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
  transcript?: Utterance[];
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

// mm:ss into the call, measured from the first utterance so 0:00 is the call's
// open — robust whether startMs is wall-clock or stream-relative.
function intoCall(startMs: number, baseMs: number): string {
  const s = Math.max(0, Math.round((startMs - baseMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Per-item checklist coverage, shown on the post-call screen below the headline
// stat. Renders nothing when the call carried no checklist.
function ChecklistCoverage(props: { components?: PrepComp[] }): JSX.Element | null {
  const checklist = props.components?.find((c) => c.type === "checklist");
  if (!checklist || checklist.type !== "checklist" || checklist.items.length === 0) return null;
  const total = checklist.items.length;
  const covered = checklist.items.filter((it) => it.done).length;
  return (
    <div className="pcs-section" data-testid="call-checklist">
      <div className="pcs-section-label" data-testid="call-checklist-stat">
        Checklist · covered {covered}/{total}
      </div>
      <ul className="pcs-coverage-list">
        {checklist.items.map((it) => (
          <li key={it.id} className={`pcs-coverage-item${it.done ? " done" : ""}`}>
            <span className="pcs-coverage-glyph" aria-hidden>{it.done ? "✓" : "○"}</span>
            <span>{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Collapsible full transcript, collapsed by default — the summary is the
// headline; the transcript is on-demand. Renders nothing for logs that predate
// transcript capture.
function TranscriptSection(props: { transcript?: Utterance[] }): JSX.Element | null {
  const lines = props.transcript ?? [];
  if (lines.length === 0) return <div className="pcs-transcript-empty">No transcript available for this call.</div>;
  const baseMs = lines[0].startMs;
  return (
    <div className="pcs-transcript-full" data-testid="call-transcript">
      {lines.map((u, i) => (
        <div key={i} className={`pcs-utt-row ${u.speaker === "me" ? "is-me" : "is-them"}`}>
          <div className="pcs-utt-meta">
            <span className={u.speaker === "me" ? "pcs-utt-me" : "pcs-utt-them"}>
              {u.speaker === "me" ? "You" : "Them"}
            </span>
            <span className="pcs-utt-time">{intoCall(u.startMs, baseMs)}</span>
          </div>
          <div className="pcs-utt-bubble">{u.text}</div>
        </div>
      ))}
    </div>
  );
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
  const [skills, setSkills] = useState<SkillOpt[]>([]);
  const [skill, setSkill] = useState("");
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
  // Becomes true once the on-mount direction seed has run, so the debounced
  // persist effect never writes the initial empty value over a saved draft.
  const draftReady = useRef(false);

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
        // Keep only finalized lines — interim Deepgram results would duplicate
        // utterances as they get revised. Absent on logs that predate transcript
        // capture, hence the defensive guard.
        const rawTranscript = Array.isArray(obj.transcript)
          ? (obj.transcript as Array<Record<string, unknown>>)
          : [];
        const transcript: Utterance[] = rawTranscript
          .filter((u) => u.isFinal !== false && typeof u.text === "string")
          .map((u) => ({
            speaker: u.speaker === "me" ? "me" : "them",
            text: u.text as string,
            startMs: typeof u.startMs === "number" ? u.startMs : 0,
          }));
        parsed = {
          title: (obj.title as string | undefined) ?? summary?.title,
          summary,
          startedAt: obj.startedAt as number | undefined,
          endedAt: obj.endedAt as number | undefined,
          attendee: obj.attendee as ParsedCall["attendee"],
          components: obj.components as PrepComp[] | undefined,
          transcript,
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
    const r = await window.prompty.invoke("call:start", { direction: dir, skill: skill || undefined });
    if (!r.ok) {
      const pf = await window.prompty.invoke("preflight:get", undefined as never).catch(() => null);
      setError(pf?.message ?? r.error ?? "Couldn't start the call.");
      if (pf?.code === "mic") refreshMic();
      return;
    }
    // The brief was consumed by this call — clear the pending prep so it doesn't
    // carry into the next one. The main process clears the persisted copy
    // (directionDraft + prepComponents); this clears the live editor state to
    // match. Skill is sticky and deliberately left as-is.
    setDirection("");
    setPrepComponents([]);
  }, [refreshMic, skill]);

  // Sticky skill: a discrete pick, so persist it synchronously on change (no
  // debounce — immune to the directionDraft quick-close race).
  const pickSkill = useCallback((name: string) => {
    setSkill(name);
    void window.prompty.invoke("settings:set", { skill: name });
  }, []);

  const endCall = useCallback(() => {
    void window.prompty.invoke("call:end", undefined as never);
  }, []);

  // ── Prep ────────────────────────────────────────────────────────────────────

  // Enter prep on the CURRENT working direction (the home bar is bound to it).
  // Navigation only — the pending prep (direction + components) is left intact;
  // it's cleared only on call start or an explicit discard. The brief is shown as
  // the opening user bubble before prep:start so the agent's opening turn (which
  // streams in via broadcast) appends after it.
  const enterPrep = useCallback(async () => {
    const brief = direction.trim();
    if (!brief) return;
    setPrepError(null);
    setPrepMessages([{ role: "user", text: brief }]);
    streamingRef.current = false;
    void window.prompty.invoke("main:set-prep-layout", { wide: true });
    setScreen({ id: "prep" });
    const r = await window.prompty.invoke("prep:start", { direction: brief });
    if (!r.ok) setPrepError("Couldn't start prep — is Claude Code installed?");
  }, [direction]);

  // "Start fresh" — discard the whole pending prep (direction + components),
  // state and persisted, returning home to a clean slate.
  const discardPrep = useCallback(() => {
    setDirection("");
    setPrepComponents([]);
    void window.prompty.invoke("prep:set-components", { components: [] as never });
    void window.prompty.invoke("settings:set", { directionDraft: "" });
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

  // Persist the working direction as a draft (debounced) so it survives closing
  // the window. Gated on draftReady so the initial empty render can't clobber a
  // saved draft before it has loaded.
  useEffect(() => {
    if (!draftReady.current) return;
    const id = setTimeout(() => {
      void window.prompty.invoke("settings:set", { directionDraft: direction });
    }, 400);
    return () => clearTimeout(id);
  }, [direction]);

  // Refetch on entering the Memory screen so items added elsewhere (a post-call
  // note, or another window) show without a relaunch.
  useEffect(() => {
    if (screen.id === "memory") refreshMemories();
  }, [screen.id, refreshMemories]);

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
    // Seed the direction on mount: a live call's direction wins (so reopening the
    // window mid-call still shows what's being coached); otherwise restore the
    // persisted draft so a prepped brief survives closing the window.
    window.prompty.invoke("session:state", undefined as never).then(async (r) => {
      setSessionState(r.state);
      if (!seeded.current && r.setup?.direction) { setDirection(r.setup.direction); seeded.current = true; }
      if (!seeded.current) {
        try {
          const s = await window.prompty.invoke("settings:get", undefined as never);
          const draft = (s as { directionDraft?: string }).directionDraft;
          if (!seeded.current && draft) { setDirection(draft); seeded.current = true; }
        } catch {}
      }
    }).catch(() => {}).finally(() => { draftReady.current = true; });
    window.prompty.invoke("settings:get", undefined as never).then((s) => {
      const set = s as { hotkey?: string; skill?: string; prepComponents?: PrepComp[] };
      if (set.hotkey) setHotkey(set.hotkey);
      if (typeof set.skill === "string") setSkill(set.skill);
      // Restore a brief prepped before an app restart. Persisted components are []
      // during/after a call, so this is safe mid-session.
      if (Array.isArray(set.prepComponents)) setPrepComponents(set.prepComponents);
    }).catch(() => {});
    window.prompty.invoke("skills:list", undefined as never).then((r) => setSkills(r.skills)).catch(() => {});
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
    // Prep chat streaming: deltas append to a live bubble, the authoritative full
    // message finalizes it.
    const offPrepDelta = window.prompty.on("prep:assistant-delta", (p) => {
      setPrepThinking(false);
      // Flip streamingRef synchronously here, NOT inside the updater: React runs
      // updaters at commit time, so if the ref were set there, a fast-arriving
      // final prep:assistant could read it as still-false and append a second
      // bubble instead of finalizing this one (the "reply twice" bug).
      const continuing = streamingRef.current;
      streamingRef.current = true;
      setPrepMessages((m) => {
        const last = m[m.length - 1];
        if (continuing && last && last.role === "assistant")
          return [...m.slice(0, -1), { ...last, text: last.text + p.text }];
        return [...m, { role: "assistant", text: p.text }];
      });
    });
    const offPrepAsst = window.prompty.on("prep:assistant", (p) => {
      const streaming = streamingRef.current;
      streamingRef.current = false;
      setPrepMessages((m) => {
        const last = m[m.length - 1];
        if (streaming && last && last.role === "assistant")
          return [...m.slice(0, -1), { ...last, text: p.text }];
        return [...m, { role: "assistant", text: p.text }];
      });
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
        skills={skills}
        skill={skill}
        pickSkill={pickSkill}
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
      direction={direction}
      setDirection={setDirection}
      components={prepComponents}
      onSend={enterPrep}
      onDiscard={discardPrep}
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
  direction: string;
  setDirection: (d: string) => void;
  components: PrepComp[];
  onSend: () => void;
  onDiscard: () => void;
  onViewCall: (name: string) => void;
  onMemory: () => void;
  onSettings: () => void;
  onEndCall: () => void;
}): JSX.Element {
  const { calls, isLive, isEnding, error, direction, setDirection, components, onSend, onDiscard, onViewCall, onMemory, onSettings, onEndCall } = props;
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The home bar IS the working direction — send enters prep without clearing it.
  const handleSend = () => {
    if (!direction.trim()) return;
    onSend();
  };

  const groups = groupCallsByDay(calls);
  const goal = components.find((c) => c.type === "goal");
  const checklist = components.find((c) => c.type === "checklist") as
    | { items: ChecklistItemR[] }
    | undefined;
  const checklistCount = checklist?.items.length ?? 0;

  return (
    <div className="home-root">
      <div className="app-dragbar" />

      {/* Topbar */}
      <header className="home-topbar app-drag">
        <div className="home-brand">
          <svg width="40" height="16" viewBox="0 0 361 147" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Ruby">
            <path d="M288.453 55.7333C284.622 46.2691 282.894 44.6918 275.608 43.2646V35.9788H317.972V43.2646C308.132 44.0909 306.705 45.8185 309.86 54.5315L323.154 90.8107L337.2 54.5315C340.505 45.8185 339.078 44.0158 329.163 43.2646V35.9788H360.11V43.2646C352.598 44.4664 351.096 45.4429 346.89 55.7333L330.44 95.8432L323.68 112.368L311.212 146.919H291.983V146.469C297.391 137.756 305.728 123.935 311.888 113.269L288.453 55.7333Z" fill="#1a1814"/>
            <path d="M275.079 73.1593C275.079 98.0214 259.005 114.095 238.8 114.095C228.134 114.095 219.346 108.988 214.989 103.054L207.252 112.368H198.014V18.4776C198.014 14.1962 197.338 13.0695 193.056 11.9428L187.423 10.5157V3.90583L218.97 0V47.6962C222.951 39.7343 232.64 34.2512 243.982 34.2512C261.183 34.2512 275.079 48.8229 275.079 73.1593ZM253.446 74.8869C253.446 56.7848 245.56 46.3442 233.692 46.3442C227.007 46.3442 221.524 49.2736 218.97 54.0808V97.1952C221.223 100.725 226.256 103.955 233.241 103.955C245.109 103.955 253.446 93.2894 253.446 74.8869Z" fill="#1a1814"/>
            <path d="M128.977 35.0024V84.8769C128.977 95.9936 134.76 101.927 144.675 101.927C151.586 101.927 156.768 98.6976 159.172 94.7166V53.3298C159.172 49.1235 158.496 47.9969 154.29 46.9453L148.581 45.443V38.8332L180.203 35.0024V95.0922C180.203 99.3736 180.879 100.5 185.236 101.627L190.869 103.054V109.664L159.547 113.344V100.876C155.341 108.237 146.478 114.096 133.859 114.096C118.386 114.096 108.021 104.932 108.021 88.933V53.3298C108.021 49.1235 107.344 47.9969 103.138 46.9453L97.4297 45.443V38.8332L128.977 35.0024Z" fill="#1a1814"/>
            <path d="M93.2894 33.1247C93.3645 46.7951 83.9003 56.109 71.8073 59.1886L85.5528 85.3276C94.3409 101.627 97.6459 104.406 102.077 105.533V112.368H76.0135L51.7523 65.1224H35.3027V96.1438C35.3027 102.528 36.7299 103.88 47.2456 105.082V112.368H0V105.082C11.4171 103.88 12.694 102.453 12.694 95.7682V20.5058C12.694 13.8208 11.4171 12.3937 0 11.1919V3.90601H49.6492C78.7927 3.90601 93.2894 15.1728 93.2894 33.1247ZM70.7557 34.9273C70.7557 21.0316 61.7422 13.1448 43.5651 12.5439L35.3027 12.3186V56.785L44.9922 56.4845C61.3667 56.0339 70.7557 48.8231 70.7557 34.9273Z" fill="#1a1814"/>
          </svg>
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
          <button className="home-icon-btn" data-testid="nav-memory" onClick={onMemory} title="Memory" aria-label="Memory">
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
              data-testid="home-direction"
              value={direction}
              rows={2}
              placeholder="Tell Ruby about your next call — who it's with, what you're trying to get out of it, any context that matters."
              onChange={(e) => {
                setDirection(e.target.value);
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
              data-testid="home-send"
              onClick={handleSend}
              disabled={!direction.trim()}
              aria-label="Send"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 12V2M7 2L2.5 6.5M7 2L11.5 6.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            </div>
          </div>

          {components.length > 0 && (
            <div className="home-pinned" data-testid="home-pinned">
              <span className="home-pinned-text">
                Pinned:
                {goal ? " a goal" : ""}
                {goal && checklistCount ? " ·" : ""}
                {checklistCount ? ` ${checklistCount} checklist item${checklistCount === 1 ? "" : "s"}` : ""}
              </span>
              <button className="home-pinned-clear" data-testid="home-start-fresh" onClick={onDiscard}>
                Start fresh
              </button>
            </div>
          )}
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
                          data-testid="call-row"
                          onClick={() => onViewCall(c.name)}
                        >
                          <span className={`home-call-dot${prepped ? " prepped" : ""}`} />
                          <span className="home-call-title">{c.title || "Untitled call"}</span>
                          <span className="home-call-time">{c.summaryPending ? "Summarizing…" : fmtClock(when)}</span>
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
  skills: SkillOpt[];
  skill: string;
  pickSkill: (name: string) => void;
  error: string | null;
}): JSX.Element {
  const {
    direction, setDirection, prepMessages, prepThinking, prepError,
    prepInput, setPrepInput, prepInputRef, chatLogRef, prepComponents, syncComponents,
    sendPrep, onClose, onBeginCall, skills, skill, pickSkill, error,
  } = props;
  const selectedSkill = skills.find((s) => s.name === skill);

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
            <button className="prep-back app-no-drag" data-testid="prep-back" onClick={onClose}>← Back</button>
            <div className="prep-chat-label"><span className="prep-chat-dot" />Prep with Ruby</div>
          </div>
          <div className="prep-chat-log" ref={chatLogRef} data-testid="prep-log">
            {prepMessages.length === 0 && !prepThinking
              ? <div className="prep-chat-empty">Tell Ruby about the call you're about to have.</div>
              : prepMessages.map((m, i) => (
                <div key={i} data-testid={`prep-msg-${m.role}`} className={m.role === "user" ? "prep-bubble-user" : "prep-bubble-asst"}>{m.text}</div>
              ))}
            {prepThinking && <div className="prep-bubble-asst prep-thinking" data-testid="prep-thinking">…</div>}
          </div>
          {prepError && <div className="prep-chat-error">{prepError}</div>}
          <div className="prep-chat-input-row">
            <div className="prep-chat-input-bar">
              <textarea
                ref={prepInputRef}
                className="prep-chat-input"
                data-testid="prep-input"
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
              <button className="prep-send-btn" data-testid="prep-send" onClick={sendPrep} disabled={!prepInput.trim() || prepThinking}>
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
            <div className="prep-sticky-header">
              <div className="prep-sticky-label">Note to Ruby</div>
              <div className="prep-sticky-help">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M6.5 6C6.5 5.17 7.17 4.5 8 4.5C8.83 4.5 9.5 5.17 9.5 6C9.5 6.83 8 7.5 8 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  <circle cx="8" cy="11" r="0.75" fill="currentColor"/>
                </svg>
                <div className="prep-sticky-tooltip">Tap on the note to edit it</div>
              </div>
            </div>
            <textarea
              className="prep-direction-input"
              data-testid="prep-direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value)}
              placeholder="What a good call looks like…"
              spellCheck={false}
              rows={1}
            />
          </div>

          <div className="prep-skill">
            <label className="prep-skill-label" htmlFor="prep-skill-select">Playbook</label>
            <select
              id="prep-skill-select"
              data-testid="playground-skill"
              className="prep-skill-select"
              value={skill}
              onChange={(e) => pickSkill(e.target.value)}
            >
              <option value="">No playbook</option>
              {skills.map((s) => (
                <option key={s.name} value={s.name}>{s.title}</option>
              ))}
            </select>
            {selectedSkill?.description && (
              <div className="prep-skill-hint" data-testid="playground-skill-hint">
                {selectedSkill.description}
              </div>
            )}
          </div>

          {prepComponents.length > 0 && (
            <div className="prep-components" data-testid="prep-components">
              {prepComponents.map((c) =>
                c.type === "goal" ? (
                  <div key={c.id} className="prep-comp-block" data-testid="component-goal">
                    <div className="prep-comp-head">
                      <span className="prep-comp-kind">Goal</span>
                      <button className="prep-comp-del" onClick={() => deleteComponent(c.id)}>✕</button>
                    </div>
                    <textarea className="prep-comp-goal-input" data-testid="goal-input" value={c.text} rows={2}
                      placeholder="The one outcome that makes this call a success…"
                      onChange={(e) => editGoal(c.id, e.target.value)} />
                  </div>
                ) : (
                  <div key={c.id} className="prep-comp-block" data-testid="component-checklist">
                    <div className="prep-comp-head">
                      <span className="prep-comp-kind">{c.title?.trim() || "Checklist"}</span>
                      <button className="prep-comp-del" onClick={() => deleteComponent(c.id)}>✕</button>
                    </div>
                    <ul className="prep-comp-list">
                      {c.items.map((it) => (
                        <li key={it.id} className="prep-comp-item" data-testid="checklist-item">
                          <span className="prep-comp-dot">○</span>
                          <input className="prep-comp-item-input" value={it.text}
                            onChange={(e) => editItem(c.id, it.id, e.target.value)} />
                          <button className="prep-comp-del" data-testid="checklist-item-delete" onClick={() => deleteItem(c.id, it.id)}>✕</button>
                        </li>
                      ))}
                    </ul>
                    <button className="prep-add-item" data-testid="checklist-add" onClick={() => addItem(c.id)}>+ Add item</button>
                  </div>
                ),
              )}
            </div>
          )}
          {prepComponents.length === 0 && (
            <div className="prep-empty-state">
              <svg width="20" height="20" viewBox="0 0 28 28" fill="none" className="prep-empty-sparkle">
                <path d="M10.0599 18.701C10.2571 18.8403 10.4829 18.9339 10.7207 18.9752C10.9586 19.0165 11.2027 19.0043 11.4353 18.9396C11.6679 18.8749 11.8832 18.7593 12.0656 18.6011C12.248 18.4429 12.3929 18.2461 12.4899 18.025L13.2599 15.685C13.4472 15.122 13.763 14.6104 14.1824 14.1907C14.6017 13.771 15.1131 13.4548 15.6759 13.267L17.9139 12.54C18.232 12.4294 18.5071 12.2211 18.6999 11.945C18.8488 11.7357 18.9458 11.4939 18.9829 11.2397C19.0199 10.9855 18.996 10.7262 18.9131 10.483C18.8301 10.2399 18.6906 10.02 18.5059 9.84138C18.3212 9.66282 18.0967 9.53073 17.8509 9.45602L15.6359 8.73602C15.0728 8.54922 14.5609 8.23381 14.1408 7.8148C13.7208 7.39579 13.4041 6.88469 13.2159 6.32202L12.4889 4.08502C12.3771 3.76808 12.1695 3.49374 11.8949 3.30002C11.6186 3.10952 11.291 3.00751 10.9554 3.00751C10.6198 3.00751 10.2922 3.10952 10.0159 3.30002C9.73703 3.49724 9.52715 3.77708 9.41591 4.10002L8.67991 6.36502C8.49216 6.91308 8.18221 7.41126 7.77352 7.82186C7.36482 8.23246 6.86809 8.54472 6.32091 8.73502L4.08091 9.46102C3.76217 9.5737 3.48647 9.78292 3.29218 10.0596C3.09789 10.3362 2.99466 10.6666 2.99686 11.0046C2.99906 11.3427 3.10658 11.6717 3.30446 11.9458C3.50234 12.2199 3.78073 12.4255 4.10091 12.534L6.31691 13.254C7.03536 13.4951 7.66694 13.9424 8.13291 14.54C8.39891 14.883 8.60391 15.268 8.73891 15.68L9.46691 17.914C9.57891 18.232 9.78691 18.507 10.0619 18.701M19.8059 24.781C20.0094 24.9249 20.2527 25.0017 20.5019 25.001C20.7494 25.0018 20.9911 24.926 21.1939 24.784C21.4027 24.6366 21.5589 24.4264 21.6399 24.184L22.0119 23.041C22.0906 22.8037 22.2235 22.588 22.4 22.4109C22.5765 22.2339 22.7918 22.1004 23.0289 22.021L24.1949 21.643C24.4301 21.5595 24.6336 21.4053 24.7777 21.2016C24.9219 20.9979 24.9995 20.7546 24.9999 20.505C24.9999 20.2489 24.918 19.9996 24.7661 19.7934C24.6143 19.5872 24.4005 19.435 24.1559 19.359L23.0119 18.989C22.7745 18.9102 22.5587 18.7772 22.3817 18.6005C22.2046 18.4238 22.0712 18.2083 21.9919 17.971L21.6119 16.808C21.53 16.5707 21.3756 16.365 21.1706 16.22C20.9656 16.075 20.7203 15.9979 20.4692 15.9997C20.2181 16.0014 19.9738 16.0819 19.7709 16.2298C19.568 16.3777 19.4165 16.5855 19.3379 16.824L18.9639 17.97C18.8873 18.2042 18.7579 18.4177 18.5857 18.594C18.4136 18.7704 18.2032 18.9048 17.9709 18.987L16.8049 19.365C16.5692 19.4483 16.3651 19.6025 16.2206 19.8064C16.0761 20.0104 15.9983 20.2541 15.9979 20.504C15.9982 20.7561 16.0778 21.0017 16.2255 21.206C16.3733 21.4103 16.5816 21.5628 16.8209 21.642L17.9649 22.014C18.2032 22.0926 18.4198 22.2261 18.5969 22.4039C18.7741 22.5816 18.907 22.7985 18.9849 23.037L19.3639 24.2C19.4466 24.435 19.6004 24.6384 19.8039 24.782" fill="currentColor"/>
              </svg>
              <p className="prep-empty-message">Ruby fills these in as you chat.</p>
              <div className="prep-empty-pills">
                <span className="prep-empty-pill">Goal</span>
                <span className="prep-empty-pill">Checklist</span>
              </div>
            </div>
          )}
          </div>
          <div className="prep-panel-begin">
            <button className="prep-begin-btn" data-testid="prep-begin" onClick={onBeginCall}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="prep-begin-mic">
                <path d="M11.9999 1C12.6565 1 13.3067 1.12933 13.9133 1.3806C14.52 1.63188 15.0712 2.00017 15.5355 2.46447C15.9998 2.92876 16.3681 3.47995 16.6193 4.08658C16.8706 4.69321 16.9999 5.34339 16.9999 6V10C16.9999 11.3261 16.4731 12.5979 15.5355 13.5355C14.5978 14.4732 13.326 15 11.9999 15C10.6738 15 9.40208 14.4732 8.4644 13.5355C7.52672 12.5979 6.99993 11.3261 6.99993 10V6C6.99993 4.67392 7.52672 3.40215 8.4644 2.46447C9.40208 1.52678 10.6738 1 11.9999 1ZM3.05493 11H5.06993C5.31222 12.6648 6.1458 14.1867 7.41816 15.2873C8.69053 16.3879 10.3166 16.9936 11.9989 16.9936C13.6813 16.9936 15.3073 16.3879 16.5797 15.2873C17.8521 14.1867 18.6856 12.6648 18.9279 11H20.9439C20.7166 13.0287 19.8066 14.9199 18.3631 16.3635C16.9197 17.8071 15.0286 18.7174 12.9999 18.945V23H10.9999V18.945C8.97107 18.7176 7.07972 17.8074 5.63611 16.3638C4.1925 14.9202 3.28234 13.0289 3.05493 11Z" fill="currentColor"/>
              </svg>
              Finish prep & start listening
            </button>
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
        <button className={`live-end-btn${isEnding ? " busy" : ""}`} data-testid="end-call" onClick={onEnd} disabled={isEnding}>
          {isEnding ? "Ending…" : "End session"}
        </button>
      </header>
      {isEnding && (
        <div className="live-ending-status" data-testid="playground-ending">
          <span className="mw-spinner" aria-hidden /> Wrapping up — saving your call summary. This can take a few seconds.
        </div>
      )}
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
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Quiet, user-authored "note how Ruby nudged" affordance (Phase 2c) — never a
  // reflexive pre-filled suggestion.
  const [tab, setTab] = useState<"summary" | "transcript">("summary");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyTranscript = () => {
    if (!call?.transcript) return;
    const text = call.transcript.map((u) => `${u.speaker === "me" ? "You" : "Them"}: ${u.text}`).join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  useEffect(() => {
    setLoading(true);
    readCall(callName).then((c) => { setCall(c); setLoading(false); });
  }, [callName, readCall]);

  // The background summary pass lands after the call ends — if we're viewing it
  // while it's still "Summarizing…", re-read so the placeholder fills in.
  useEffect(() => {
    const off = window.prompty.on("calls:updated", (p) => {
      if (p.name === callName) readCall(callName).then((c) => c && setCall(c));
    });
    return off;
  }, [callName, readCall]);

  const saveNote = () => {
    const text = note.trim();
    if (!text) return;
    void window.prompty.invoke("memory:add", { text }).then((r) => {
      if (r.item) {
        setMemories((list) => [...list, r.item as Mem]);
        setNote("");
        setNoteOpen(false);
        setNoteSaved(true);
      }
    });
  };

  const handleScroll = () => {
    setScrolled((scrollRef.current?.scrollTop ?? 0) > 2);
  };

  const title = call?.title || call?.attendee?.name || "Call";
  const mins = call?.startedAt && call?.endedAt && call.endedAt > call.startedAt
    ? Math.max(1, Math.round((call.endedAt - call.startedAt) / 60000)) : null;
  // Legacy call logs carry an older summary schema ({goalRecap, items}) whose
  // recap/insights/questionsNotAsked/stat are absent. Treat anything that isn't a
  // current-shape summary as "no summary" so we render the raw-log fallback rather
  // than crashing on `summary.insights.length`.
  const rawSummary = call?.summary;
  const summary =
    rawSummary &&
    typeof rawSummary.recap === "string" &&
    Array.isArray(rawSummary.insights) &&
    Array.isArray(rawSummary.questionsNotAsked) &&
    rawSummary.stat
      ? rawSummary
      : undefined;

  return (
    <div className="pcs-root">
      <div className="app-dragbar" />
      <div className="pcs-toprow app-drag">
        <button className="pcs-back app-no-drag" data-testid="post-call-back" onClick={onBack}>← Back</button>
        {tab === "transcript" && call && (
          <button className="pcs-copy-btn app-no-drag" data-testid="post-call-copy-transcript" onClick={copyTranscript}>
            {copied ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Copied!
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="2"/>
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" strokeWidth="2"/>
                </svg>
                Copy transcript
              </>
            )}
          </button>
        )}
      </div>
      {!loading && call && (
      <div className="pcs-tab-toggle">
        <button className={`pcs-tab${tab === "summary" ? " active" : ""}`} data-testid="post-call-tab-summary" onClick={() => setTab("summary")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M15 4H7M18 16L21 19L18 22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M3 4V17C3 17.5304 3.21071 18.0391 3.58579 18.4142C3.96086 18.7893 4.46957 19 5 19H21M7 14H14M7 9H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Summary
        </button>
        <button className={`pcs-tab${tab === "transcript" ? " active" : ""}`} data-testid="post-call-tab-transcript" onClick={() => setTab("transcript")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M5 16C5 15.7348 5.10536 15.4804 5.29289 15.2929C5.48043 15.1054 5.73478 15 6 15H14C14.2652 15 14.5196 15.1054 14.7071 15.2929C14.8946 15.4804 15 15.7348 15 16C15 16.2652 14.8946 16.5196 14.7071 16.7071C14.5196 16.8946 14.2652 17 14 17H6C5.73478 17 5.48043 16.8946 5.29289 16.7071C5.10536 16.5196 5 16.2652 5 16ZM18 11C18.2652 11 18.5196 11.1054 18.7071 11.2929C18.8946 11.4804 19 11.7348 19 12C19 12.2652 18.8946 12.5196 18.7071 12.7071C18.5196 12.8946 18.2652 13 18 13H10C9.73478 13 9.48043 12.8946 9.29289 12.7071C9.10536 12.5196 9 12.2652 9 12C9 11.7348 9.10536 11.4804 9.29289 11.2929C9.48043 11.1054 9.73478 11 10 11H18ZM16 16C16 15.7348 16.1054 15.4804 16.2929 15.2929C16.4804 15.1054 16.7348 15 17 15H18C18.2652 15 18.5196 15.1054 18.7071 15.2929C18.8946 15.4804 19 15.7348 19 16C19 16.2652 18.8946 16.5196 18.7071 16.7071C18.5196 16.8946 18.2652 17 18 17H17C16.7348 17 16.4804 16.8946 16.2929 16.7071C16.1054 16.5196 16 16.2652 16 16ZM7 11C7.26522 11 7.51957 11.1054 7.70711 11.2929C7.89464 11.4804 8 11.7348 8 12C8 12.2652 7.89464 12.5196 7.70711 12.7071C7.51957 12.8946 7.26522 13 7 13H6C5.73478 13 5.48043 12.8946 5.29289 12.7071C5.10536 12.5196 5 12.2652 5 12C5 11.7348 5.10536 11.4804 5.29289 11.2929C5.48043 11.1054 5.73478 11 6 11H7Z" fill="currentColor"/>
            <path fillRule="evenodd" clipRule="evenodd" d="M4 3C3.20435 3 2.44129 3.31607 1.87868 3.87868C1.31607 4.44129 1 5.20435 1 6V18C1 18.7956 1.31607 19.5587 1.87868 20.1213C2.44129 20.6839 3.20435 21 4 21H20C20.7956 21 21.5587 20.6839 22.1213 20.1213C22.6839 19.5587 23 18.7956 23 18V6C23 5.20435 22.6839 4.44129 22.1213 3.87868C21.5587 3.31607 20.7956 3 20 3H4ZM20 5H4C3.73478 5 3.48043 5.10536 3.29289 5.29289C3.10536 5.48043 3 5.73478 3 6V18C3 18.2652 3.10536 18.5196 3.29289 18.7071C3.48043 18.8946 3.73478 19 4 19H20C20.2652 19 20.5196 18.8946 20.7071 18.7071C20.8946 18.5196 21 18.2652 21 18V6C21 5.73478 20.8946 5.48043 20.7071 5.29289C20.5196 5.10536 20.2652 5 20 5Z" fill="currentColor"/>
          </svg>
          Transcript
        </button>
      </div>
      )}
      <div className={`pcs-scroll-edge${scrolled ? " visible" : ""}`} />
      <div className="pcs-body" ref={scrollRef} onScroll={handleScroll}>
        {loading ? (
          <div className="pcs-loading">Loading…</div>
        ) : !call ? (
          <div className="pcs-loading">Couldn't load this call.</div>
        ) : call.summaryPending ? (
          tab === "transcript" ? (
            <TranscriptSection transcript={call.transcript} />
          ) : (
            <div data-testid="call-summarizing">
              <div className="pcs-loading"><span className="mw-spinner" /> Summarizing this call…</div>
              <ChecklistCoverage components={call.components} />
            </div>
          )
        ) : !summary ? (
          // Raw-log fallback — a dev-facing state for legacy/un-summarized logs.
          tab === "transcript" ? (
            <TranscriptSection transcript={call.transcript} />
          ) : (
            <>
              <div className="pcs-title">{title}</div>
              {mins && <div className="pcs-meta">{mins} min</div>}
              <div className="pcs-meta">No summary card for this call — showing the raw log.</div>
              <ChecklistCoverage components={call.components} />
              <pre className="pcs-raw">{call.raw}</pre>
            </>
          )
        ) : (
          <>
            <div className="pcs-hero" data-testid="call-card">
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

            {tab === "transcript" ? <TranscriptSection transcript={call.transcript} /> : (<>
            <div className="pcs-stats" data-testid="call-stat">
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

            <ChecklistCoverage components={call.components} />

            {noteSaved ? (
              <div className="pcs-memory-card" data-testid="nudge-note-saved">
                <div className="pcs-memory-icon">
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <path d="M4 9.5L7.5 13L14 5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"/>
                  </svg>
                </div>
                <div className="pcs-memory-content">
                  <div className="pcs-memory-title">Saved to memory</div>
                  <div className="pcs-memory-desc">Ruby will apply this to future calls.</div>
                </div>
              </div>
            ) : noteOpen ? (
              <div className="pcs-memory-card pcs-memory-open">
                <div className="pcs-memory-content">
                  <div className="pcs-memory-title">Note how Ruby nudged</div>
                  <textarea
                    className="pcs-note-input"
                    data-testid="nudge-note-input"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. The pricing nudge landed at the right moment — do that more."
                    rows={3}
                    autoFocus
                  />
                  <div className="pcs-note-actions">
                    <button className="pcs-note-cancel" onClick={() => { setNoteOpen(false); setNote(""); }}>Cancel</button>
                    <button className="pcs-memory-btn" data-testid="nudge-note-save" onClick={saveNote} disabled={!note.trim()}>Save</button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="pcs-memory-card">
                <div className="pcs-memory-icon">
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <path d="M9 2.5L10.3 6.4H14.5L11.1 8.8L12.4 12.7L9 10.3L5.6 12.7L6.9 8.8L3.5 6.4H7.7L9 2.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round"/>
                  </svg>
                </div>
                <div className="pcs-memory-content">
                  <div className="pcs-memory-title">Save to memory</div>
                  <div className="pcs-memory-desc">Tell Ruby how the coaching landed — it applies to future calls.</div>
                </div>
                <button className="pcs-memory-btn" data-testid="nudge-note-open" onClick={() => setNoteOpen(true)}>
                  Add note
                </button>
              </div>
            )}

            </>)}
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
          <input className="mem-input" data-testid="memory-input" value={newMemory} placeholder="e.g. Nudge me rarely — only when it really matters."
            onChange={(e) => setNewMemory(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addMemory(); }} />
          <button className="mem-add-btn" data-testid="memory-add" onClick={addMemory} disabled={!newMemory.trim()}>Add</button>
        </div>
        {memories.length === 0
          ? <div className="fullscreen-empty" data-testid="memory-empty">No memories yet.</div>
          : <ul className="mem-list" data-testid="memory-list">{memories.map((m) => {
            const isEdit = editingMem?.id === m.id;
            return (
              <li key={m.id} className="mem-item" data-testid="memory-item">
                {isEdit ? (
                  <input autoFocus className="mem-edit-input" value={editingMem.draft}
                    onChange={(e) => setEditingMem({ id: m.id, draft: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") saveMemoryEdit(); if (e.key === "Escape") setEditingMem(null); }}
                    onBlur={saveMemoryEdit} />
                ) : (
                  <>
                    <span className="mem-text">{m.text}</span>
                    {m.source === "suggested" && <span className="mem-tag">suggested</span>}
                    <button className="mem-action-btn" aria-label="Edit memory" onClick={() => setEditingMem({ id: m.id, draft: m.text })}>✎</button>
                    <button className="mem-action-btn" data-testid="memory-delete" aria-label="Delete memory" onClick={() => deleteMemory(m.id)}>✕</button>
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
