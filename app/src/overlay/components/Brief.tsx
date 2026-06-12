import React from "react";

// Human-facing labels for the optional coaching skill (playbook). The raw slug
// never reaches the UI.
const SKILL_LABEL: Record<string, string> = {
  discovery: "Discovery",
  hiring: "Hiring",
  "user-interview": "User interview",
};

// The call brief. The direction is the primary steer (the prose paragraph
// describing what a good call looks like) and leads; the goal is optional and
// only sharpens it, so it renders as a secondary line and only when set. This
// mirrors the agent's system-prompt hierarchy — direction first, goal optional;
// see main-process/prompts/system.ts.
export function Brief({
  direction,
  goal,
  skill,
}: {
  direction: string | null;
  goal: string | null;
  skill?: string | null;
}): JSX.Element {
  // No active call yet: one quiet placeholder, not an empty "Direction" card.
  if (!direction && !goal) {
    return (
      <div className="prompty-brief">
        <div className="prompty-goal-text prompty-brief-empty">
          No active call. Start one to set a direction.
        </div>
      </div>
    );
  }

  const skillLabel = skill ? (SKILL_LABEL[skill] ?? skill) : null;

  return (
    <div className="prompty-brief" data-testid="overlay-brief">
      {direction && (
        <div className="prompty-brief-direction">
          <div className="prompty-label">
            Direction
            {skillLabel && (
              <span className="prompty-skill-badge" data-testid="overlay-skill-badge">
                {skillLabel}
              </span>
            )}
          </div>
          <div className="prompty-goal-text" data-testid="overlay-direction-text">
            {direction}
          </div>
        </div>
      )}
      {goal && (
        <div className="prompty-brief-goal">
          <div className="prompty-label">Goal</div>
          <div className="prompty-goal-text" data-testid="overlay-goal-text">
            {goal}
          </div>
        </div>
      )}
    </div>
  );
}
