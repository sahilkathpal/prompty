// Single source of truth for the in-call transcript windowing policy.
//
// The live loop (coach-session.ts) feeds the agent a sliding window of the most
// recent final utterances and re-runs consider() on every new final utterance.
// The replay harness (tests/replay-harness.ts) mirrors that same policy offline
// so a prompt edit can be judged against the *same* input shape production sees.
//
// Both import CONSIDER_WINDOW from here so the window size can never drift
// between the two. (The fire-on-every-final-utterance cadence is control flow,
// not a constant — the harness mirrors it with a comment pointing back here.)

/** How many of the most recent final utterances the agent sees each turn. */
export const CONSIDER_WINDOW = 12;
