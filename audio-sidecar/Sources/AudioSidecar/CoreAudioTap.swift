import Foundation
import CoreAudio
import AudioSidecarCore

/// macOS 14.4+ process-targeted audio tap.
///
/// STATUS: STUB.
///
/// The public CoreAudio Tap surface (CATapDescription / AudioHardwareCreateProcessTap /
/// kAudioObjectPropertyProcessObjectList) was introduced in macOS 14.4 but its
/// Swift-importable surface is thin and the aggregate-device plumbing required to
/// actually pull samples is fiddly. To unblock Block A end-to-end, this file is a
/// runtime no-op that always reports unavailable; main.swift falls through to the
/// ScreenCaptureKit path on all OS versions until this is implemented properly.
///
/// TODO (separate task):
///   1. Build a `CATapDescription` for the target audio process object ID
///      (resolve via `kAudioHardwarePropertyTranslatePIDToProcessObject`).
///   2. `AudioHardwareCreateProcessTap` → tap object ID.
///   3. Create an aggregate device that includes the tap as a sub-device.
///   4. Install an IOProc on the aggregate device, resample its float buffers
///      to 16 kHz mono Int16 LE, and emit as tag 0x03 via `FrameWriter`.
///   5. On stop: destroy IOProc, aggregate device, and tap object.
final class CoreAudioTap {
    init() {}

    /// Returns true iff the CoreAudio process-tap path is implemented and usable.
    /// Currently always false — see TODO above.
    static func isAvailable() -> Bool {
        return false
    }

    func start() throws {
        throw NSError(
            domain: "CoreAudioTap", code: -1,
            userInfo: [NSLocalizedDescriptionKey: "CoreAudio Tap path not yet implemented; using SCK fallback"]
        )
    }

    func stop() {
        // no-op
    }
}
