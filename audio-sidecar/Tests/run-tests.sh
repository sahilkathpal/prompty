#!/bin/bash
# Standalone test runner. Use this when full Xcode (and hence XCTest) is not
# installed — Command Line Tools alone cannot run `swift test`. Compiles a tiny
# program that bundles AudioSidecarCore sources and exercises the framing
# round-trip.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=$(mktemp -d)/StandaloneTests
swiftc -O \
    Sources/AudioSidecarCore/Protocol.swift \
    Tests/standalone/StandaloneTests.swift \
    -o "$OUT"

"$OUT"
