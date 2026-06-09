import Foundation
import AppKit
import AudioSidecarCore

/// Bundle IDs of apps we consider candidate meeting endpoints.
/// Order matters only for the `--list-processes` debug output.
enum ProcessTargeting {
    static let knownMeetingApps: [String] = [
        "us.zoom.xos",                  // Zoom
        "com.google.Chrome",            // Google Meet in Chrome
        "com.microsoft.teams2",         // Microsoft Teams (new)
        "com.microsoft.teams",          // Microsoft Teams (legacy, kept defensively)
        "com.apple.FaceTime",           // FaceTime
        "com.tinyspeck.slackmacgap",    // Slack
        "com.hnc.Discord",              // Discord
        "com.microsoft.edgemac",        // Edge (Teams web)
        "com.brave.Browser",            // Brave
        "com.apple.Safari",             // Safari
        "com.apple.Music",              // Music — useful for smoke tests
    ]

    struct RunningTarget {
        let pid: pid_t
        let bundleID: String
        let name: String
    }

    /// Returns all currently running apps that match a known meeting bundle ID.
    static func candidates() -> [RunningTarget] {
        let apps = NSWorkspace.shared.runningApplications
        return apps.compactMap { app in
            guard let bid = app.bundleIdentifier else { return nil }
            guard knownMeetingApps.contains(bid) else { return nil }
            return RunningTarget(
                pid: app.processIdentifier,
                bundleID: bid,
                name: app.localizedName ?? bid
            )
        }
    }

    /// First running PID matching `bundleID`, or nil.
    static func pid(forBundleID bundleID: String) -> pid_t? {
        NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleID }?.processIdentifier
    }

    /// Prints candidate processes to stdout (debug helper).
    /// NOTE: bypasses the binary framing — only used with `--list-processes`,
    /// after which the process exits. Safe because no parent is consuming frames in that mode.
    static func printList() {
        let rows = candidates()
        if rows.isEmpty {
            print("(no known meeting apps currently running)")
        } else {
            print("PID\tBUNDLE\tNAME")
            for r in rows {
                print("\(r.pid)\t\(r.bundleID)\t\(r.name)")
            }
        }
    }
}
