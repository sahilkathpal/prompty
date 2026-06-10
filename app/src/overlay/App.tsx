import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DragHandle } from "./components/DragHandle";
import { GoalBanner } from "./components/GoalBanner";
import { Checklist } from "./components/Checklist";
import { NudgeFeed } from "./components/NudgeFeed";
import type {
  AppSettings,
  ChecklistItem,
  ChecklistStatus,
  CallSetup,
  Nudge,
  SessionStatus,
} from "@shared/types";

type SessionState = "idle" | "starting" | "live" | "ending" | "ended" | "error";

const STATUS_META: Record<SessionStatus, { label: string; tone: "amber" | "green" | "red" }> = {
  starting: { label: "Starting…", tone: "amber" },
  listening: { label: "Listening", tone: "green" },
  "no-audio": { label: "No audio", tone: "amber" },
  "mic-silent": { label: "No mic audio", tone: "red" },
  reconnecting: { label: "Reconnecting", tone: "red" },
  error: { label: "Error", tone: "red" },
};

export default function App(): JSX.Element {
  const [goal, setGoal] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [statusReason, setStatusReason] = useState<string | null>(null);
  const [headsUpBar, setHeadsUpBar] = useState(true);
  const [nudges, setNudges] = useState<Nudge[]>([]);

  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevHeadsUp = useRef(headsUpBar);

  useEffect(() => {
    window.prompty
      .invoke("session:state", undefined as never)
      .then((r) => {
        setSessionState(r.state);
        if (r.setup) {
          setGoal(r.setup.goal || null);
          setChecklist(r.setup.checklist ?? []);
        }
      })
      .catch(() => {});

    window.prompty
      .invoke("settings:get", undefined as never)
      .then((s: AppSettings) => setHeadsUpBar(s.headsUpBar !== false))
      .catch(() => {});

    const offSetup = window.prompty.on("session:setup", (p) => {
      const s: CallSetup = p.setup;
      setGoal(s.goal || null);
      setChecklist(s.checklist ?? []);
    });
    const offState = window.prompty.on("session:state-changed", (p) => {
      setSessionState(p.state);
      if (p.state === "starting") {
        setNudges([]);
        setStatus("starting");
      }
      if (p.state === "ended" || p.state === "idle") {
        setStatus(null);
      }
      if (p.setup !== undefined) {
        if (p.setup) {
          setGoal(p.setup.goal || null);
          setChecklist(p.setup.checklist ?? []);
        } else {
          setGoal(null);
          setChecklist([]);
        }
      }
    });
    const offStatus = window.prompty.on("session:status", (p) => {
      setStatus(p.state);
      setStatusReason(p.reason ?? null);
    });
    const offSettings = window.prompty.on("settings:changed", (s: AppSettings) => {
      setHeadsUpBar(s.headsUpBar !== false);
    });
    const offNudge = window.prompty.on("nudge:received", (n: Nudge) => {
      setNudges((cur) => [n, ...cur].slice(0, 50));
    });

    return () => {
      offSetup();
      offState();
      offStatus();
      offSettings();
      offNudge();
    };
  }, []);

  const onToggleCheck = useCallback((id: string, status: ChecklistStatus) => {
    setChecklist((cur) => cur.map((it) => (it.id === id ? { ...it, status } : it)));
    window.prompty.invoke("checklist:toggle", { id, status });
  }, []);

  const endSession = useCallback(async () => {
    await window.prompty.invoke("call:end", undefined as never);
  }, []);

  const askPrompty = useCallback(() => {
    void window.prompty.invoke("nudge:request", { source: "panel" });
  }, []);

  // Ask the main process to fit the window height to the overlay's content.
  // The scroll body is flex:1, so its own scrollHeight just mirrors the window
  // height (it can't tell us the content's natural size). Instead we measure
  // the inner content wrapper (a flow-root, so child margins are contained) and
  // add the fixed chrome above/below it: chrome = rootHeight - bodyViewport, and
  // the body needs contentHeight + its own vertical padding.
  const fitHeight = useCallback((mode: "grow" | "exact") => {
    const root = rootRef.current;
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!root || !body || !content) return;
    const cs = window.getComputedStyle(body);
    const bodyPad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const chrome = root.clientHeight - body.clientHeight;
    const target = Math.ceil(chrome + content.offsetHeight + bodyPad);
    void window.prompty.invoke("overlay:set-height", { height: target, mode });
  }, []);

  // Resize on the heads-up-bar toggle (and as content grows). Toggling the bar
  // ON hides the feed → snap the height down ("exact"). Every other case only
  // grows, so a height the user dragged taller is never fought.
  useLayoutEffect(() => {
    const toggledFeedHidden = headsUpBar && !prevHeadsUp.current;
    prevHeadsUp.current = headsUpBar;
    fitHeight(toggledFeedHidden ? "exact" : "grow");
  }, [headsUpBar, goal, checklist, nudges, fitHeight]);

  const toggleHeadsUpBar = useCallback(() => {
    setHeadsUpBar((cur) => {
      const next = !cur;
      window.prompty.invoke("settings:set", { headsUpBar: next });
      return next;
    });
  }, []);

  const isLive = sessionState === "live" || sessionState === "starting";
  const meta = status ? STATUS_META[status] : null;

  return (
    <div className="prompty-root" data-testid="overlay-root" ref={rootRef}>
      <DragHandle />

      <div className="prompty-overlay-header">
        <div
          className="prompty-status"
          data-testid="overlay-status"
          title={statusReason ?? undefined}
        >
          {meta ? (
            <>
              <span
                data-testid="overlay-status-dot"
                data-tone={meta.tone}
                className={`prompty-status-dot prompty-status-${meta.tone}${
                  status === "listening" ? " pulsing" : ""
                }`}
              />
              <span data-testid="overlay-status-label" className="prompty-status-label">
                {meta.label}
              </span>
              {status === "mic-silent" && statusReason ? (
                <span
                  data-testid="overlay-status-reason"
                  className="prompty-status-reason"
                >
                  {statusReason}
                </span>
              ) : null}
            </>
          ) : (
            <span className="prompty-status-label prompty-status-idle">Idle</span>
          )}
        </div>

        <button
          onClick={toggleHeadsUpBar}
          data-testid="overlay-headsup-toggle"
          role="switch"
          aria-checked={headsUpBar}
          aria-label="Heads-up bar"
          title="Heads-up bar — flash nudges in the floating bar"
          className={`prompty-headsup-switch${headsUpBar ? " on" : ""}`}
        >
          <span className="prompty-switch-label">Heads-up bar</span>
          <span className="prompty-switch-track" aria-hidden>
            <span className="prompty-switch-thumb" />
          </span>
        </button>
      </div>

      <div className="prompty-body-scroll" ref={bodyRef}>
        <div className="prompty-body-content" ref={contentRef}>
          <GoalBanner goal={goal} />
          <Checklist items={checklist} onToggle={onToggleCheck} />
          {/* When the heads-up bar is OFF, nudges collect here as a feed. When ON,
              they flash in the floating teleprompter bar instead. */}
          {!headsUpBar && <NudgeFeed nudges={nudges} />}
        </div>
      </div>

      {isLive && (
        <div className="prompty-overlay-actions">
          {/* Quiet suggestion, not a call-to-action: the hotkey is the primary
              way to ask; clicking the hint just mirrors it. */}
          <button
            data-testid="overlay-ask"
            onClick={askPrompty}
            className="prompty-ask-hint-btn"
            title="Ask Prompty what to say next"
          >
            Stuck? <kbd className="prompty-kbd">⌥⇧Space</kbd> to ask
          </button>
          <button
            data-testid="overlay-end-session"
            onClick={endSession}
            className="prompty-end-btn"
          >
            End
          </button>
        </div>
      )}
    </div>
  );
}
