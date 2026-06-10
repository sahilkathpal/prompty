import React from "react";
import type { Nudge } from "@shared/types";

// A hand-scribbled exclamation mark — the double offset stroke + blobby dot
// give it a felt-tip, sketched feel.
function UrgentScribble(): JSX.Element {
  return (
    <svg
      className="prompty-note-mark"
      viewBox="0 0 22 38"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M11 3c1.2 5.6.5 11.4 0 17.4"
        stroke="#c0392b"
        strokeWidth="3.4"
        strokeLinecap="round"
      />
      <path
        d="M10.5 3.6c.7 5.5 1 11 .8 16.6"
        stroke="#c0392b"
        strokeWidth="1.8"
        strokeLinecap="round"
        opacity="0.5"
      />
      <circle cx="10.5" cy="29.5" r="2.8" fill="#c0392b" />
    </svg>
  );
}

// A small pile of sticky-note prompts: the newest sits fully readable on top,
// with the previous one or two peeking out behind as offset edges. New nudges
// drop onto the top and bury the older ones — only the newest is meant to be
// read; the pile is just visual depth. No kind label.
const STACK_DEPTH = 3; // newest + up to 2 peeking

export function NudgeFeed({ nudges }: { nudges: Nudge[] }): JSX.Element {
  const pile = nudges.slice(0, STACK_DEPTH); // nudges[0] is the newest
  return (
    <div className="prompty-notes" data-testid="overlay-nudge-feed">
      {!pile.length ? (
        <div className="prompty-empty">Listening… prompts will appear here.</div>
      ) : (
        <div className="prompty-note-stack">
          {pile.map((n, depth) => (
            <div
              key={n.id}
              data-testid={`nudge-${n.id}`}
              data-depth={depth}
              className={
                `prompty-note ${depth === 0 ? "prompty-note-top" : "prompty-note-peek"}` +
                (n.urgency === "high" ? " prompty-note-high" : "")
              }
            >
              {/* Only the top note shows its text; the rest are bare paper edges. */}
              {depth === 0 && (
                <>
                  {n.urgency === "high" && (
                    <span className="prompty-note-urgent" aria-hidden="true">
                      <UrgentScribble />
                      <UrgentScribble />
                    </span>
                  )}
                  <div className="prompty-note-text">{n.text}</div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
