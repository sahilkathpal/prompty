# AudioSidecar

Swift command-line binary that captures the microphone and process-targeted
system audio on macOS and emits PCM frames over stdout for consumption by the
Prompty Electron parent process. Block A of `PLAN.md`.

## Build

    cd audio-sidecar
    swift build -c release

The binary lands at `.build/release/AudioSidecar`.

## Run

    # Target by bundle id (the app must be running)
    .build/release/AudioSidecar --target-bundle us.zoom.xos

    # Target by PID
    .build/release/AudioSidecar --target-pid 12345

    # Debug helper: list candidate meeting apps currently running, then exit
    .build/release/AudioSidecar --list-processes

stdout carries binary frames (see below). stderr carries human-readable logs.
The sidecar exits cleanly on SIGTERM / SIGINT / SIGHUP and also when stdin is
closed (parent process died).

## Permissions

* **Microphone** — required. macOS prompts on first launch.
* **Screen Recording** — required on macOS 13.0–14.3 (ScreenCaptureKit path).
  Apple lifted this requirement on 14.4+ via the CoreAudio Tap API, but our
  CoreAudio Tap implementation is currently a stub (see TODOs in
  `Sources/AudioSidecar/CoreAudioTap.swift`), so the sidecar uses the SCK path
  on all versions today and consequently still requests Screen Recording.

## Wire protocol

stdout is a stream of length-prefixed frames:

| offset | size | meaning |
|--------|------|---------|
| 0      | 1    | tag byte |
| 1      | 4    | payload length, uint32 big-endian |
| 5      | N    | payload |

Tag values:

| tag  | meaning |
|------|---------|
| 0x01 | control JSON (UTF-8) |
| 0x02 | mic PCM, 16 kHz mono signed 16-bit little-endian |
| 0x03 | tap PCM, 16 kHz mono signed 16-bit little-endian |

Control messages the sidecar emits:

    {"type":"ready"}                     # all subsystems initialized
    {"type":"screen_share_started"}      # another app started capturing the display
    {"type":"screen_share_stopped"}      # ...stopped
    {"type":"error","msg":"..."}         # non-fatal subsystem error

## Tests

If you have full Xcode installed:

    swift test

If you only have Command Line Tools (XCTest unavailable), use the standalone
runner — it builds and runs the same framing assertions via `swiftc`:

    ./Tests/run-tests.sh

Covers framing round-trip, concatenated frames, big-endian length encoding,
unknown-tag rejection, and short-buffer handling.

## CLI flags

    --target-pid <pid>          Target a specific PID for system-audio capture.
    --target-bundle <bundleID>  Resolve <bundleID> to a running PID and target it.
    --list-processes            Print known meeting apps currently running, exit.
    -h, --help                  Show usage.

`--target-pid` and `--target-bundle` are mutually exclusive.

## Known TODOs

* **CoreAudio Tap (macOS 14.4+)** — `CoreAudioTap.swift` is a stub. The
  ScreenCaptureKit fallback covers 13.0+ but still requires Screen Recording
  permission. Replacing the stub with a real `CATapDescription` +
  `AudioHardwareCreateProcessTap` implementation will remove that permission
  requirement on 14.4+.
* **Screen-share watcher** uses a `CGWindowListCopyWindowInfo` heuristic; it
  catches the common cases (Zoom share toolbar, "you are sharing" banners,
  ControlCenter recording dot) but isn't authoritative. Good enough for v1.
* **Codesigning** is Block G's job, not done here.
