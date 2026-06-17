// Mic digital-silence detector.
//
// macOS can report microphone permission as "granted" yet feed a
// separately-signed helper (our Swift sidecar) all-zero buffers — the session
// looks healthy ("listening") while Deepgram receives digital silence and never
// returns transcripts, so no nudges ever fire. A real microphone always carries
// a non-zero noise floor, so a sustained run of exactly-zero PCM at the START of
// a session is an unambiguous signal that the sidecar isn't getting real audio.
//
// Extracted from coach-session.ts as a pure, side-effect-free state machine so
// the threshold/sticky behaviour can be unit-tested deterministically.

/** ~4s of 16 kHz mono Int16 PCM — the default all-zero run that trips silence. */
export const DEFAULT_MIC_SILENCE_BYTES = 16_000 * 2 * 4;

export interface MicSilenceDetector {
  /**
   * Feed a mic PCM chunk. Returns true EXACTLY ONCE — on the chunk that tips the
   * accumulated all-zero run past the threshold — so the caller can emit its
   * warning a single time. Returns false otherwise. Once any non-zero sample is
   * seen the detector latches "healthy" and never inspects again.
   */
  inspect(chunk: Buffer): boolean;
  /** Whether sustained digital silence was detected. Sticky once true. */
  isSilent(): boolean;
}

export function createMicSilenceDetector(
  thresholdBytes: number = DEFAULT_MIC_SILENCE_BYTES,
): MicSilenceDetector {
  let bytesSeen = 0;
  let nonZeroSeen = false;
  let silent = false;
  return {
    inspect(chunk: Buffer): boolean {
      // Once any real audio has appeared, the mic is fine — stop inspecting.
      if (nonZeroSeen || silent) return false;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 0) {
          nonZeroSeen = true;
          return false;
        }
      }
      bytesSeen += chunk.length;
      if (bytesSeen >= thresholdBytes) {
        silent = true;
        return true;
      }
      return false;
    },
    isSilent(): boolean {
      return silent;
    },
  };
}
