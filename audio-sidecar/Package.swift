// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AudioSidecar",
    platforms: [
        // Prompty requires macOS 14.4+ (Core Audio process tap). SPM can't
        // express the .4; the 14.4 floor is enforced at install via the app's
        // LSMinimumSystemVersion, and a runtime `#available(macOS 14.4)` guard
        // covers the 14.0→14.4 API gap.
        .macOS(.v14)
    ],
    targets: [
        // Pure library — testable in isolation, no AVFoundation / SCK deps.
        .target(
            name: "AudioSidecarCore",
            path: "Sources/AudioSidecarCore"
        ),
        // Executable — pulls Core in plus the platform capture stacks.
        .executableTarget(
            name: "AudioSidecar",
            dependencies: ["AudioSidecarCore"],
            path: "Sources/AudioSidecar"
        ),
        .testTarget(
            name: "AudioSidecarCoreTests",
            dependencies: ["AudioSidecarCore"],
            path: "Tests/AudioSidecarCoreTests"
        )
    ]
)
