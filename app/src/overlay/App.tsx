import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Gem, { type GemState } from "@shared/Gem";
import type { Nudge, SessionStatus } from "@shared/types";

type SessionState = "idle" | "starting" | "live" | "ending" | "ended" | "error";

// Fire a product-analytics event. The main process owns identity + base props
// (see electron/analytics.ts); the overlay only ever sends metadata — never
// note text or transcript content.
function track(event: string, properties?: Record<string, unknown>): void {
  void window.prompty.invoke("analytics:capture", { event, properties });
}

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
  "them-silent": { label: "Reconnecting them", tone: "amber" },
  "them-lost": { label: "Not capturing them", tone: "red" },
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
  // The current bloom's true on-screen lifetime (ms) — dwellMs when a newer
  // note is already queued behind it, hideMs when it's alone. Drives the drain
  // bar so the bar empties exactly when the note actually leaves (V1).
  const [bloomMs, setBloomMs] = useState(DEFAULT_HIDE_MS);
  // True during the brief exit fade after a note is cleared but before it's
  // unmounted, so the bloom animates out instead of hard-cutting (V14).
  const [hiding, setHiding] = useState(false);
  // Every note surfaced this call, newest first. Retained in renderer state for
  // the session and shown only when the gem is expanded (decision #5).
  const [history, setHistory] = useState<Nudge[]>([]);
  // The panel (history + end-call) opens on HOVER over the gem; a CLICK pins it
  // open so it survives the cursor leaving. `expanded` is the hover-open state;
  // `pinned` is the click-locked state. Panel shows when either is true. This is
  // the fix for "the end button is hidden behind a click" — hovering reveals it.
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const pinnedRef = useRef(false);
  useEffect(() => { pinnedRef.current = pinned; }, [pinned]);
  const expandedRef = useRef(false);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  // Hover-intent: leaving the pill doesn't collapse the panel instantly, so the
  // cursor can travel down to the panel (and its Finish button) without the
  // expansion vanishing under it. Re-entering the gem/panel cancels the timer.
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // First-call only: the one-time "ready" primer that re-homes the cut hotkey
  // demo into the live moment. Driven by the firstCall flag on session state.
  const [firstCall, setFirstCall] = useState(false);
  const [primerDismissed, setPrimerDismissed] = useState(false);
  const [rubyMessage, setRubyMessage] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // --- bloom pacing state (refs, not React state, mirrors teleprompter) ----
  const queue = useRef<Queued[]>([]);
  const shownAt = useRef(0);
  const hasCurrent = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dwellMs = useRef(readParam("dwellMs", DEFAULT_DWELL_MS)).current;
  const hideMs = useRef(readParam("hideMs", DEFAULT_HIDE_MS)).current;
  const staleMs = useRef(readParam("staleMs", DEFAULT_STALE_MS)).current;

  const show = useCallback(
    (n: Nudge) => {
      // Cancel any in-flight exit fade — a fresh note takes over the bloom.
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setHiding(false);
      setBloom(n);
      // If another note is already waiting, this one only holds for the dwell
      // before it's replaced; alone, it lingers the full hide window.
      setBloomMs(queue.current.length > 0 ? dwellMs : hideMs);
      shownAt.current = Date.now();
      hasCurrent.current = true;
    },
    [dwellMs, hideMs],
  );

  // Clear the bloom with an exit fade (V14): drop the "current" flag now so the
  // pacing loop moves on, mark hiding so the card animates out, then unmount.
  const clearBloom = useCallback(() => {
    hasCurrent.current = false;
    setHiding(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setBloom(null);
      setHiding(false);
      hideTimer.current = null;
    }, 200);
  }, []);

  // Wipe all ephemeral nudge display state. The overlay window is created once
  // and reused for the app's lifetime, so its React state would otherwise
  // persist across calls (and across onboarding). The call log is the
  // authoritative record — this buffer is display-only and safe to clear.
  const resetNudges = useCallback(() => {
    queue.current = [];
    hasCurrent.current = false;
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setHiding(false);
    setBloom(null);
    setHistory([]);
    setExpanded(false);
  }, []);

  // Pacing helpers, lifted to component scope so the dismiss button (V3) can
  // advance the queue exactly the way the auto-pacing loop does.
  const prune = useCallback(() => {
    const now = Date.now();
    queue.current = queue.current.filter((e) => now - e.at <= staleMs);
  }, [staleMs]);

  const advance = useCallback(() => {
    prune();
    const next = queue.current.shift();
    if (next) show(next.nudge);
    else clearBloom();
  }, [prune, show, clearBloom]);

  // Explicit user dismissal of the current note via the ✕ button. Wraps
  // `advance` so only a deliberate dismiss is counted — the auto-pacing loop
  // calls `advance` directly and must stay silent. Metadata only.
  const dismissNote = useCallback(() => {
    track("nudge_dismissed", { urgency: bloom?.urgency ?? null });
    advance();
  }, [advance, bloom]);

  useEffect(() => {
    window.prompty
      .invoke("session:state", undefined as never)
      .then((r) => {
        setSessionState(r.state);
      })
      .catch(() => {});

    const offState = window.prompty.on("session:state-changed", (p) => {
      setSessionState(p.state);
      if (p.state === "starting" || p.state === "live") setFirstCall(!!p.firstCall);
      if (p.state === "starting") setPrimerDismissed(false);
      if (p.state === "ended" || p.state === "idle") setFirstCall(false);
      if (p.state === "starting") {
        setStatus("starting");
        // New call: clear any lingering note + history + queue so nothing from
        // a previous call (or the onboarding demo) bleeds into this one. The
        // main process also sends an explicit overlay:reset when it shows the
        // gem for a call — belt-and-suspenders, since this broadcast is timing-
        // sensitive and can race the show.
        resetNudges();
      }
      if (p.state === "ended" || p.state === "idle") {
        setStatus(null);
        // Full reset: the overlay is hidden on call end, so retained history is
        // unreachable anyway — no reason to keep it around for the next call.
        resetNudges();
      }
    });

    // Explicit, deterministic reset from the main process (call start /
    // onboarding complete). Not timing-dependent like session:state-changed.
    const offReset = window.prompty.on("overlay:reset", () => {
      resetNudges();
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

    const tick = setInterval(() => {
      prune();
      const elapsed = Date.now() - shownAt.current;
      if (hasCurrent.current) {
        if (queue.current.length > 0) {
          // A newer note is waiting: replace once the minimum dwell has passed.
          if (elapsed >= dwellMs) advance();
        } else if (elapsed >= hideMs) {
          // Nothing queued: let the lone note linger, then fade out.
          clearBloom();
        }
      } else if (queue.current.length > 0) {
        advance();
      }
    }, 200);

    const offRuby = window.prompty.on("overlay:ruby-message", (p) => {
      setRubyMessage(p.text);
    });

    return () => {
      offState();
      offStatus();
      offNudge();
      offRuby();
      offReset();
      clearInterval(tick);
    };
  }, [show, resetNudges, prune, advance, clearBloom, dwellMs, hideMs, staleMs]);

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
  }, [bloom, expanded, pinned, history, status, rubyMessage, fitHeight]);

  // A click PINS the panel open (so it stays when the cursor leaves); clicking
  // again unpins. Hover-open is handled by the hit-test in the mouse-ignore
  // effect below. The pin transition is the deliberate-engagement signal.
  const togglePinned = useCallback(() => {
    setPinned((cur) => {
      const next = !cur;
      if (next) { setExpanded(true); track("nudge_expanded", { history_count: history.length }); }
      return next;
    });
  }, [history.length]);

  const isEnding = sessionState === "ending";
  // End the call straight from the gem — the same teardown the main window and
  // tray drive. Re-clicks are guarded: once "ending", the button disables and
  // end() would early-return anyway.
  const endCall = useCallback(() => {
    if (sessionState === "ending") return;
    void window.prompty.invoke("call:end", undefined as never);
  }, [sessionState]);

  // Drag-to-move vs click-to-expand on the pill. We drive movement ourselves so
  // the same press can either move or expand: press and move the pill past a
  // small threshold to drag the window (overlay:move-by with the screen-space
  // delta); a press with no movement is a plain click.
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
    // Swallow the click that ends a drag so moving never toggles the panel.
    if (drag.current.moved) {
      drag.current.moved = false;
      return;
    }
    togglePinned();
  }, [togglePinned]);

  // Click-away: a click that lands on the transparent root (i.e. outside the
  // gem and the history surface) unpins and collapses back to the calm gem.
  const onRootClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget || e.target === contentRef.current) {
      setPinned(false);
      setExpanded(false);
    }
  }, []);

  // Click-through: the overlay window is a transparent rectangle far larger than
  // the visible gem, so it ignores mouse events by default (clicks pass to apps
  // behind it) and only captures while the cursor is over an interactive surface
  // (gem / note / panel). Move events are forwarded even while ignoring, so we
  // hit-test on move and flip the window flag only on transitions. During a gem
  // drag we always capture so the drag isn't dropped.
  const ignoreMouseRef = useRef(true);
  useEffect(() => {
    const apply = (ignore: boolean) => {
      if (ignoreMouseRef.current === ignore) return;
      ignoreMouseRef.current = ignore;
      void window.prompty.invoke("overlay:set-mouse-ignore", { ignore });
    };
    const onMove = (e: MouseEvent) => {
      if (drag.current.active) {
        apply(false);
        return;
      }
      const el = e.target as HTMLElement | null;
      const overInteractive = !!el?.closest(
        ".gem, .gem-ruby-bubble, .gem-bloom, .gem-panel, .gem-primer",
      );
      apply(!overInteractive);
      // Hover-to-expand: opening when the cursor is over the gem or the panel.
      // Leaving doesn't collapse immediately — a short grace timer lets the
      // cursor cross the gap from the pill to the panel without it disappearing.
      const overGemOrPanel = !!el?.closest(".gem, .gem-panel");
      if (overGemOrPanel) {
        if (collapseTimer.current) {
          clearTimeout(collapseTimer.current);
          collapseTimer.current = null;
        }
        setExpanded(true);
      } else if (!pinnedRef.current && expandedRef.current && !collapseTimer.current) {
        collapseTimer.current = setTimeout(() => {
          collapseTimer.current = null;
          if (!pinnedRef.current) setExpanded(false);
        }, 350);
      }
    };
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("mousemove", onMove);
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
    };
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
      ? bloom.urgency === "high"
        ? "attention"
        : "worth-asking"
      : status === "error" || status === "no-audio" || status === "mic-silent" || status === "them-lost"
        ? "attention"
        : status === "reconnecting" || status === "starting" || status === "them-silent"
          ? "thinking"
          : status === "listening" || liveish
            ? "listening"
            : rubyMessage
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
        <div className="gem-anchor-row">
          <button
            type="button"
            className={`gem${expanded || pinned ? " gem-expanded" : ""}`}
            data-testid="gem"
            data-tone={tone}
            data-status={status ?? "idle"}
            aria-label={`Ruby — ${meta?.label ?? "Idle"}. Drag to move; ${liveish || isEnding ? "hover for notes and to end the call." : "hover to see notes."}`}
            title={statusReason ?? (liveish || isEnding ? "Drag to move • Hover for notes & end • Click to keep open" : "Drag to move • Hover to see notes")}
            onMouseDown={onGemMouseDown}
            onClick={onGemClick}
          >
            <Gem variant="pill" state={gemState} />
          </button>
        </div>

        {/* Ruby onboarding speech bubble */}
        {rubyMessage && !bloom && !expanded && !pinned && (
          <div className="gem-ruby-bubble" key={rubyMessage}>
            <div className="gem-ruby-bubble-text">{rubyMessage}</div>
          </div>
        )}

        {/* Capture-status notice: surface the reason as visible text — not just a
            glow shift + a hover tooltip nobody sees mid-call. Covers a mic that's
            dead, "them" reconnecting (calm, amber), or "them" lost (red, act on it).
            Clears the instant the status recovers. role=alert only when it's a real
            failure, so the calm reconnecting notice doesn't nag assistive tech. */}
        {statusReason &&
          (status === "mic-silent" || status === "them-silent" || status === "them-lost") &&
          !expanded &&
          !pinned && (
            <div
              className="gem-ruby-bubble gem-status-warning"
              role={status === "them-silent" ? "status" : "alert"}
              data-status={status}
              data-tone={meta?.tone}
            >
              <div className="gem-status-warning-label">{meta?.label ?? "Audio"}</div>
              <div className="gem-ruby-bubble-text">{statusReason}</div>
            </div>
          )}

        {/* First-call "ready" primer: re-homes the cut hotkey demo into the one
            moment it's true. Non-blocking, retires after the first call ends (the
            firstCall flag is cleared in the main process). Yields to a real
            bloom or the expanded panel so it never competes with live nudges. */}
        {firstCall && liveish && !primerDismissed && !rubyMessage && !bloom && !expanded && !pinned && (
          <div className="gem-primer" data-testid="gem-primer">
            <button
              type="button"
              className="gem-note-dismiss"
              data-testid="gem-primer-dismiss"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => setPrimerDismissed(true)}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <div className="gem-primer-tag">Ruby · listening</div>
            <div className="gem-primer-text">I'll whisper when I catch something worth saying.</div>
            <div className="gem-primer-key">Want one now? <kbd>⌥⇧Space</kbd></div>
            <div className="gem-primer-tip">Hover me for notes, or to end.</div>
          </div>
        )}

        {/* Bloom: one ephemeral note directly beneath the gem. A faint × lets
            the user dismiss a note that's wrong or already covered (V3). The
            draining bar — shown only for high-urgency notes so a calm note
            doesn't animate in the corner — empties exactly when the note
            actually leaves (V1/V12). */}
        {bloom && !expanded && !pinned && (
          <div
            className={`gem-bloom${bloom.urgency === "high" ? " gem-bloom-high" : ""}${hiding ? " gem-bloom-out" : ""}`}
            data-testid="gem-bloom"
            data-nudge-id={bloom.id}
            role={bloom.urgency === "high" ? "alert" : "status"}
            aria-live={bloom.urgency === "high" ? "assertive" : "polite"}
          >
            <button
              type="button"
              className="gem-note-dismiss"
              data-testid="gem-note-dismiss"
              aria-label="Dismiss this note"
              title="Dismiss"
              onClick={dismissNote}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
            <div className="gem-note-tag">
              {bloom.urgency === "high" ? "Ask now" : "Worth asking"}
            </div>
            <div className="gem-note-q">{bloom.text}</div>
            {bloom.urgency === "high" && (
              <div className="gem-note-bar">
                <div
                  key={bloom.id}
                  className="gem-note-fill"
                  style={{ animationDuration: `${bloomMs}ms` }}
                />
              </div>
            )}
          </div>
        )}

        {/* Expanded panel: a quiet scrollback of every note this call, plus an
            End-call control so the call can be ended without hunting for the
            tray or main window. */}
        {(expanded || pinned) && (
          <div className="gem-panel" data-testid="gem-panel">
            <div className="gem-history" data-testid="gem-history">
              {history.length === 0 ? (
                <div className="gem-history-empty">
                  {liveish
                    ? "Nothing worth flagging yet — I'm listening."
                    : "Notes I surface will collect here."}
                </div>
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
            {/* End-call is a call control — only offer it during an actual
                call. The history scrollback above stays available always (e.g.
                reviewing the sample nudges during onboarding, where there's no
                call to end). */}
            {(liveish || isEnding) && (
              <div className="gem-actions">
                <button
                  type="button"
                  className="gem-end-btn"
                  data-testid="gem-end"
                  disabled={isEnding}
                  onClick={endCall}
                >
                  {isEnding ? "Finishing…" : "Finish listening"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
