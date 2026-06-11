// Single source of truth for which Claude model each agent role uses.
//
// Kept out of the individual query() call sites so the model choice per role is
// visible in one place and overridable without a rebuild (env vars below).
//
//   - nudge:   the persistent in-call nudging session (agent.ts). High
//              frequency — an auto-consider per final utterance — so it favours
//              the fastest model.
//   - hotkey:  the on-demand "what should I ask?" one-shot (answer.ts). The one
//              line the user actively waits on, so it favours quality.
//   - summary: the background running brief (running-summary.ts). Off the
//              critical path; cheap is fine.
//   - recap:   the post-call structured summary (summary.ts). One pass over the
//              full transcript at call end — not time-sensitive.

export type ModelRole = "nudge" | "hotkey" | "summary" | "recap";

const DEFAULTS: Record<ModelRole, string> = {
  nudge: "claude-haiku-4-5",
  hotkey: "claude-sonnet-4-6",
  summary: "claude-haiku-4-5",
  recap: "claude-sonnet-4-6",
};

const ENV: Record<ModelRole, string> = {
  nudge: "PROMPTY_MODEL_NUDGE",
  hotkey: "PROMPTY_MODEL_HOTKEY",
  summary: "PROMPTY_MODEL_SUMMARY",
  recap: "PROMPTY_MODEL_RECAP",
};

export function modelFor(role: ModelRole): string {
  return process.env[ENV[role]]?.trim() || DEFAULTS[role];
}
