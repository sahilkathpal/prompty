// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AudioSidecar",
    platforms: [
        .macOS(.v13)
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
