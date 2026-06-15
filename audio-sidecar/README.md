# AudioSidecar

Swift command-line binary that captures the microphone and process-targeted
system audio on macOS and emits PCM frames over stdout for consumption by the
Prompty Electron parent process. System audio is captured via a CoreAudio
process tap (`CATapDescription` + `AudioHardwareCreateProcessTap`), which
requires macOS 14.4+.

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

System audio goes through the CoreAudio process tap, which needs no Screen
Recording permission and produces no prompt — it works once the binary runs.

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
