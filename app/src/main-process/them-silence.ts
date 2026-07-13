// Tap (them / system-audio) digital-silence detector.
//
// The "them" leg is a Core Audio process tap of the system mix. macOS can leave
// that tap running and healthy — frames keep arriving on schedule — yet feed it
// bit-exact zero the entire call when the process-tap TCC grant is missing (no
// NSAudioCaptureUsageDescription / not approved). The frame-arrival watchdog
// can't see this: the stream never stalls, it just carries silence. So "them"
// ships empty with every health signal green.
//
// Unlike the mic — which carries a non-zero noise floor, so all-zero at the
// START is unambiguous and can trip mid-call (see mic-silence.ts) — the
// counterparty is legitimately silent for stretches, so we CANNOT threshold on
// an initial run. Instead this is a whole-call verdict: did the tap ever deliver
// a single non-zero sample across a meaningful run of frames? If not, "them" was
// digital silence end-to-end. The only false positive is a genuinely one-sided
// call (we truly heard nothing from them), so consumers should read the signal
// as a fleet rate, not per-call truth.
//
// Pure and side-effect-free so the threshold/latch behaviour is unit-testable.

/** ~5s of 16 kHz mono Int16 tap PCM: below this a call is too short to judge. */
export const DEFAULT_THEM_SILENT_MIN_BYTES = 16_000 * 2 * 5;

export interface ThemSilenceDetector {
  /** Feed a tap PCM chunk. Latches "healthy" on the first non-zero sample. */
  inspect(chunk: Buffer): void;
  /**
   * Whole-call verdict, read once at call end: true iff the tap delivered at
   * least `minBytes` of frames but never a single non-zero sample.
   */
  wasSilentAllCall(): boolean;
}

export function createThemSilenceDetector(
  minBytes: number = DEFAULT_THEM_SILENT_MIN_BYTES,
): ThemSilenceDetector {
  let bytesSeen = 0;
  let nonZeroSeen = false;
  return {
    inspect(chunk: Buffer): void {
      bytesSeen += chunk.length;
      // One real sample proves the capture path is live — stop scanning.
      if (nonZeroSeen) return;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 0) {
          nonZeroSeen = true;
          return;
        }
      }
    },
    wasSilentAllCall(): boolean {
      return bytesSeen >= minBytes && !nonZeroSeen;
    },
  };
}
