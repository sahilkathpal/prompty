import Foundation
import Darwin
import AudioSidecarCore

// MARK: - Argument parsing

struct CLIArgs {
    var targetPID: pid_t?
    var targetBundle: String?
    var listProcesses: Bool = false
    var showHelp: Bool = false
}

func parseArgs(_ argv: [String]) -> CLIArgs {
    var args = CLIArgs()
    var i = 1
    while i < argv.count {
        let a = argv[i]
        switch a {
        case "--target-pid":
            i += 1
            if i < argv.count, let pid = Int32(argv[i]) {
                args.targetPID = pid
            }
        case "--target-bundle":
            i += 1
            if i < argv.count {
                args.targetBundle = argv[i]
            }
        case "--list-processes":
            args.listProcesses = true
        case "-h", "--help":
            args.showHelp = true
        default:
            Log.error("unknown arg: \(a)")
        }
        i += 1
    }
    return args
}

func printUsage() {
    let usage = """
    AudioSidecar — Prompty system-audio + mic capture for macOS.

    Usage:
      AudioSidecar --target-pid <pid>
      AudioSidecar --target-bundle <bundle.id>
      AudioSidecar --list-processes

    Output: length-prefixed binary frames on stdout. See Protocol.swift.
    Logs:   human-readable lines on stderr.
    """
    print(usage)
}

// MARK: - Main

let args = parseArgs(CommandLine.arguments)

if args.showHelp {
    printUsage()
    exit(0)
}

if args.listProcesses {
    ProcessTargeting.printList()
    exit(0)
}

// Targeting args are accepted for back-compat but ignored — we always capture
// system-wide audio (the same model Granola/Krisp/etc. use). Per-app capture
// added complexity (link parsing, openExternal races, Meet-in-browser edge
// cases) that didn't justify the upside.
if args.targetPID != nil || args.targetBundle != nil {
    Log.info("targeting args ignored — capturing system audio")
}

// Mic — always runs.
let mic = MicCapture()
do {
    try mic.start()
} catch {
    Log.error("mic start failed: \(error.localizedDescription)")
    FrameWriter.writeControl(["type": "error", "msg": "mic_start: \(error.localizedDescription)"])
}

// System-audio ("them") capture via the Core Audio process tap. This is the
// only path — Prompty requires macOS 14.4+ (enforced at install via the app's
// LSMinimumSystemVersion). The audio-only tap replaced the old ScreenCaptureKit
// fallback, which required Screen Recording.
var coreAudio: CoreAudioTap?
let shareWatcher = ScreenShareWatcher()

if #available(macOS 14.4, *) {
    let tap = CoreAudioTap()
    do {
        try tap.start()
        coreAudio = tap
        Log.info("using CoreAudio Tap path")
    } catch {
        Log.error("CoreAudio tap start failed: \(error.localizedDescription)")
        FrameWriter.writeControl(["type": "error", "msg": "tap_start: \(error.localizedDescription)"])
    }
} else {
    Log.error("macOS 14.4+ required for system-audio capture")
    FrameWriter.writeControl(["type": "error", "msg": "unsupported_os: macOS 14.4+ required"])
}

shareWatcher.start()

FrameWriter.writeControl(["type": "ready"])

// MARK: - Signal handling

let signalQueue = DispatchQueue(label: "prompty.sidecar.signals")
var shuttingDown = false

func shutdown() {
    if shuttingDown { return }
    shuttingDown = true
    Log.info("shutting down")
    mic.stop()
    coreAudio?.stop()
    shareWatcher.stop()
    exit(0)
}

for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
    src.setEventHandler { shutdown() }
    src.resume()
    // Keep `src` alive for process lifetime.
    objc_setAssociatedObject(NSObject(), Unmanaged.passUnretained(src as AnyObject).toOpaque(), src, .OBJC_ASSOCIATION_RETAIN)
}

// Also bail out if stdin closes (parent died).
DispatchQueue.global(qos: .utility).async {
    let stdin = FileHandle.standardInput
    while true {
        let data = stdin.availableData
        if data.isEmpty {
            Log.info("stdin closed by parent; exiting")
            shutdown()
            return
        }
    }
}

dispatchMain()
