import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DragHandle } from "./components/DragHandle";
import Gem, { type GemState } from "@shared/Gem";
import type { Nudge, SessionStatus } from "@shared/types";

type SessionState = "idle" | "starting" | "live" | "ending" | "ended" | "error";

// The gem's glow encodes the live session status. tone drives the CSS color of
// the gem's halo; "calm" green = listening, amber = transient, red = trouble.
const STATUS_META: Record<
  SessionStatus,
  { label: string; tone: "amber" | "green" | "red" }
> = {
  starting: { label: "Starting…", tone: "amber" },
  listening: { label: "Listening", tone: "green" },
  "no-audio": { label: "No audio", tone: "amber" },
  "mic-silent": { label: "No mic audio", tone: "red" },
  reconnecting: { label: "Reconnecting", tone: "red" },
  error: { label: "Error", tone: "red" },
};

// --- Bloom pacing (ported from the deleted teleprompter App.tsx) -----------
// A note must stay readable: it holds the bloom for at least DWELL_MS before a
// queued newer note may replace it, lingers HIDE_MS when nothing is queued
// before fading, and a queued note older than STALE_MS is dropped unshown. A
// high-urgency nudge preempts whatever is showing immediately. Test runs can
// shrink these via query params (PROMPTY_OVERLAY_{DWELL,HIDE,STALE}_MS, passed
// through the same ?dwellMs/&hideMs/&staleMs the teleprompter used).
const DEFAULT_DWELL_MS = 2500;
const DEFAULT_HIDE_MS = 8000;
const DEFAULT_STALE_MS = 12_000;
const MAX_QUEUE = 3;

function readParam(name: string, fallback: number): number {
  try {
    const raw = new URLSearchParams(window.location.search).get(name);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

interface Queued {
  nudge: Nudge;
  at: number;
}

export default function App(): JSX.Element {
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [statusReason, setStatusReason] = useState<string | null>(null);

  // The single note currently bloomed beneath the gem (or null = nothing
  // showing). Ephemeral: it fades on its own and nothing accumulates on screen.
  const [bloom, setBloom] = useState<Nudge | null>(null);
  // Every note surfaced this call, newest first. Retained in renderer state for
  // the session and shown only when the gem is expanded (decision #5).
  const [history, setHistory] = useState<Nudge[]>([]);
  // Whether the gem is expanded into the scrollback history list.
  const [expanded, setExpanded] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // --- bloom pacing state (refs, not React state, mirrors teleprompter) ----
  const queue = useRef<Queued[]>([]);
  const shownAt = useRef(0);
  const hasCurrent = useRef(false);
  const dwellMs = useRef(readParam("dwellMs", DEFAULT_DWELL_MS)).current;
  const hideMs = useRef(readParam("hideMs", DEFAULT_HIDE_MS)).current;
  const staleMs = useRef(readParam("staleMs", DEFAULT_STALE_MS)).current;

  const show = useCallback((n: Nudge) => {
    setBloom(n);
    shownAt.current = Date.now();
    hasCurrent.current = true;
  }, []);

  useEffect(() => {
    window.prompty
      .invoke("session:state", undefined as never)
      .then((r) => {
        setSessionState(r.state);
      })
      .catch(() => {});

    const offState = window.prompty.on("session:state-changed", (p) => {
      setSessionState(p.state);
      if (p.state === "starting") {
        setStatus("starting");
        // New call: clear any lingering note + history + queue so nothing from
        // a previous call bleeds into this one.
        queue.current = [];
        hasCurrent.current = false;
        setBloom(null);
        setHistory([]);
        setExpanded(false);
      }
      if (p.state === "ended" || p.state === "idle") {
        setStatus(null);
        queue.current = [];
        hasCurrent.current = false;
        setBloom(null);
      }
    });

    const offStatus = window.prompty.on("session:status", (p) => {
      setStatus(p.state);
      setStatusReason(p.reason ?? null);
    });

    const offNudge = window.prompty.on("nudge:received", (n: Nudge) => {
      if (!n?.text) return;
      // Retain in history regardless of how/whether it blooms.
      setHistory((cur) => [n, ...cur].slice(0, 200));
      if (n.urgency === "high") {
        // Preempt whatever is showing — urgent notes can't wait out the dwell.
        show(n);
        return;
      }
      queue.current.push({ nudge: n, at: Date.now() });
      // Cap the backlog: drop from the middle so both the oldest still-queued
      // and the newest survive.
      while (queue.current.length > MAX_QUEUE) {
        queue.current.splice(Math.floor(queue.current.length / 2), 1);
      }
      if (!hasCurrent.current) {
        const next = queue.current.shift();
        if (next) show(next.nudge);
      }
    });

    const prune = () => {
      const now = Date.now();
      queue.current = queue.current.filter((e) => now - e.at <= staleMs);
    };
    const advance = () => {
      prune();
      const next = queue.current.shift();
      if (next) {
        show(next.nudge);
      } else {
        setBloom(null);
        hasCurrent.current = false;
      }
    };

    const tick = setInterval(() => {
      prune();
      const elapsed = Date.now() - shownAt.current;
      if (hasCurrent.current) {
        if (queue.current.length > 0) {
          // A newer note is waiting: replace once the minimum dwell has passed.
          if (elapsed >= dwellMs) advance();
        } else if (elapsed >= hideMs) {
          // Nothing queued: let the lone note linger, then fade.
          setBloom(null);
          hasCurrent.current = false;
        }
      } else if (queue.current.length > 0) {
        advance();
      }
    }, 200);

    return () => {
      offState();
      offStatus();
      offNudge();
      clearInterval(tick);
    };
  }, [show, dwellMs, hideMs, staleMs]);

  // Resize the window to fit the current state (gem-only / gem+bloom /
  // gem+history). We measure the content wrapper's natural height and ask the
  // main process to snap the window to it. Runs whenever the visible state
  // changes.
  const fitHeight = useCallback(() => {
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content) return;
    const target = Math.ceil(content.offsetHeight);
    void window.prompty.invoke("overlay:set-height", { height: target });
  }, []);

  useLayoutEffect(() => {
    fitHeight();
  }, [bloom, expanded, history, status, fitHeight]);

  const toggleExpanded = useCallback(() => {
    setExpanded((cur) => !cur);
  }, []);

  const isEnding = sessionState === "ending";
  // End the call straight from the gem — the same teardown the main window and
  // tray drive. Re-clicks are guarded: once "ending", the button disables and
  // end() would early-return anyway.
  const endCall = useCallback(() => {
    if (sessionState === "ending") return;
    void window.prompty.invoke("call:end", undefined as never);
  }, [sessionState]);

  // Drag-to-move vs click-to-expand on the pill. A native app-region drag region
  // can't also receive the expand click, so we drive movement ourselves: press
  // and move the pill past a small threshold to drag the window (overlay:move-by
  // with the screen-space delta); a press with no movement is a plain click.
  const drag = useRef({ active: false, lastX: 0, lastY: 0, moved: false });
  const onGemMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    drag.current = { active: true, lastX: e.screenX, lastY: e.screenY, moved: false };
    const onMove = (ev: MouseEvent) => {
      const d = drag.current;
      if (!d.active) return;
      const dx = ev.screenX - d.lastX;
      const dy = ev.screenY - d.lastY;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      d.moved = true;
      d.lastX = ev.screenX;
      d.lastY = ev.screenY;
      void window.prompty.invoke("overlay:move-by", { dx, dy });
    };
    const onUp = () => {
      drag.current.active = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);
  const onGemClick = useCallback(() => {
    // Swallow the click that ends a drag so moving never toggles the history.
    if (drag.current.moved) {
      drag.current.moved = false;
      return;
    }
    toggleExpanded();
  }, [toggleExpanded]);

  // Click-away: a click that lands on the transparent root (i.e. outside the
  // gem and the history surface) collapses the expanded history back to the
  // calm single-gem state.
  const onRootClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget || e.target === contentRef.current) {
      setExpanded(false);
    }
  }, []);

  const meta = status ? STATUS_META[status] : null;
  const tone = meta?.tone ?? "idle";

  // The gem's expressive state, derived entirely from data already in hand —
  // no new IPC. A bloomed note means "worth asking"; trouble means concern;
  // otherwise it tracks the live listening status, or sleeps when idle.
  const liveish = sessionState === "live" || sessionState === "starting";
  const gemState: GemState = isEnding
    ? "thinking"
    : bloom
      ? "worth-asking"
      : status === "error" || status === "no-audio" || status === "mic-silent"
        ? "attention"
        : status === "reconnecting" || status === "starting"
          ? "thinking"
          : status === "listening" || liveish
            ? "listening"
            : "idle";

  return (
    <div
      className="gem-root"
      data-testid="overlay-root"
      ref={rootRef}
      onClick={onRootClick}
    >
      {/* The whole gem surface is draggable except the interactive gem button
          and the history list. */}
      <div className="gem-content" ref={contentRef}>
        <DragHandle />

        <div className="gem-anchor-row">
          <button
            type="button"
            className={`gem${expanded ? " gem-expanded" : ""}`}
            data-testid="gem"
            data-tone={tone}
            data-status={status ?? "idle"}
            aria-label={meta ? meta.label : "Idle"}
            title={statusReason ?? meta?.label ?? "Idle"}
            onMouseDown={onGemMouseDown}
            onClick={onGemClick}
          >
            <Gem variant="pill" state={gemState} />
          </button>
        </div>

        {/* Discoverability: a faint caret signals the gem expands (into the
            note history + End-call control) when notes are waiting and nothing
            is currently bloomed. */}
        {!expanded && !bloom && (history.length > 0 || liveish) && (
          <div className="gem-expand-hint" data-testid="gem-expand-hint" aria-hidden>
            ⌄
          </div>
        )}

        {/* Bloom: one ephemeral note directly beneath the gem. The draining
            bar visualizes the auto-fade countdown (re-keyed per note so it
            restarts on every swap / high-urgency preempt). */}
        {bloom && !expanded && (
          <div
            className={`gem-bloom${bloom.urgency === "high" ? " gem-bloom-high" : ""}`}
            data-testid="gem-bloom"
            data-nudge-id={bloom.id}
          >
            <div className="gem-note-tag">Worth asking</div>
            <div className="gem-note-q">{bloom.text}</div>
            <div className="gem-note-bar">
              <div
                key={bloom.id}
                className="gem-note-fill"
                style={{ animationDuration: `${hideMs}ms` }}
              />
            </div>
          </div>
        )}

        {/* Expanded panel: a quiet scrollback of every note this call, plus an
            End-call control so the call can be ended without hunting for the
            tray or main window. */}
        {expanded && (
          <div className="gem-panel" data-testid="gem-panel">
            <div className="gem-history" data-testid="gem-history">
              {history.length === 0 ? (
                <div className="gem-history-empty">No notes yet this call.</div>
              ) : (
                <ul className="gem-history-list">
                  {history.map((n) => (
                    <li
                      key={n.id}
                      className="gem-history-item"
                      data-testid={`gem-history-item-${n.id}`}
                    >
                      <span className="gem-history-time">
                        {new Date(n.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="gem-history-text">{n.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="gem-actions">
              <button
                type="button"
                className="gem-end-btn"
                data-testid="gem-end"
                disabled={isEnding}
                onClick={endCall}
              >
                {isEnding ? "Ending…" : "End call"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
