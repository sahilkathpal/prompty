import React, { useCallback, useEffect, useRef, useState } from "react";
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
  attendee?: string;
};
type Mem = { id: string; text: string; createdAt: number; source?: "manual" | "suggested" };
type SkillOpt = { name: string; title: string; description: string };
type Utterance = { speaker: "me" | "them"; text: string; startMs: number };
type ChecklistItemR = { id: string; text: string; done: boolean };
type PrepComp =
  | { type: "goal"; id: string; text: string }
  | { type: "checklist"; id: string; title?: string; items: ChecklistItemR[] };
// `text` is the legacy single field (pre-redesign logs); `takeaway`/`quote` are
// the current shape. The renderer reads `takeaway ?? text` so both render.
type CallInsight = { takeaway?: string; quote?: string; text?: string; assisted?: boolean; via?: string };
type CallSummary = {
  title?: string;
  recap: string;
  insights: CallInsight[];
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
  | { id: "in-progress" }
  | { id: "post-call"; callName: string }
  | { id: "memory" }
  | { id: "settings" };

// The live call's plan, snapshotted at call start (the home bar's `direction`
// + `prepComponents` are cleared on start so they don't bleed into the next
// prep — this preserves them as read-only reference for the in-progress view).
type LivePlan = { direction: string; components: PrepComp[] };

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

// Per-item checklist coverage — reference, not a headline. Collapsed by default
// (the gist + insights are the page; this is what you planned to cover, on tap).
// Renders nothing when the call carried no checklist.
function ChecklistCoverage(props: { components?: PrepComp[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const checklist = props.components?.find((c) => c.type === "checklist");
  if (!checklist || checklist.type !== "checklist" || checklist.items.length === 0) return null;
  const total = checklist.items.length;
  return (
    <div className="pcs-section pcs-checklist" data-testid="call-checklist">
      <button className="pcs-checklist-head" onClick={() => setOpen((o) => !o)}>
        <span className="pcs-section-label" style={{ margin: 0 }}>Your prep checklist</span>
        <span className="pcs-checklist-count" data-testid="call-checklist-stat">
          {total} topic{total === 1 ? "" : "s"}
          <svg className={`pcs-chevron${open ? " open" : ""}`} width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      </button>
      {open && (
        <ul className="pcs-coverage-list">
          {checklist.items.map((it) => (
            <li key={it.id} className={`pcs-coverage-item${it.done ? " done" : ""}`}>
              <span className="pcs-coverage-glyph" aria-hidden>{it.done ? "✓" : "○"}</span>
              <span>{it.text}</span>
            </li>
          ))}
        </ul>
      )}
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
  // Account lives at the App level (not just in Settings) so Home can surface a
  // "sign in" prompt and react live to sign-out via the auth:state-changed event.
  const [account, setAccount] = useState<{ signedIn: boolean; email?: string } | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [memories, setMemories] = useState<Mem[]>([]);
  const [newMemory, setNewMemory] = useState("");
  // One-time guided first run: armed at onboarding-complete, drives the prep-bar
  // coachmark on Home and the playbook coachmark on the prep screen. Cleared the
  // first time the user dismisses or starts a call, and never shown again.
  const [firstRun, setFirstRun] = useState(false);
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
  // Read-only snapshot of the live call's plan (see LivePlan) for the
  // in-progress view. null when no call is live.
  const [livePlan, setLivePlan] = useState<LivePlan | null>(null);
  const liveTimer = `${Math.floor(liveSeconds / 60)}:${String(liveSeconds % 60).padStart(2, "0")}`;

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
  const refreshAccount = useCallback(() => {
    window.prompty.invoke("auth:status", undefined as never)
      .then((s) => setAccount({ signedIn: s.signedIn, email: s.email }))
      .catch(() => {});
  }, []);
  const signIn = useCallback(async () => {
    setAuthBusy(true);
    try {
      const res = await window.prompty.invoke("auth:google-sign-in", undefined as never);
      if (res.ok) setAccount({ signedIn: true, email: res.email });
    } finally {
      setAuthBusy(false);
    }
  }, []);
  const signOut = useCallback(async () => {
    setAuthBusy(true);
    try {
      await window.prompty.invoke("auth:sign-out", undefined as never);
      setAccount({ signedIn: false });
    } finally {
      setAuthBusy(false);
    }
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

  // End the one-time guided first run. Idempotent: flips local state off and
  // persists firstRunCoach:false so the coachmarks never return on relaunch.
  const dismissFirstRun = useCallback(() => {
    setFirstRun(false);
    track("first_run_dismissed");
    void window.prompty.invoke("settings:set", { firstRunCoach: false });
  }, []);

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
    // Snapshot the plan for the in-progress view BEFORE clearing it — the live
    // call still needs its direction/goal/checklist as read-only reference.
    setLivePlan({ direction: dir, components: prepComponents });
    // The brief was consumed by this call — clear the pending prep so it doesn't
    // carry into the next one. The main process clears the persisted copy
    // (directionDraft + prepComponents); this clears the live editor state to
    // match. Skill is sticky and deliberately left as-is.
    setDirection("");
    setPrepComponents([]);
    // Starting a call means the loop has been learned — retire the first-run tour.
    if (firstRun) dismissFirstRun();
  }, [refreshMic, skill, prepComponents, firstRun, dismissFirstRun]);

  // Sticky skill: a discrete pick, so persist it synchronously on change (no
  // debounce — immune to the directionDraft quick-close race).
  const pickSkill = useCallback((name: string) => {
    setSkill(name);
    track("playbook_selected", { skill: name || "none" });
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
    track("prep_started", { skill: skill || "none" });
    setPrepError(null);
    setPrepMessages([{ role: "user", text: brief }]);
    streamingRef.current = false;
    void window.prompty.invoke("main:set-prep-layout", { wide: true });
    setScreen({ id: "prep" });
    const r = await window.prompty.invoke("prep:start", { direction: brief });
    if (!r.ok) setPrepError("Couldn't start prep — is Claude Code installed?");
  }, [direction, skill]);

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

  // Delete is reversible (M2): the row goes immediately, but the deleted memory
  // lingers as an Undo toast for a few seconds. Undo re-adds it (a fresh id, same
  // text) — there's no soft-delete on the backend, so this re-persists it.
  const memUndoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [memUndo, setMemUndo] = useState<Mem | null>(null);
  const deleteMemory = useCallback((id: string) => {
    const victim = memories.find((m) => m.id === id);
    void window.prompty.invoke("memory:delete", { id }).then((r) => {
      if (!r.ok) return;
      setMemories((list) => list.filter((m) => m.id !== id));
      if (victim) {
        setMemUndo(victim);
        if (memUndoTimer.current) clearTimeout(memUndoTimer.current);
        memUndoTimer.current = setTimeout(() => setMemUndo(null), 6000);
      }
    });
  }, [memories]);
  const undoDeleteMemory = useCallback(() => {
    setMemUndo((victim) => {
      if (memUndoTimer.current) clearTimeout(memUndoTimer.current);
      if (victim) {
        void window.prompty.invoke("memory:add", { text: victim.text }).then((r) => {
          if (r.item) setMemories((list) => [...list, r.item as Mem]);
        });
      }
      return null;
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
    // Starting a call returns to Home — the overlay pill is the in-call surface;
    // the live call shows as the top row of the calls list, and clicking it
    // opens the calm in-progress view. (Live screen cut — RUBY_UX_AUDIT Part 3.)
    if (sessionState === "starting" || sessionState === "live") {
      setScreen({ id: "home" });
    } else if (sessionState !== "ending") {
      // ended / idle / error: the call is over (a teardown can land on "idle"
      // rather than "ended" — e.g. ending before the session fully spun up).
      // "ending" deliberately stays so the in-progress view can show its calm
      // "Finishing…" state. Close the in-progress view, but don't yank a user
      // who's elsewhere (e.g. reading a past recap), and drop the plan snapshot.
      setLivePlan(null);
      setScreen((s) => (s.id === "in-progress" ? { id: "home" } : s));
      if (sessionState === "ended") refreshCalls();
    }
  }, [sessionState, refreshCalls]);

  // ── IPC setup ───────────────────────────────────────────────────────────────

  useEffect(() => {
    // Seed the direction on mount: a live call's direction wins (so reopening the
    // window mid-call still shows what's being coached); otherwise restore the
    // persisted draft so a prepped brief survives closing the window.
    window.prompty.invoke("session:state", undefined as never).then(async (r) => {
      setSessionState(r.state);
      // Reopened mid-call: restore the live plan so the in-progress view has its
      // read-only reference even though the home-bar state was never populated.
      if (r.setup && (r.state === "starting" || r.state === "live" || r.state === "ending")) {
        setLivePlan({
          direction: r.setup.direction ?? "",
          components: (r.setup.components ?? []) as unknown as PrepComp[],
        });
      }
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
      const set = s as { hotkey?: string; skill?: string; prepComponents?: PrepComp[]; firstRunCoach?: boolean };
      if (set.hotkey) setHotkey(set.hotkey);
      if (typeof set.skill === "string") setSkill(set.skill);
      if (set.firstRunCoach) setFirstRun(true);
      // Restore a brief prepped before an app restart. Persisted components are []
      // during/after a call, so this is safe mid-session.
      if (Array.isArray(set.prepComponents)) setPrepComponents(set.prepComponents);
    }).catch(() => {});
    window.prompty.invoke("skills:list", undefined as never).then((r) => setSkills(r.skills)).catch(() => {});
    window.prompty.invoke("preflight:get", undefined as never).then((pf) => pf && setError(pf.message)).catch(() => {});
    refreshCalls(); refreshMic(); refreshClaude(); refreshMemories(); refreshAccount();

    // Re-check the readiness signals whenever the window regains focus — the user
    // may have just granted mic permission, installed Claude, or signed in
    // elsewhere. Cheap IPC, keeps the Home setup banner honest.
    const onFocus = () => { refreshMic(); refreshClaude(); refreshAccount(); };
    window.addEventListener("focus", onFocus);

    const offState = window.prompty.on("session:state-changed", (p) => {
      setSessionState(p.state);
      if (p.state === "ended" || p.state === "idle") refreshCalls();
    });
    const offPf = window.prompty.on("preflight:failed", (p) => {
      setError(p.message);
      if (p.code === "mic") refreshMic();
    });
    // Sign-in/out can happen from Settings or be revoked elsewhere — keep Home's
    // readiness banner in sync without needing a relaunch.
    const offAuth = window.prompty.on("auth:state-changed", (s) =>
      setAccount({ signedIn: s.signedIn, email: s.email }),
    );
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
      window.removeEventListener("focus", onFocus);
      offState(); offPf(); offAuth(); offCallsUpdated(); offPrepDelta(); offPrepAsst();
      offPrepDir(); offPrepThinking(); offPrepError(); offPrepComps();
    };
  }, [refreshCalls, refreshMic, refreshClaude, refreshMemories, refreshAccount]);

  // ── Routing ──────────────────────────────────────────────────────────────────

  if (screen.id === "in-progress") {
    return (
      <InProgressScreen
        timer={liveTimer}
        isEnding={isEnding}
        plan={livePlan}
        onEnd={endCall}
        onBack={() => setScreen({ id: "home" })}
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
        firstRun={firstRun}
        onDismissFirstRun={dismissFirstRun}
      />
    );
  }

  if (screen.id === "post-call") {
    return (
      <PostCallScreen
        callName={screen.callName}
        readCall={readCall}
        onBack={() => setScreen({ id: "home" })}
        onViewMemory={() => setScreen({ id: "memory" })}
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
        memUndo={memUndo}
        onUndoDelete={undoDeleteMemory}
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
        account={account}
        authBusy={authBusy}
        signIn={signIn}
        signOut={signOut}
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
      liveTimer={liveTimer}
      error={error}
      onDismissError={() => setError(null)}
      onRetryError={() => { window.prompty.invoke("preflight:get", undefined as never).then((pf) => setError(pf?.message ?? null)).catch(() => {}); }}
      micStatus={micStatus}
      claude={claude}
      account={account}
      authBusy={authBusy}
      onSignIn={signIn}
      onGrantMic={() => { window.prompty.invoke("onboarding:request-mic", undefined as never).catch(() => {}); refreshMic(); }}
      onOpenMicSettings={() => { window.prompty.invoke("onboarding:open-external", { url: MIC_SETTINGS_URL }); }}
      onOpenSettings={() => setScreen({ id: "settings" })}
      direction={direction}
      setDirection={setDirection}
      components={prepComponents}
      onSend={enterPrep}
      onDiscard={discardPrep}
      onViewCall={(name) => setScreen({ id: "post-call", callName: name })}
      onViewLive={() => setScreen({ id: "in-progress" })}
      onMemory={() => setScreen({ id: "memory" })}
      onSettings={() => setScreen({ id: "settings" })}
      firstRun={firstRun}
      onDismissFirstRun={dismissFirstRun}
    />
  );
}

// ─── Home screen ──────────────────────────────────────────────────────────────

// Session-scoped guard so the home bar is auto-focused only on the first Home
// render (the post-onboarding / launch landing), never on later returns.
let homeFocusedOnce = false;

// Seeded into the prep bar by the first-run coachmark's "Use an example" button —
// a concrete, ordinary brief so the user sees what a useful one looks like.
const FIRST_RUN_EXAMPLE =
  "Intro call with a designer who's thinking about switching tools. I want to understand what's not working for them today.";

// Fire a product-analytics event. The main process owns identity + base props
// and allowlists the event name (see electron/analytics.ts). Never pass call
// content — metadata only.
function track(event: string, properties?: Record<string, unknown>): void {
  void window.prompty.invoke("analytics:capture", { event, properties });
}

// Time-on-screen. Each top-level screen is its own mounted component (the router
// swaps them), so this hook stamps entry and emits `screen_viewed { screen,
// duration_s }` when the screen unmounts (navigation away) or the window is
// hidden/closed. Pass a changing `screen` (e.g. `post-call:${tab}`) to also
// capture sub-tab dwell — the effect re-runs, emitting the prior segment first.
function useScreenDwell(screen: string): void {
  const enteredAt = useRef<number>(Date.now());
  useEffect(() => {
    enteredAt.current = Date.now();
    const emit = () => {
      const duration_s = Math.round((Date.now() - enteredAt.current) / 1000);
      track("screen_viewed", { screen, duration_s });
    };
    const onVisibility = () => {
      // Hidden (backgrounded / window closing): bank the time so far. Becoming
      // visible again just restarts the clock so we don't count idle time.
      if (document.visibilityState === "hidden") emit();
      enteredAt.current = Date.now();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      emit();
    };
  }, [screen]);
}

// "Speak to founders" — opens the founders' scheduling page in the browser.
const FOUNDERS_URL = "https://calendly.com/sahil-revise";
const openFounders = (where: "home" | "prep") => {
  track("speak_to_founders_clicked", { where });
  void window.prompty.invoke("onboarding:open-external", { url: FOUNDERS_URL });
};

function HomeScreen(props: {
  calls: CallMeta[];
  isLive: boolean;
  liveTimer: string;
  error: string | null;
  onDismissError: () => void;
  onRetryError: () => void;
  micStatus: string | null;
  claude: { found: boolean; path: string | null } | null;
  account: { signedIn: boolean; email?: string } | null;
  authBusy: boolean;
  onSignIn: () => void;
  onGrantMic: () => void;
  onOpenMicSettings: () => void;
  onOpenSettings: () => void;
  direction: string;
  setDirection: (d: string) => void;
  components: PrepComp[];
  onSend: () => void;
  onDiscard: () => void;
  onViewCall: (name: string) => void;
  onViewLive: () => void;
  onMemory: () => void;
  onSettings: () => void;
  firstRun: boolean;
  onDismissFirstRun: () => void;
}): JSX.Element {
  const { calls, isLive, liveTimer, error, onDismissError, onRetryError, micStatus, claude, account, authBusy, onSignIn, onGrantMic, onOpenMicSettings, onOpenSettings, direction, setDirection, components, onSend, onDiscard, onViewCall, onViewLive, onMemory, onSettings, firstRun, onDismissFirstRun } = props;
  useScreenDwell("home");
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Drop into a focused prep bar the first time Home appears this session — the
  // landing after onboarding's "You're set" (and on a normal launch). Guarded
  // so returning to Home from a call/screen later doesn't yank focus.
  useEffect(() => {
    if (homeFocusedOnce) return;
    homeFocusedOnce = true;
    textareaRef.current?.focus();
  }, []);

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

  // Readiness: the same three hard requirements the call-start preflight checks
  // (signed in, mic granted, Claude found). Surface them proactively here so a
  // returning/signed-out user is told up front, not when they hit the wall. A
  // signal that's still loading (null) is treated as fine to avoid a flash.
  const micBlocked = micStatus === "denied" || micStatus === "restricted";
  const setupItems: { key: string; text: string; actionLabel: string; onAction: () => void; busy?: boolean }[] = [];
  if (account != null && !account.signedIn) {
    setupItems.push({ key: "auth", text: "Sign in to turn on transcription.", actionLabel: "Sign in with Google", onAction: onSignIn, busy: authBusy });
  }
  if (micStatus != null && micStatus !== "granted") {
    setupItems.push(micBlocked
      ? { key: "mic", text: "Microphone access is off — Ruby can't hear your call.", actionLabel: "Open System Settings", onAction: onOpenMicSettings }
      : { key: "mic", text: "Let Ruby hear your call — allow microphone access.", actionLabel: "Grant access", onAction: onGrantMic });
  }
  if (claude != null && !claude.found) {
    setupItems.push({ key: "claude", text: "Connect Claude Code so Ruby can prep and nudge.", actionLabel: "How to connect", onAction: onOpenSettings });
  }
  // Don't nag during a live call — the in-progress UI owns that moment.
  const showSetup = !isLive && setupItems.length > 0;

  return (
    <div className="home-root">
      <div className="app-dragbar" />

      {/* Topbar */}
      <header className="home-topbar app-drag">
        <div className="home-topbar-inner">
          <div className="home-brand">
            <svg width="44" height="18" viewBox="0 0 361 147" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="Ruby">
              <path d="M288.453 55.7333C284.622 46.2691 282.894 44.6918 275.608 43.2646V35.9788H317.972V43.2646C308.132 44.0909 306.705 45.8185 309.86 54.5315L323.154 90.8107L337.2 54.5315C340.505 45.8185 339.078 44.0158 329.163 43.2646V35.9788H360.11V43.2646C352.598 44.4664 351.096 45.4429 346.89 55.7333L330.44 95.8432L323.68 112.368L311.212 146.919H291.983V146.469C297.391 137.756 305.728 123.935 311.888 113.269L288.453 55.7333Z" fill="#1a1814"/>
              <path d="M275.079 73.1593C275.079 98.0214 259.005 114.095 238.8 114.095C228.134 114.095 219.346 108.988 214.989 103.054L207.252 112.368H198.014V18.4776C198.014 14.1962 197.338 13.0695 193.056 11.9428L187.423 10.5157V3.90583L218.97 0V47.6962C222.951 39.7343 232.64 34.2512 243.982 34.2512C261.183 34.2512 275.079 48.8229 275.079 73.1593ZM253.446 74.8869C253.446 56.7848 245.56 46.3442 233.692 46.3442C227.007 46.3442 221.524 49.2736 218.97 54.0808V97.1952C221.223 100.725 226.256 103.955 233.241 103.955C245.109 103.955 253.446 93.2894 253.446 74.8869Z" fill="#1a1814"/>
              <path d="M128.977 35.0024V84.8769C128.977 95.9936 134.76 101.927 144.675 101.927C151.586 101.927 156.768 98.6976 159.172 94.7166V53.3298C159.172 49.1235 158.496 47.9969 154.29 46.9453L148.581 45.443V38.8332L180.203 35.0024V95.0922C180.203 99.3736 180.879 100.5 185.236 101.627L190.869 103.054V109.664L159.547 113.344V100.876C155.341 108.237 146.478 114.096 133.859 114.096C118.386 114.096 108.021 104.932 108.021 88.933V53.3298C108.021 49.1235 107.344 47.9969 103.138 46.9453L97.4297 45.443V38.8332L128.977 35.0024Z" fill="#1a1814"/>
              <path d="M93.2894 33.1247C93.3645 46.7951 83.9003 56.109 71.8073 59.1886L85.5528 85.3276C94.3409 101.627 97.6459 104.406 102.077 105.533V112.368H76.0135L51.7523 65.1224H35.3027V96.1438C35.3027 102.528 36.7299 103.88 47.2456 105.082V112.368H0V105.082C11.4171 103.88 12.694 102.453 12.694 95.7682V20.5058C12.694 13.8208 11.4171 12.3937 0 11.1919V3.90601H49.6492C78.7927 3.90601 93.2894 15.1728 93.2894 33.1247ZM70.7557 34.9273C70.7557 21.0316 61.7422 13.1448 43.5651 12.5439L35.3027 12.3186V56.785L44.9922 56.4845C61.3667 56.0339 70.7557 48.8231 70.7557 34.9273Z" fill="#1a1814"/>
            </svg>
          </div>
          <div className="home-topbar-actions app-no-drag">
            <button className="home-founders-btn" data-testid="speak-to-founders" onClick={() => openFounders("home")} title="Book a call with the Ruby founders">
              Speak to founders
            </button>
            <button className="home-icon-btn" data-testid="nav-memory" onClick={onMemory} title="Memory" aria-label="Memory">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 21h10a2 2 0 0 0 2 -2v-14a2 2 0 0 0 -2 -2h-6.172a2 2 0 0 0 -1.414 .586l-3.828 3.828a2 2 0 0 0 -.586 1.414v10.172a2 2 0 0 0 2 2" />
                <path d="M13 6v2" /><path d="M16 6v2" /><path d="M10 7v1" />
              </svg>
            </button>
            <button className="home-icon-btn" data-testid="nav-settings" onClick={onSettings} title="Settings" aria-label="Settings">
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                <path d="M2 4.5h3M7 4.5h6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
                <circle cx="5.5" cy="4.5" r="1.5" stroke="currentColor" strokeWidth="1.25"/>
                <path d="M2 10.5h6M10.5 10.5h2.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
                <circle cx="9" cy="10.5" r="1.5" stroke="currentColor" strokeWidth="1.25"/>
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Scrollable body */}
      <div className="home-body">

        <div className="home-chat-bg">
        <div className="home-chat-container">
          <div className="home-logo"><RubyLogo size={52} /></div>
          <h2 className="home-section-heading">Let me help with your next call</h2>

          {/* Chat input bar */}
          <div className={`home-bar${focused ? " focused" : ""}`}>
            <div className="home-bar-bottom">
            <textarea
              ref={textareaRef}
              className="home-bar-input"
              data-testid="home-direction"
              value={direction}
              rows={2}
              placeholder="Tell me about your next call — who it's with, what you're trying to get out of it, any context that matters."
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
              aria-label="Prepare for this call"
              title="Set up your prep"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M2 7H12M12 7L7.5 2.5M12 7L7.5 11.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            </div>
          </div>
          {focused && (
            <div className="home-bar-hint" data-testid="home-bar-hint">
              Enter to start prepping · Shift+Enter for a new line
            </div>
          )}

          {firstRun && !isLive && components.length === 0 && (
            <div className="home-coach" data-testid="home-coach" role="status">
              <button
                className="home-coach-dismiss"
                data-testid="home-coach-dismiss"
                aria-label="Dismiss"
                onClick={onDismissFirstRun}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
              <div className="home-coach-body">
                <span className="home-coach-title">Try your first prep</span>
                <p className="home-coach-text">
                  Tell me what your next call's about and I'll help you prep —
                  getting clear on what you want out of it. Next, pick a{" "}
                  <strong>playbook</strong> for the kind of call.
                </p>
                <button
                  className="home-coach-example"
                  data-testid="home-coach-example"
                  onClick={() => {
                    setDirection(FIRST_RUN_EXAMPLE);
                    const el = textareaRef.current;
                    if (el) {
                      el.focus();
                      el.style.height = "auto";
                      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                    }
                  }}
                >
                  Use an example
                </button>
              </div>
            </div>
          )}

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

        {showSetup && (
          <div className="home-setup" data-testid="home-setup" role="status" aria-live="polite">
            <div className="home-setup-head">
              <svg className="home-setup-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="2"/>
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 003.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H8a1.65 1.65 0 001-1.51V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V8a1.65 1.65 0 001.51 1H22a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
              <span className="home-setup-title">
                {setupItems.length === 1 ? "One thing to finish setting up" : "A few things to finish setting up"}
              </span>
            </div>
            <ul className="home-setup-list">
              {setupItems.map((it) => (
                <li key={it.key} className="home-setup-item" data-testid={`home-setup-${it.key}`}>
                  <span className="home-setup-text">{it.text}</span>
                  <button
                    className="home-setup-action"
                    data-testid={`home-setup-${it.key}-action`}
                    disabled={it.busy}
                    onClick={it.onAction}
                  >
                    {it.actionLabel}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <div className="home-error-banner" data-testid="home-error" role="alert">
            <svg className="home-error-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/>
              <path d="M12 7v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="12" cy="16.5" r="1" fill="currentColor"/>
            </svg>
            <span className="home-error-msg">{error}</span>
            <button className="home-error-retry" data-testid="home-error-retry" onClick={onRetryError}>Try again</button>
            <button className="home-error-dismiss" aria-label="Dismiss" onClick={onDismissError}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        )}

        {/* Past calls list — with the live call (if any) pinned to the top. */}
        {!isLive && calls.length === 0 ? (
          <div className="home-empty">Your past calls will appear here. Tell me about your next one above to start prepping.</div>
        ) : (
          <div className="home-calls">
            {isLive && (
              <ul className="home-call-list">
                <li>
                  <button
                    className="home-call-row home-live-row"
                    data-testid="home-live-row"
                    onClick={onViewLive}
                  >
                    <span className="home-call-dot home-call-dot-live" />
                    <span className="home-call-title">Current call</span>
                    <span className="home-call-rhs">
                      <span className="home-call-time home-live-time">Live · {liveTimer}</span>
                      <svg className="home-call-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                        <path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </span>
                  </button>
                </li>
              </ul>
            )}
            {groups.map((group) => (
              <div key={group.label} className="home-day-group">
                <div className="home-day-label">
                  <span className="home-day-text">{group.label}</span>
                  <span className="home-day-line" />
                </div>
                <ul className="home-call-list">
                  {group.items.map((c) => {
                    const when = c.startedAt ?? c.mtimeMs;
                    // H6: give summarizing rows an anchor (the attendee's name) so
                    // they aren't an indistinct stack of "Untitled call", and show
                    // the duration next to the clock.
                    const rowTitle = c.title?.trim() || c.attendee || "Untitled call";
                    const dur = fmtDur(c.startedAt, c.endedAt);
                    return (
                      <li key={c.name}>
                        <button
                          className="home-call-row"
                          data-testid="call-row"
                          onClick={() => onViewCall(c.name)}
                        >
                          <span className="home-call-title">{rowTitle}</span>
                          <span className="home-call-rhs">
                            <span className="home-call-time">
                              {c.summaryPending ? "Summarizing…" : fmtClock(when)}{dur ? ` · ${dur}` : ""}
                            </span>
                            <svg className="home-call-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                              <path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </span>
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

function CompMenu(props: { onDelete: () => void }): JSX.Element {
  const { onDelete } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="comp-menu" ref={ref}>
      <button className="comp-menu-trigger" onClick={() => setOpen((o) => !o)} type="button" aria-label="Options">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="2" cy="7" r="1.25" fill="currentColor"/>
          <circle cx="7" cy="7" r="1.25" fill="currentColor"/>
          <circle cx="12" cy="7" r="1.25" fill="currentColor"/>
        </svg>
      </button>
      {open && (
        <div className="comp-menu-popover">
          <button className="comp-menu-delete" onClick={() => { onDelete(); setOpen(false); }} type="button">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <polyline points="3 6 5 6 21 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function SkillDropdown(props: {
  skills: SkillOpt[];
  value: string;
  onChange: (name: string) => void;
  noteStyle?: boolean;
}): JSX.Element {
  const { skills, value, onChange, noteStyle } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = skills.find((s) => s.name === value);
  const label = selected?.title ?? "General";

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const base = noteStyle ? "skill-dd note-style" : "skill-dd";

  return (
    <div className={`${base}${open ? " open" : ""}`} ref={ref} data-testid="playground-skill">
      <button
        className="skill-dd-trigger"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        <span className="skill-dd-label">{label}</span>
        <svg className={`skill-dd-chevron${open ? " open" : ""}`} width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M4 6L8 10L12 6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {open && (
        <div className="skill-dd-menu">
          <div className="skill-dd-divider" />
          <button
            className={`skill-dd-item${!value ? " active" : ""}`}
            onClick={() => { onChange(""); setOpen(false); }}
            type="button"
          >
            General
          </button>
          {skills.map((s) => (
            <button
              key={s.name}
              className={`skill-dd-item${value === s.name ? " active" : ""}`}
              onClick={() => { onChange(s.name); setOpen(false); }}
              type="button"
            >
              {s.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  firstRun: boolean;
  onDismissFirstRun: () => void;
}): JSX.Element {
  const {
    direction, setDirection, prepMessages, prepThinking, prepError,
    prepInput, setPrepInput, prepInputRef, chatLogRef, prepComponents, syncComponents,
    sendPrep, onClose, onBeginCall, skills, skill, pickSkill, error,
    firstRun, onDismissFirstRun,
  } = props;
  useScreenDwell("prep");
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
            <button className="pcs-back app-no-drag" data-testid="prep-back" onClick={onClose}>← Home</button>
            <div className="prep-chat-label"><span className="prep-chat-dot" />Prep with Ruby</div>
          </div>
          <div className="prep-chat-log" ref={chatLogRef} data-testid="prep-log" role="log" aria-live="polite">
            {prepMessages.length === 0 && !prepThinking
              ? <div className="prep-chat-empty">What's this call about? Tell Ruby and she'll help you prep.</div>
              : prepMessages.map((m, i) => (
                <div key={i} data-testid={`prep-msg-${m.role}`} className={m.role === "user" ? "prep-bubble-user" : "prep-bubble-asst"}>{m.text}</div>
              ))}
            {prepThinking && (
              <div className="prep-bubble-asst prep-thinking" data-testid="prep-thinking" aria-label="Ruby is thinking">
                <span className="prep-think-dot" />
                <span className="prep-think-dot" />
                <span className="prep-think-dot" />
              </div>
            )}
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
              <button className="prep-send-btn" data-testid="prep-send" onClick={sendPrep} disabled={!prepInput.trim() || prepThinking} aria-label="Send message to Ruby">
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
              <div className="prep-sticky-label">Game plan</div>
              {prepThinking ? (
                <div className="prep-sticky-updating" data-testid="prep-panel-updating">
                  <span className="prep-shimmer-dot" />
                  Ruby is updating your plan…
                </div>
              ) : (
                <div className="prep-sticky-help" tabIndex={0} aria-label="How to edit the game plan">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M6.5 6C6.5 5.17 7.17 4.5 8 4.5C8.83 4.5 9.5 5.17 9.5 6C9.5 6.83 8 7.5 8 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    <circle cx="8" cy="11" r="0.75" fill="currentColor"/>
                  </svg>
                  <div className="prep-sticky-tooltip">Click anywhere in the note to edit it</div>
                </div>
              )}
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

            {/* Goal + checklist are folded into the note itself (sections of the
                one document), not separate cards — but they stay structured
                PrepComponents so live mark_covered + post-call coverage work. */}
            {prepComponents.length > 0 && (
              <div className="prep-components prep-note-components" data-testid="prep-components">
                {prepComponents.map((c) =>
                  c.type === "goal" ? (
                    <div key={c.id} className="prep-comp-block" data-testid="component-goal">
                      <div className="prep-comp-head">
                        <span className="prep-comp-kind">
                          <svg className="prep-comp-glyph" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/>
                            <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="2"/>
                            <circle cx="12" cy="12" r="1" fill="currentColor"/>
                          </svg>
                          Goal
                        </span>
                        <CompMenu onDelete={() => deleteComponent(c.id)} />
                      </div>
                      <textarea className="prep-comp-goal-input" data-testid="goal-input" value={c.text} rows={2}
                        placeholder="The outcome that makes this call a win…"
                        onChange={(e) => editGoal(c.id, e.target.value)} />
                    </div>
                  ) : (
                    <div key={c.id} className="prep-comp-block" data-testid="component-checklist">
                      <div className="prep-comp-head">
                        <span className="prep-comp-kind">
                          <svg className="prep-comp-glyph" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                            <rect x="3" y="3" width="18" height="18" rx="4" stroke="currentColor" strokeWidth="2"/>
                            <path d="M8 12l2.5 2.5L16 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                          {c.title?.trim() || "Checklist"}
                        </span>
                        <CompMenu onDelete={() => deleteComponent(c.id)} />
                      </div>
                      <ul className="prep-comp-list">
                        {c.items.map((it) => (
                          <li key={it.id} className="prep-comp-item" data-testid="checklist-item">
                            <span className="prep-comp-dot">○</span>
                            <textarea className="prep-comp-item-input" value={it.text} rows={1}
                              placeholder={!it.text ? "Type to add a new item…" : undefined}
                              ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }}
                              onChange={(e) => { editItem(c.id, it.id, e.target.value); const el = e.target; el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }} />
                            <button className="prep-comp-del" data-testid="checklist-item-delete" onClick={() => deleteItem(c.id, it.id)}>
                              <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1 1l9 9M10 1L1 10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/></svg>
                            </button>
                          </li>
                        ))}
                      </ul>
                      <button className="prep-add-item" data-testid="checklist-add" onClick={() => addItem(c.id)}>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/></svg>
                        Add a new item
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}

            <div className="prep-note-divider" />
            <div className={`prep-note-skill${firstRun ? " coach" : ""}`}>
              <div className="prep-note-skill-label">Playbook</div>
              {firstRun && (
                <div className="prep-skill-coach" data-testid="prep-skill-coach" role="status">
                  <span className="prep-skill-coach-text">
                    Pick a playbook — it shapes how I prep and nudge for this kind of call.
                  </span>
                  <button
                    className="prep-skill-coach-dismiss"
                    data-testid="prep-skill-coach-dismiss"
                    onClick={onDismissFirstRun}
                  >
                    Got it
                  </button>
                </div>
              )}
              <SkillDropdown skills={skills} value={skill} onChange={pickSkill} noteStyle />
              <div className="prep-skill-caption">Shapes how Ruby helps on this call.</div>
              {selectedSkill?.description && (
                <div className="prep-skill-hint" data-testid="playground-skill-hint">
                  {selectedSkill.description}
                </div>
              )}
              <div className="prep-add-playbook" data-testid="prep-add-playbook">
                Want to add your own playbook?{" "}
                <button
                  className="prep-add-playbook-link"
                  data-testid="prep-speak-to-founders"
                  onClick={() => openFounders("prep")}
                >
                  Speak to founders
                </button>
              </div>
            </div>
          </div>

          </div>
          <div className="prep-panel-begin">
            <button className="prep-begin-btn" data-testid="prep-begin" onClick={onBeginCall}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="prep-begin-mic">
                <path d="M11.9999 1C12.6565 1 13.3067 1.12933 13.9133 1.3806C14.52 1.63188 15.0712 2.00017 15.5355 2.46447C15.9998 2.92876 16.3681 3.47995 16.6193 4.08658C16.8706 4.69321 16.9999 5.34339 16.9999 6V10C16.9999 11.3261 16.4731 12.5979 15.5355 13.5355C14.5978 14.4732 13.326 15 11.9999 15C10.6738 15 9.40208 14.4732 8.4644 13.5355C7.52672 12.5979 6.99993 11.3261 6.99993 10V6C6.99993 4.67392 7.52672 3.40215 8.4644 2.46447C9.40208 1.52678 10.6738 1 11.9999 1ZM3.05493 11H5.06993C5.31222 12.6648 6.1458 14.1867 7.41816 15.2873C8.69053 16.3879 10.3166 16.9936 11.9989 16.9936C13.6813 16.9936 15.3073 16.3879 16.5797 15.2873C17.8521 14.1867 18.6856 12.6648 18.9279 11H20.9439C20.7166 13.0287 19.8066 14.9199 18.3631 16.3635C16.9197 17.8071 15.0286 18.7174 12.9999 18.945V23H10.9999V18.945C8.97107 18.7176 7.07972 17.8074 5.63611 16.3638C4.1925 14.9202 3.28234 13.0289 3.05493 11Z" fill="currentColor"/>
              </svg>
              Start listening
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── Live screen ─────────────────────────────────────────────────────────────

// The calm in-progress view, opened by clicking the live row on Home. It's a
// quiet, read-only glance at your own game plan mid-call (the overlay pill is
// the real in-call surface) plus the Finish-listening control. Reuses the
// post-call shell so finishing flows naturally into the recap.
function InProgressScreen(props: {
  timer: string;
  isEnding: boolean;
  plan: LivePlan | null;
  onEnd: () => void;
  onBack: () => void;
}): JSX.Element {
  const { timer, isEnding, plan, onEnd, onBack } = props;
  useScreenDwell("in-progress");
  const direction = plan?.direction ?? "";
  const goal = plan?.components.find((c) => c.type === "goal") as { type: "goal"; id: string; text: string } | undefined;
  const checklist = plan?.components.find((c) => c.type === "checklist") as { type: "checklist"; id: string; title?: string; items: ChecklistItemR[] } | undefined;

  return (
    <div className="pcs-root">
      <div className="app-dragbar" />
      <div className="pcs-toprow app-drag">
        <div className="pcs-toprow-inner">
          <button className="pcs-back app-no-drag" data-testid="in-progress-back" onClick={onBack}>← Home</button>
          <div className="ip-live-badge">
            <span className="home-call-dot home-call-dot-live" />
            <span className="ip-live-label">Live</span>
            <span className="ip-live-timer" data-testid="in-progress-timer">{timer}</span>
          </div>
        </div>
      </div>

      <div className="pcs-body ip-body">
        {/* Calm status — Ruby works on the overlay; the recap arrives here. */}
        <div className="ip-status" data-testid="in-progress-status">
          <p className="ip-status-line">I'm listening on the overlay pill.</p>
          <p className="ip-status-sub">Your recap lands here when you wrap up.</p>
        </div>

        <hr className="pcs-divider" />

        {/* Read-only reference: glance at your own game plan mid-call. */}
        <div className="pcs-section-label">Your game plan</div>
        {direction ? (
          <p className="ip-direction">{direction}</p>
        ) : (
          <p className="ip-direction ip-direction-empty">
            You didn't set a direction — I'm still listening and ready to help.
          </p>
        )}

        {goal && (
          <div className="ip-plan-block">
            <div className="ip-plan-kind">Goal</div>
            <div className="ip-plan-goal">{goal.text}</div>
          </div>
        )}
        {checklist && checklist.items.length > 0 && (
          <div className="ip-plan-block">
            <div className="ip-plan-kind">{checklist.title || "Checklist"}</div>
            <ul className="ip-checklist">
              {checklist.items.map((it) => (
                <li key={it.id} className={`ip-check-item${it.done ? " done" : ""}`}>
                  <span className="ip-check-glyph">{it.done ? "✓" : "○"}</span>
                  <span>{it.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Finish footer — pinned, calm (a definite end, not an alarm). */}
      <div className="ip-footer">
        {isEnding && (
          <div className="ip-ending" data-testid="playground-ending">
            <span className="mw-spinner" aria-hidden /> Wrapping up — saving your call summary. This lands in a few seconds.
          </div>
        )}
        <button className="ip-finish-btn" data-testid="end-call" onClick={onEnd} disabled={isEnding}>
          {isEnding ? "Finishing…" : "Finish listening"}
        </button>
      </div>
    </div>
  );
}

// ─── Post-call screen ─────────────────────────────────────────────────────────

function PostCallScreen(props: {
  callName: string;
  readCall: (name: string) => Promise<ParsedCall | null>;
  onBack: () => void;
  onViewMemory: () => void;
  setMemories: React.Dispatch<React.SetStateAction<Mem[]>>;
}): JSX.Element {
  const { callName, readCall, onBack, onViewMemory, setMemories } = props;
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
  const [savedMemId, setSavedMemId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const copyTranscript = () => {
    if (!call?.transcript || call.transcript.length === 0) return;
    // Export with the attendee's name (not a bare "Them") and an mm:ss timestamp
    // per line, so a pasted transcript reads like a real record.
    const them = call.attendee?.name || "Them";
    const baseMs = call.transcript[0].startMs;
    const text = call.transcript
      .map((u) => `[${intoCall(u.startMs, baseMs)}] ${u.speaker === "me" ? "You" : them}: ${u.text}`)
      .join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      setCopyError(true);
      setTimeout(() => setCopyError(false), 2500);
    });
  };

  const load = useCallback(() => {
    setLoading(true);
    readCall(callName).then((c) => { setCall(c); setLoading(false); });
  }, [callName, readCall]);

  useEffect(() => { load(); }, [load]);

  // The post-call recap was opened (once per mount — back to Home unmounts it).
  useEffect(() => { track("post_call_opened"); }, []);

  // Track which recap view is open: summary_opened on mount (the default tab)
  // and on each switch back, transcript_opened when the transcript tab is shown.
  useEffect(() => {
    track(tab === "transcript" ? "transcript_opened" : "summary_opened");
  }, [tab]);

  // Dwell time per recap sub-tab — emits screen_viewed for "post-call:summary" /
  // "post-call:transcript" on tab switch, unmount, and window hide.
  useScreenDwell(`post-call:${tab}`);

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
        const item = r.item as Mem;
        setMemories((list) => [...list, item]);
        setSavedMemId(item.id);
        setNote("");
        setNoteOpen(false);
        setNoteSaved(true);
      }
    });
  };

  // Undo the just-saved memory note — delete it and return to the add state.
  const undoNote = () => {
    if (!savedMemId) return;
    const id = savedMemId;
    void window.prompty.invoke("memory:delete", { id }).then((r) => {
      if (r.ok) setMemories((list) => list.filter((m) => m.id !== id));
    });
    setSavedMemId(null);
    setNoteSaved(false);
  };

  const handleScroll = () => {
    setScrolled((scrollRef.current?.scrollTop ?? 0) > 2);
  };

  const title = call?.title || call?.attendee?.name || "Call";
  const mins = call?.startedAt && call?.endedAt && call.endedAt > call.startedAt
    ? Math.max(1, Math.round((call.endedAt - call.startedAt) / 60000)) : null;
  // Legacy call logs carry an older summary schema ({goalRecap, items}) with no
  // recap/insights. Treat anything that isn't a current-shape summary as "no
  // summary" so we render the raw-log fallback rather than crashing on
  // `summary.insights.length`. (Pre-redesign logs that DO have recap+insights
  // still render — sanitize/the renderer fall `takeaway` back to legacy `text`.)
  const rawSummary = call?.summary;
  const summary =
    rawSummary &&
    typeof rawSummary.recap === "string" &&
    Array.isArray(rawSummary.insights)
      ? rawSummary
      : undefined;

  // The hero (company · serif title · duration/date) is the call's header and is
  // shared by every state — Summary, Transcript, Summarizing, raw fallback — so
  // each tab opens with the same structural shell and only the body differs.
  const hero = call ? (
    <div className="pcs-hero" data-testid="call-card">
      {call.attendee?.company && <div className="pcs-hero-company">{call.attendee.company}</div>}
      <h1 className="pcs-title">{title}</h1>
      {(mins || call.startedAt) && (
        <div className="pcs-meta-row">
          {mins && (
            <span className="pcs-meta-chip">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
                <path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {mins} min
            </span>
          )}
          {call.startedAt && (
            <span className="pcs-meta-chip">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.75" />
                <path d="M16 2v4M8 2v4M3 10h18" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
              </svg>
              {new Date(call.startedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            </span>
          )}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className="pcs-root">
      <div className="app-dragbar" />
      <div className="pcs-toprow app-drag">
        <div className="pcs-toprow-inner">
          <button className="pcs-back app-no-drag" data-testid="post-call-back" onClick={onBack}>← All calls</button>
          {tab === "transcript" && call && (
            <button
              className="pcs-copy-btn app-no-drag"
              data-testid="post-call-copy-transcript"
              onClick={copyTranscript}
              aria-label="Copy the transcript to the clipboard"
            >
              {copied ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span aria-live="polite">Copied!</span>
                </>
              ) : copyError ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/>
                    <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  <span aria-live="assertive">Couldn't copy</span>
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
      </div>
      {!loading && call && (
      <div className="pcs-tab-toggle" role="tablist" aria-label="Call view">
        <button role="tab" id="pcs-tab-summary" aria-selected={tab === "summary"} aria-controls="pcs-tabpanel" className={`pcs-tab${tab === "summary" ? " active" : ""}`} data-testid="post-call-tab-summary" onClick={() => setTab("summary")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M15 4H7M18 16L21 19L18 22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M3 4V17C3 17.5304 3.21071 18.0391 3.58579 18.4142C3.96086 18.7893 4.46957 19 5 19H21M7 14H14M7 9H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Summary
        </button>
        <button role="tab" id="pcs-tab-transcript" aria-selected={tab === "transcript"} aria-controls="pcs-tabpanel" className={`pcs-tab${tab === "transcript" ? " active" : ""}`} data-testid="post-call-tab-transcript" onClick={() => setTab("transcript")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M5 16C5 15.7348 5.10536 15.4804 5.29289 15.2929C5.48043 15.1054 5.73478 15 6 15H14C14.2652 15 14.5196 15.1054 14.7071 15.2929C14.8946 15.4804 15 15.7348 15 16C15 16.2652 14.8946 16.5196 14.7071 16.7071C14.5196 16.8946 14.2652 17 14 17H6C5.73478 17 5.48043 16.8946 5.29289 16.7071C5.10536 16.5196 5 16.2652 5 16ZM18 11C18.2652 11 18.5196 11.1054 18.7071 11.2929C18.8946 11.4804 19 11.7348 19 12C19 12.2652 18.8946 12.5196 18.7071 12.7071C18.5196 12.8946 18.2652 13 18 13H10C9.73478 13 9.48043 12.8946 9.29289 12.7071C9.10536 12.5196 9 12.2652 9 12C9 11.7348 9.10536 11.4804 9.29289 11.2929C9.48043 11.1054 9.73478 11 10 11H18ZM16 16C16 15.7348 16.1054 15.4804 16.2929 15.2929C16.4804 15.1054 16.7348 15 17 15H18C18.2652 15 18.5196 15.1054 18.7071 15.2929C18.8946 15.4804 19 15.7348 19 16C19 16.2652 18.8946 16.5196 18.7071 16.7071C18.5196 16.8946 18.2652 17 18 17H17C16.7348 17 16.4804 16.8946 16.2929 16.7071C16.1054 16.5196 16 16.2652 16 16ZM7 11C7.26522 11 7.51957 11.1054 7.70711 11.2929C7.89464 11.4804 8 11.7348 8 12C8 12.2652 7.89464 12.5196 7.70711 12.7071C7.51957 12.8946 7.26522 13 7 13H6C5.73478 13 5.48043 12.8946 5.29289 12.7071C5.10536 12.5196 5 12.2652 5 12C5 11.7348 5.10536 11.4804 5.29289 11.2929C5.48043 11.1054 5.73478 11 6 11H7Z" fill="currentColor"/>
            <path fillRule="evenodd" clipRule="evenodd" d="M4 3C3.20435 3 2.44129 3.31607 1.87868 3.87868C1.31607 4.44129 1 5.20435 1 6V18C1 18.7956 1.31607 19.5587 1.87868 20.1213C2.44129 20.6839 3.20435 21 4 21H20C20.7956 21 21.5587 20.6839 22.1213 20.1213C22.6839 19.5587 23 18.7956 23 18V6C23 5.20435 22.6839 4.44129 22.1213 3.87868C21.5587 3.31607 20.7956 3 20 3H4ZM20 5H4C3.73478 5 3.48043 5.10536 3.29289 5.29289C3.10536 5.48043 3 5.73478 3 6V18C3 18.2652 3.10536 18.5196 3.29289 18.7071C3.48043 18.8946 3.73478 19 4 19H20C20.2652 19 20.5196 18.8946 20.7071 18.7071C20.8946 18.5196 21 18.2652 21 18V6C21 5.73478 20.8946 5.48043 20.7071 5.29289C20.5196 5.10536 20.2652 5 20 5Z" fill="currentColor"/>
          </svg>
          Transcript
        </button>
      </div>
      )}
      <div className={`pcs-scroll-edge${scrolled ? " visible" : ""}`} />
      <div
        className="pcs-body"
        ref={scrollRef}
        onScroll={handleScroll}
        {...(!loading && call
          ? { role: "tabpanel", id: "pcs-tabpanel", "aria-labelledby": tab === "summary" ? "pcs-tab-summary" : "pcs-tab-transcript" }
          : {})}
      >
        {loading ? (
          <div className="pcs-loading">Loading…</div>
        ) : !call ? (
          <div className="pcs-load-error" data-testid="call-load-error">
            <p className="pcs-load-error-msg">Couldn't load this call.</p>
            <button className="pcs-retry-btn" data-testid="call-load-retry" onClick={load}>
              Try again
            </button>
          </div>
        ) : (
          <>
            {hero}
            <hr className="pcs-divider" />

            {tab === "transcript" ? (
              <TranscriptSection transcript={call.transcript} />
            ) : call.summaryPending ? (
              <div data-testid="call-summarizing">
                <div className="pcs-summarizing">
                  <div className="pcs-loading"><span className="mw-spinner" /> Summarizing this call…</div>
                  <p className="pcs-summarizing-sub">This takes a few seconds. You can leave — it'll be here when you're back.</p>
                </div>
                {/* Greyed recap skeleton so the page has shape while Ruby writes. */}
                <div className="pcs-recap-skeleton" aria-hidden>
                  <span className="pcs-skel-line" />
                  <span className="pcs-skel-line" />
                  <span className="pcs-skel-line short" />
                </div>
                <ChecklistCoverage components={call.components} />
              </div>
            ) : !summary ? (
              (call.transcript && call.transcript.length > 0) || rawSummary ? (
                // Legacy fallback — a log that predates the current summary shape
                // (an old summary blob and/or a transcript but no recap/insights).
                // Show the transcript rather than a raw JSON dump; the raw log is
                // dev-only.
                <>
                  <div className="pcs-legacy-note" data-testid="call-legacy-note">
                    {call.transcript && call.transcript.length > 0
                      ? "This call was recorded before summaries — here's the transcript."
                      : "This call was recorded before summaries, so there's no recap."}
                  </div>
                  <ChecklistCoverage components={call.components} />
                  {call.transcript && call.transcript.length > 0 && (
                    <TranscriptSection transcript={call.transcript} />
                  )}
                  {import.meta.env.DEV && <pre className="pcs-raw">{call.raw}</pre>}
                </>
              ) : (
                // No transcript was captured (e.g. a call ended before anyone
                // spoke). Nothing to summarize — a clean empty state, never JSON.
                <div className="pcs-empty-summary" data-testid="call-no-transcript">
                  No conversation was captured — the call ended before there was anything to transcribe.
                </div>
              )
            ) : (<>
            <div className="pcs-section-label pcs-recap-label">The gist</div>
            <p className="pcs-recap">{summary.recap}</p>

            {summary.insights.length > 0 && (() => {
              const assisted = summary.insights.filter((i) => i.assisted).length;
              return (
              <div className="pcs-section">
                <div className="pcs-section-label">Insights</div>
                {assisted > 0 && (
                  <p className="pcs-insight-attribution" data-testid="call-insight-attribution">
                    Ruby helped surface {assisted} of {summary.insights.length === 1 ? "this" : "these"}.
                  </p>
                )}
                <ul className="pcs-insight-list" data-testid="call-insights">
                  {summary.insights.map((ins, i) => (
                    <li key={i} className="pcs-insight-item">
                      <p className="pcs-insight-take">{ins.takeaway ?? ins.text}</p>
                      {ins.quote && <p className="pcs-insight-quote">{ins.quote}</p>}
                      {ins.assisted && (
                        <span className="pcs-insight-via">{ins.via || "Surfaced after a Ruby nudge"}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              );
            })()}

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
                <div className="pcs-memory-savedactions">
                  <button className="pcs-memory-link" data-testid="nudge-note-view" onClick={onViewMemory}>View</button>
                  <button className="pcs-memory-link" data-testid="nudge-note-undo" onClick={undoNote}>Undo</button>
                </div>
              </div>
            ) : noteOpen ? (
              <div className="pcs-memory-card pcs-memory-open">
                <div className="pcs-memory-content">
                  <div className="pcs-memory-title">Tell Ruby what to remember</div>
                  <textarea
                    className="pcs-note-input"
                    data-testid="nudge-note-input"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. Hold pricing nudges until they bring up budget."
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
                  <div className="pcs-memory-title">Tell Ruby what to remember</div>
                  <div className="pcs-memory-desc">Want Ruby to nudge differently? Leave a note and it'll adjust next call.</div>
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
  memUndo: Mem | null;
  onUndoDelete: () => void;
  onBack: () => void;
}): JSX.Element {
  const { memories, newMemory, setNewMemory, editingMem, setEditingMem, addMemory, saveMemoryEdit, deleteMemory, memUndo, onUndoDelete, onBack } = props;
  useScreenDwell("memory");
  return (
    <div className="fullscreen-root">
      <div className="app-dragbar" />
      <div className="pcs-toprow app-drag">
        <div className="pcs-toprow-inner">
          <button className="pcs-back app-no-drag" onClick={onBack}>← Back</button>
        </div>
      </div>
      <div className="fullscreen-body" style={{ paddingTop: 60 }}>
        <h1 className="mem-title">Memory</h1>
        <p className="fullscreen-intro">Tell me how to nudge you. These apply to every call.</p>

        <div className="mem-add-card">
          <input
            className="mem-add-input"
            data-testid="memory-input"
            value={newMemory}
            placeholder="e.g. Nudge me rarely — only when it really matters."
            aria-label="Add a memory — how Ruby should nudge you"
            onChange={(e) => setNewMemory(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addMemory(); }}
          />
          <button className="mem-add-btn" data-testid="memory-add" onClick={addMemory} disabled={!newMemory.trim()} aria-label="Add memory">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        {newMemory.trim() && <div className="mem-add-hint">Press Enter to add</div>}

        {memories.length === 0 ? (
          <div className="mem-empty" data-testid="memory-empty">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 21h10a2 2 0 0 0 2 -2v-14a2 2 0 0 0 -2 -2h-6.172a2 2 0 0 0 -1.414 .586l-3.828 3.828a2 2 0 0 0 -.586 1.414v10.172a2 2 0 0 0 2 2" />
              <path d="M13 6v2" /><path d="M16 6v2" /><path d="M10 7v1" />
            </svg>
            <div className="mem-empty-title">Teach me how to nudge you</div>
            <div className="mem-empty-body">
              Memories are standing notes about how I nudge you — they apply to every call.
              For example: “Don't interrupt when I'm mid-sentence” or “Push me harder on pricing.”
            </div>
          </div>
        ) : (
          <>
            <div className="mem-section-label">{memories.length} {memories.length === 1 ? "memory" : "memories"}</div>
            <ul className="mem-list" data-testid="memory-list">
              {memories.map((m) => {
                const isEdit = editingMem?.id === m.id;
                return (
                  <li key={m.id} className="mem-item" data-testid="memory-item">
                    {isEdit ? (
                      <div className="mem-edit-wrap">
                        <input autoFocus className="mem-edit-input" value={editingMem.draft}
                          aria-label="Edit memory"
                          onChange={(e) => setEditingMem({ id: m.id, draft: e.target.value })}
                          onKeyDown={(e) => { if (e.key === "Enter") saveMemoryEdit(); if (e.key === "Escape") setEditingMem(null); }}
                          onBlur={saveMemoryEdit} />
                        <span className="mem-edit-hint">Enter to save · Esc to cancel</span>
                      </div>
                    ) : (
                      <>
                        <span className="mem-text">{m.text}</span>
                        <div className="mem-actions">
                          {m.source === "suggested" && <span className="mem-tag">suggested</span>}
                          <button className="mem-action-btn" aria-label="Edit memory" onClick={() => setEditingMem({ id: m.id, draft: m.text })}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </button>
                          <button className="mem-action-btn mem-action-del" data-testid="memory-delete" aria-label="Delete memory" onClick={() => deleteMemory(m.id)}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                              <polyline points="3 6 5 6 21 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                              <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
      {memUndo && (
        <div className="mem-undo-toast" data-testid="memory-undo" role="status" aria-live="polite">
          <span className="mem-undo-text">Memory deleted</span>
          <button className="mem-undo-btn" data-testid="memory-undo-btn" onClick={onUndoDelete}>Undo</button>
        </div>
      )}
    </div>
  );
}

// ─── Settings screen ──────────────────────────────────────────────────────────

const MIC_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

function SettingsScreen(props: {
  micStatus: string | null;
  claude: { found: boolean; path: string | null } | null;
  hotkey: string;
  account: { signedIn: boolean; email?: string } | null;
  authBusy: boolean;
  signIn: () => void;
  signOut: () => void;
  refreshMic: () => void;
  refreshClaude: () => void;
  onBack: () => void;
}): JSX.Element {
  const { micStatus, claude, hotkey, account, authBusy, signIn, signOut, refreshMic, refreshClaude, onBack } = props;
  useScreenDwell("settings");
  const micOk = micStatus === "granted";
  const micBlocked = micStatus === "denied" || micStatus === "restricted";
  // M11: map the raw permission enum to plain language.
  const micFriendly =
    micStatus === "granted" ? "Allowed"
    : micStatus === "denied" ? "Blocked"
    : micStatus === "restricted" ? "Restricted by your device"
    : micStatus ?? "checking…";

  // M4: the Swift sidecar always follows the macOS default input device — there
  // is no in-app picker. Make that legible by naming the live device. Labels
  // only populate once mic permission is granted, so re-read on micStatus change.
  const [defaultInput, setDefaultInput] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    navigator.mediaDevices?.enumerateDevices?.().then((devs) => {
      if (!active) return;
      const inputs = devs.filter((d) => d.kind === "audioinput");
      const def = inputs.find((d) => d.deviceId === "default") ?? inputs[0];
      const label = def?.label?.replace(/^Default\s*[-–]\s*/i, "").trim();
      setDefaultInput(label || null);
    }).catch(() => {});
    return () => { active = false; };
  }, [micStatus]);

  // M4b: only surface the Debug logs row when the PROMPTY_DEBUG switch is on.
  const [debugEnabled, setDebugEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    window.prompty.invoke("debug:enabled", undefined as never)
      .then((r) => { if (active) setDebugEnabled(r.enabled); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  // Account (Google sign-in) is owned by App (so Home can react to it too); this
  // screen just drives the local confirm-before-sign-out interaction.
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  // Analytics opt-out (capture is on by default). Read once; persist on toggle.
  const [analyticsOptOut, setAnalyticsOptOut] = useState(false);
  useEffect(() => {
    let active = true;
    window.prompty.invoke("settings:get", undefined as never)
      .then((s) => { if (active) setAnalyticsOptOut((s as { analyticsOptOut?: boolean }).analyticsOptOut === true); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  const toggleAnalytics = () => {
    const next = !analyticsOptOut;
    setAnalyticsOptOut(next);
    void window.prompty.invoke("settings:set", { analyticsOptOut: next });
  };

  return (
    <div className="fullscreen-root">
      <div className="app-dragbar" />
      <div className="pcs-toprow app-drag">
        <div className="pcs-toprow-inner">
          <button className="pcs-back app-no-drag" onClick={onBack}>← Back</button>
        </div>
      </div>
      <div className="fullscreen-body" style={{ paddingTop: 60 }}>
        <h1 className="mem-title fullscreen-h1">Settings</h1>
        <p className="fullscreen-intro">How Ruby connects to your mic, Claude Code, and account.</p>

        <div className="set-group-label">Permissions</div>
        <div className="set-group">
          <SettingRow
            label="Microphone"
            value={micFriendly}
            tone={micOk ? "green" : micBlocked ? "red" : "amber"}
            pill={micOk ? "Allowed" : undefined}
            hint={micOk ? `Listening to: ${defaultInput ?? "your default microphone"}` : undefined}
          >
            {!micOk && (micBlocked
              ? <button className="set-btn" onClick={() => window.prompty.invoke("onboarding:open-external", { url: MIC_SETTINGS_URL })}>Open System Settings</button>
              : <button className="set-btn set-btn-accent" onClick={() => { window.prompty.invoke("onboarding:request-mic", undefined as never).catch(() => {}); refreshMic(); }}>Grant access</button>
            )}
          </SettingRow>
          <SettingRow
            label="Claude Code"
            value={claude ? (claude.found ? "Connected" : "Not found") : "checking…"}
            tone={claude?.found ? "green" : claude ? "red" : "amber"}
            pill={claude?.found ? "Connected" : undefined}
            valueTitle={claude?.path ?? undefined}
            hint="Ruby thinks with Claude Code — it drafts your prep and live nudges."
          >
            <button className="set-btn" onClick={refreshClaude}>Re-check</button>
          </SettingRow>
        </div>

        <div className="set-group-label">Account</div>
        <div className="set-group">
          <SettingRow
            label="Account"
            value={account ? (account.signedIn ? account.email ?? "Signed in" : "Not signed in") : "checking…"}
            tone={account?.signedIn ? "green" : account ? "amber" : "muted"}
            pill={account?.signedIn ? "Signed in" : undefined}
          >
            {account && (account.signedIn
              ? (confirmingSignOut
                  ? <div className="set-confirm">
                      <span className="set-confirm-text">Sign out? You'll need to sign in again to use transcription and the relay.</span>
                      <button className="set-btn" onClick={() => setConfirmingSignOut(false)}>Cancel</button>
                      <button className="set-btn set-btn-danger" disabled={authBusy} onClick={() => { setConfirmingSignOut(false); signOut(); }}>Sign out</button>
                    </div>
                  : <button className="set-btn" disabled={authBusy} onClick={() => setConfirmingSignOut(true)}>Sign out</button>)
              : <button className="set-btn set-btn-accent" disabled={authBusy} onClick={signIn}>Sign in with Google</button>
            )}
          </SettingRow>
        </div>

        <div className="set-group-label">Advanced</div>
        <div className="set-group">
          <SettingRow
            label="Hotkey — nudge on demand"
            value={hotkey}
            tone="muted"
            hint="Press it anywhere to ask Ruby for a nudge mid-call."
          />
          {debugEnabled && (
            <SettingRow label="Debug logs" value="~/.prompty/debug" tone="muted">
              <button className="set-btn" onClick={() => window.prompty.invoke("debug:reveal", undefined as never)}>Open folder</button>
            </SettingRow>
          )}
        </div>

        <div className="set-group-label">Privacy</div>
        <div className="set-group">
          <SettingRow
            label="Share anonymous usage data"
            value={analyticsOptOut ? "Off" : "On"}
            tone={analyticsOptOut ? "muted" : "green"}
            hint="Anonymous product analytics that help improve Ruby — usage events only, never your call audio, transcripts, or notes."
          >
            <button className="set-btn" data-testid="set-analytics-toggle" onClick={toggleAnalytics}>
              {analyticsOptOut ? "Turn on" : "Turn off"}
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
  pill?: string;        // right-side status pill, e.g. "Connected" / "Signed in" / "Allowed"
  hint?: string;        // one-line explanation below the value
  valueTitle?: string;  // tooltip on the value (e.g. the full Claude path)
  children?: React.ReactNode;
}): JSX.Element {
  return (
    <div className="set-row">
      <div className="set-row-main">
        <div className="set-label">{props.label}</div>
        <div className={`set-val set-val-${props.tone}`} title={props.valueTitle}>
          {props.tone === "green" && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ marginRight: 5, verticalAlign: 'middle', marginBottom: 1, flexShrink: 0 }}>
              <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
          {props.value}
        </div>
        {props.hint && <div className="set-hint">{props.hint}</div>}
      </div>
      <div className="set-row-right">
        {props.pill && <span className="set-connected-pill">{props.pill}</span>}
        {props.children && <div className="set-control">{props.children}</div>}
      </div>
    </div>
  );
}
