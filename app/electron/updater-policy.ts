// Pure update auto-apply policy. No electron / side-effect imports, so the safety
// decision (never mid-call, never before the idle threshold, only when opted in)
// is unit-testable without a packaged app or a real update feed.

export interface AutoApplyState {
  /** An update has finished downloading and is staged for install. */
  downloaded: boolean;
  /** The user opted into fully-silent auto-apply (autoInstallUpdates). */
  enabled: boolean;
  /** A call is currently live — the hard safety gate. */
  callActive: boolean;
  /** Seconds the user has been idle (powerMonitor.getSystemIdleTime). */
  idleSeconds: number;
  /** How long they must be idle before a silent apply may fire. */
  idleThresholdSeconds: number;
}

/**
 * Whether a staged update may be applied silently RIGHT NOW. True only when an
 * update is staged, the user opted in, no call is active, and the user has been
 * idle past the threshold. The call-active guard is the invariant that matters
 * most: a silent restart must never interrupt a live call.
 */
export function shouldAutoApply(s: AutoApplyState): boolean {
  return (
    s.downloaded &&
    s.enabled &&
    !s.callActive &&
    s.idleSeconds >= s.idleThresholdSeconds
  );
}

// The user must be away from the keyboard this long before a silent auto-apply
// fires — long enough that we're not yanking the app out from under active use.
export const IDLE_THRESHOLD_SECONDS = 5 * 60;
