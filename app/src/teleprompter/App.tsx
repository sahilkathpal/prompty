import React, { useCallback, useEffect, useRef, useState } from "react";
import type { Nudge } from "@shared/types";

// The teleprompter is a single-line heads-up bar. Nudges are shown one at a
// time with a guaranteed minimum dwell so a burst doesn't flash unreadably:
//  - each nudge stays for at least DWELL_MS before the next advances;
//  - extra nudges queue FIFO; if the queue grows past 3, the middle is dropped
//    (newest always kept);
//  - a high-urgency nudge preempts whatever is showing immediately;
//  - a nudge that waited longer than STALE_MS is dropped unshown.
// dwell = minimum time a nudge holds the bar before a *queued* newer one may
// replace it (so a burst doesn't flash). hide = how long a lone nudge lingers
// when nothing is queued, before the bar auto-hides — long enough to actually
// read it mid-call, short enough that it doesn't sit parked over the call.
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
  const [text, setText] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [high, setHigh] = useState(false);

  const queue = useRef<Queued[]>([]);
  const shownAt = useRef(0);
  const hasCurrent = useRef(false);
  const dwellMs = useRef(readParam("dwellMs", DEFAULT_DWELL_MS)).current;
  const hideMs = useRef(readParam("hideMs", DEFAULT_HIDE_MS)).current;
  const staleMs = useRef(readParam("staleMs", DEFAULT_STALE_MS)).current;

  const show = useCallback((n: Nudge) => {
    setText(n.text);
    setHigh(n.urgency === "high");
    setVisible(true);
    shownAt.current = Date.now();
    hasCurrent.current = true;
  }, []);

  useEffect(() => {
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
        setVisible(false);
        hasCurrent.current = false;
      }
    };

    const offNudge = window.prompty.on("nudge:received", (n: Nudge) => {
      if (!n?.text) return;
      if (n.urgency === "high") {
        // Preempt whatever is showing — urgent nudges can't wait out the dwell.
        show(n);
        return;
      }
      queue.current.push({ nudge: n, at: Date.now() });
      // Cap the backlog: drop from the middle so both the oldest still-queued
      // and the newest survive.
      while (queue.current.length > MAX_QUEUE) {
        queue.current.splice(Math.floor(queue.current.length / 2), 1);
      }
      if (!hasCurrent.current) advance();
    });

    const offState = window.prompty.on("session:state-changed", (p) => {
      if (p.state === "ended" || p.state === "idle") {
        queue.current = [];
        hasCurrent.current = false;
        setVisible(false);
        setText(null);
        setHigh(false);
      }
    });

    const tick = setInterval(() => {
      prune();
      const elapsed = Date.now() - shownAt.current;
      if (hasCurrent.current) {
        if (queue.current.length > 0) {
          // A newer nudge is waiting: replace once the minimum dwell has passed.
          if (elapsed >= dwellMs) advance();
        } else if (elapsed >= hideMs) {
          // Nothing queued: let the lone nudge linger, then hide.
          setVisible(false);
          hasCurrent.current = false;
        }
      } else if (queue.current.length > 0) {
        advance();
      }
    }, 200);

    return () => {
      offNudge();
      offState();
      clearInterval(tick);
    };
  }, [show, dwellMs, hideMs, staleMs]);

  return (
    <div
      className={`teleprompter-root${visible ? " visible" : ""}${high ? " high" : ""}`}
      data-testid="teleprompter-root"
      data-high={high ? "true" : "false"}
    >
      {text ?? ""}
    </div>
  );
}
