import React, { useCallback, useEffect, useState } from "react";
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
  reconnecting: { label: "Reconnecting", tone: "red" },
  error: { label: "Error", tone: "red" },
};

export default function App(): JSX.Element {
  const [goal, setGoal] = useState<string | null>(null);
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [headsUpBar, setHeadsUpBar] = useState(true);
  const [nudges, setNudges] = useState<Nudge[]>([]);

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
    <div className="prompty-root" data-testid="overlay-root">
      <DragHandle />

      <div className="prompty-overlay-header">
        <div className="prompty-status" data-testid="overlay-status">
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
            </>
          ) : (
            <span className="prompty-status-label prompty-status-idle">Idle</span>
          )}
        </div>

        <button
          onClick={toggleHeadsUpBar}
          data-testid="overlay-headsup-toggle"
          aria-pressed={headsUpBar}
          title={headsUpBar ? "Heads-up bar on" : "Heads-up bar off"}
          className={`prompty-headsup-toggle${headsUpBar ? " on" : ""}`}
        >
          Heads-up bar {headsUpBar ? "on" : "off"}
        </button>
      </div>

      <div className="prompty-body-scroll">
        <GoalBanner goal={goal} />
        <Checklist items={checklist} onToggle={onToggleCheck} />
        {/* When the heads-up bar is OFF, nudges collect here as a feed. When ON,
            they flash in the floating teleprompter bar instead. */}
        {!headsUpBar && <NudgeFeed nudges={nudges} />}
      </div>

      {isLive && (
        <div className="prompty-overlay-actions">
          <button
            data-testid="overlay-ask"
            onClick={askPrompty}
            className="prompty-ask-btn"
            title="Ask Prompty what to say next (⌥⇧Space)"
          >
            What should I ask?
          </button>
          <span className="prompty-ask-hint" aria-hidden>
            ⌥⇧Space
          </span>
          <button
            data-testid="overlay-end-session"
            onClick={endSession}
            className="prompty-end-btn"
          >
            End session
          </button>
        </div>
      )}
    </div>
  );
}
