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
 * alive during a call). Reports the default input/output device before→after the
 * change (e.g. built-in → Bluetooth), which is the signal that actually explains
 * a silent call — not just THAT a flip happened. */
export function installAudioRouteListener(): void {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!md || typeof md.addEventListener !== "function") return;

  // Track the current default devices so a change can report from→to. Labels need
  // mic permission (a call has it); before that they read null.
  let prev: { input: string | null; output: string | null } = { input: null, output: null };
  void currentDefaults(md).then((d) => { prev = d; });

  let cooling = false;
  md.addEventListener("devicechange", () => {
    if (cooling) return; // one report per burst
    cooling = true;
    // Read AFTER the burst settles (a Bluetooth profile switch spans a second or
    // two) so the "to" device is the settled one, not a transitional read.
    setTimeout(() => {
      cooling = false;
      void currentDefaults(md).then((next) => {
        const payload = {
          fromInput: prev.input,
          toInput: next.input,
          fromOutput: prev.output,
          toOutput: next.output,
        };
        prev = next;
        try {
          window.prompty?.invoke("analytics:audio-route-changed", payload);
        } catch {
          // never let telemetry throw into the renderer
        }
      });
    }, COALESCE_MS);
  });
}

/** The current default input/output device names (macOS "Default - X" prefix
 * stripped), or null when unavailable / unlabeled (no mic permission yet). */
async function currentDefaults(
  md: MediaDevices,
): Promise<{ input: string | null; output: string | null }> {
  try {
    const devs = await md.enumerateDevices();
    const pick = (kind: MediaDeviceKind): string | null => {
      const def =
        devs.find((d) => d.kind === kind && d.deviceId === "default") ??
        devs.find((d) => d.kind === kind);
      const label = (def?.label ?? "").replace(/^Default\s*[-–]\s*/i, "").trim();
      return label || null;
    };
    return { input: pick("audioinput"), output: pick("audiooutput") };
  } catch {
    return { input: null, output: null };
  }
}
