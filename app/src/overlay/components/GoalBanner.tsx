import React from "react";

export function GoalBanner({ goal }: { goal: string | null }): JSX.Element {
  return (
    <div className="prompty-goal">
      <div className="prompty-label">Goal</div>
      <div className="prompty-goal-text">
        {goal ?? "No active call. Start one to set a goal."}
      </div>
    </div>
  );
}
