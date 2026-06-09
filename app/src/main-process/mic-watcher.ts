// Block E5 — Mic-activation watcher.
//
// Per the spec: detecting which bundle owns the mic from Node is brittle
// (lsof against /dev/audio* doesn't work reliably; the AVFoundation
// "isInUseByAnotherApplication" API lives in the Swift sidecar). The spec
// permits deferring this to "armed calendar event + user clicks notification".
//
// This module exposes the seam (`onMicBusy`) so the calendar-arm scheduler
// can register a handler. For now it never fires the auto-start path.
//
// TODO(block-e): add a Swift-side AVCaptureDevice poll in the sidecar that
// emits a control frame {"type":"mic_busy_by","bundle":"us.zoom.xos"} on
// transitions. Listen for that on the sidecar control events instead of
// polling from Node.

export type MicBusyEvent = { busy: boolean; bundle?: string };

export interface MicWatcher {
  /** Register a handler for idle→busy transitions. */
  onTransition(handler: (e: MicBusyEvent) => void): () => void;
  stop(): void;
}

export function startMicWatcher(): MicWatcher {
  const handlers = new Set<(e: MicBusyEvent) => void>();
  // TODO(block-e): poll AVCaptureDevice via the sidecar.
  return {
    onTransition(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    stop() {
      handlers.clear();
    },
  };
}
