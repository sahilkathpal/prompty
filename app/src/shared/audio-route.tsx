// Audio route-change detection (RUBY_OBSERVABILITY_PLAN §7.3).
//
// The literal trigger of the John-class silent call is a mid-call audio device
// flip (Bluetooth A2DP↔HFP, headphones plugged/unplugged, default-device
// switch). `navigator.mediaDevices.devicechange` fires precisely on those
// topology changes — it's the standard web signal for "the audio device set
// changed". We don't need the new transport (that's the Swift capture path's
// business); we just need to flag THAT a flip happened during a call, so it can
// be correlated with silent calls. Runs in a renderer (main has no navigator);
// main tags `during_call` and drops changes outside a call.

// macOS emits a burst of devicechange events per physical flip (and a BT profile
// switch spans a second or two), so coalesce with a leading-edge debounce.
const COALESCE_MS = 1500;

/** Install the devicechange → main forwarder for this renderer. Idempotent-ish;
 * call once per root that should observe route changes (the overlay is always
 * alive during a call). */
export function installAudioRouteListener(): void {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!md || typeof md.addEventListener !== "function") return;
  let cooling = false;
  md.addEventListener("devicechange", () => {
    if (cooling) return; // one event per burst
    cooling = true;
    setTimeout(() => {
      cooling = false;
    }, COALESCE_MS);
    try {
      window.prompty?.invoke("analytics:audio-route-changed", undefined);
    } catch {
      // never let telemetry throw into the renderer
    }
  });
}
