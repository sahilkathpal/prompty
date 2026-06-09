import React from "react";
import type { Nudge } from "@shared/types";

export function NudgeFeed({ nudges }: { nudges: Nudge[] }): JSX.Element {
  return (
    <div className="prompty-nudges" data-testid="overlay-nudge-feed">
      {!nudges.length ? (
        <div className="prompty-empty">Listening… nudges will appear here.</div>
      ) : (
        nudges.map((n) => (
          <div
            key={n.id}
            data-testid={`nudge-${n.id}`}
            className={`prompty-nudge${n.urgency === "high" ? " prompty-nudge-high" : ""}`}
          >
            <div className="prompty-nudge-kind">{n.kind}</div>
            <div className="prompty-nudge-text">{n.text}</div>
          </div>
        ))
      )}
    </div>
  );
}
