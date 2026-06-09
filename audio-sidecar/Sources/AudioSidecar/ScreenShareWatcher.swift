import Foundation
import ScreenCaptureKit
import AppKit
import AudioSidecarCore

/// Watches for *other* apps capturing the display, so the panel can collapse to
/// compact mode when the user shares their screen.
///
/// Implementation: poll `SCShareableContent` every 2s and look at the set of
/// running applications. A heuristic — when any non-Prompty app is in the
/// foreground AND known to be a screen-sharing endpoint (Zoom/Teams/Meet) AND
/// the system reports an active SCStream owner, we declare "sharing". This is
/// imperfect but cheap, deferred-by-design (PLAN.md, "open implementation
/// details"). A more authoritative signal would require private APIs.
///
/// For v1 we use a simpler, robust signal: check `CGWindowListCopyWindowInfo`
/// for windows owned by the system's screen-sharing service. This catches
/// QuickTime, Zoom share-screen overlays, and Meet's "you are sharing" banner.
@available(macOS 13.0, *)
final class ScreenShareWatcher {
    private var timer: DispatchSourceTimer?
    private var isSharing = false

    func start() {
        let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        t.schedule(deadline: .now() + 2, repeating: 2.0)
        t.setEventHandler { [weak self] in
            self?.tick()
        }
        t.resume()
        timer = t
        Log.info("ScreenShareWatcher started")
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    private func tick() {
        let sharing = detectScreenShare()
        if sharing != isSharing {
            isSharing = sharing
            FrameWriter.writeControl([
                "type": sharing ? "screen_share_started" : "screen_share_stopped"
            ])
            Log.info("screen-share \(sharing ? "started" : "stopped")")
        }
    }

    /// Heuristic: a window owned by a known screen-share helper / system
    /// service is on-screen.
    private func detectScreenShare() -> Bool {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return false
        }
        let shareIndicators: Set<String> = [
            "ScreenCaptureKit",        // system service helpers
            "Zoom Sharing Toolbar",
            "Zoom Share Window",
            "screencapture",
            "ControlCenter",           // macOS purple recording dot lives here
        ]
        for w in list {
            let owner = (w[kCGWindowOwnerName as String] as? String) ?? ""
            let name = (w[kCGWindowName as String] as? String) ?? ""
            if shareIndicators.contains(owner) { return true }
            if name.lowercased().contains("you are sharing") { return true }
            if name.lowercased().contains("screen sharing") { return true }
        }
        return false
    }
}
