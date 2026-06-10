import Foundation
import CoreAudio
import AVFoundation
import AudioSidecarCore

/// macOS 14.4+ process-targeted audio tap (audio-only, no Screen Recording).
///
/// This is the preferred system-audio ("them") capture path. It uses the public
/// Core Audio Tap API introduced in macOS 14.4:
///
///   1. A `CATapDescription` for a *global* tap that excludes our own app's audio
///      (mirrors SCK's `excludesCurrentProcessAudio`).
///   2. `AudioHardwareCreateProcessTap` → a tap object.
///   3. A private aggregate device that contains the tap as a sub-tap, clocked by
///      the current default output device.
///   4. An IOProc on the aggregate device that pulls the tap's float buffers,
///      resamples them to 16 kHz mono Int16 LE, and emits tag-0x03 frames.
///   5. Full teardown on stop().
///
/// Unlike the ScreenCaptureKit fallback, this requires only an audio-capture
/// consent — it never touches Screen Recording. `main.swift` prefers this path
/// on 14.4+ and falls through to `ScreenCaptureAudio` only when `start()` throws.
///
/// The class itself is available from the package's deployment target (macOS 13)
/// so `main.swift` can hold an optional reference unconditionally; every call into
/// the 14.4-only Core Audio Tap surface is guarded with `if #available`.
final class CoreAudioTap {
    private var tapID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?

    private var inputFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var stopped = false

    /// 16 kHz mono, Int16, interleaved, little-endian — the wire format every
    /// downstream consumer (tag 0x03) expects. Identical to MicCapture/SCK.
    private let targetFormat: AVAudioFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
    )!

    private let ioQueue = DispatchQueue(label: "prompty.sidecar.coreaudio.tap")

    init() {}

    /// True iff the Core Audio process-tap path is usable (macOS 14.4+).
    static func isAvailable() -> Bool {
        if #available(macOS 14.4, *) { return true }
        return false
    }

    func start() throws {
        guard #available(macOS 14.4, *) else {
            throw NSError(domain: "CoreAudioTap", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "Core Audio Tap requires macOS 14.4+"])
        }

        // 1. Tap description: global mixdown of all system audio EXCEPT our own
        //    app (the Electron parent). Excluding ourselves keeps Prompty's own
        //    sounds out of the "them" stream. If we can't resolve the parent
        //    process object, fall back to capturing everything.
        let excluded: [AudioObjectID]
        if let parentObj = processObject(forPID: getppid()) {
            excluded = [parentObj]
        } else {
            excluded = []
        }

        // A global exclude-tap is unmuted by default — it listens without
        // affecting the audio the user hears, which is exactly what we want.
        let tapDescription = CATapDescription(monoGlobalTapButExcludeProcesses: excluded)
        tapDescription.name = "Prompty System Audio Tap"
        tapDescription.uuid = UUID()
        tapDescription.isPrivate = true        // not visible to other processes

        // 2. Create the tap object.
        var newTapID = AudioObjectID(kAudioObjectUnknown)
        let tapStatus = AudioHardwareCreateProcessTap(tapDescription, &newTapID)
        guard tapStatus == noErr, newTapID != AudioObjectID(kAudioObjectUnknown) else {
            throw NSError(domain: "CoreAudioTap", code: Int(tapStatus),
                          userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateProcessTap failed (status=\(tapStatus))"])
        }
        tapID = newTapID

        // 3. Aggregate device that contains the tap, clocked by the default
        //    output device. Private + auto-start so it lives only for our use and
        //    begins pulling tap audio immediately.
        guard let outputUID = defaultOutputDeviceUID() else {
            cleanupTap()
            throw NSError(domain: "CoreAudioTap", code: -2,
                          userInfo: [NSLocalizedDescriptionKey: "No default output device for aggregate clock"])
        }

        let aggregateUID = UUID().uuidString
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey as String: "Prompty-Tap-\(getpid())",
            kAudioAggregateDeviceUIDKey as String: aggregateUID,
            kAudioAggregateDeviceMainSubDeviceKey as String: outputUID,
            kAudioAggregateDeviceIsPrivateKey as String: true,
            kAudioAggregateDeviceIsStackedKey as String: false,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceSubDeviceListKey as String: [
                [kAudioSubDeviceUIDKey as String: outputUID],
            ],
            kAudioAggregateDeviceTapListKey as String: [
                [
                    kAudioSubTapDriftCompensationKey as String: true,
                    kAudioSubTapUIDKey as String: tapDescription.uuid.uuidString,
                ],
            ],
        ]

        var newAggregateID = AudioObjectID(kAudioObjectUnknown)
        let aggStatus = AudioHardwareCreateAggregateDevice(description as CFDictionary, &newAggregateID)
        guard aggStatus == noErr, newAggregateID != AudioObjectID(kAudioObjectUnknown) else {
            cleanupTap()
            throw NSError(domain: "CoreAudioTap", code: Int(aggStatus),
                          userInfo: [NSLocalizedDescriptionKey: "AudioHardwareCreateAggregateDevice failed (status=\(aggStatus))"])
        }
        aggregateID = newAggregateID

        // 4. Read the tap's stream format and build the converter to 16 kHz mono.
        guard let tapFormat = tapStreamFormat(tapID) else {
            cleanupAggregate()
            cleanupTap()
            throw NSError(domain: "CoreAudioTap", code: -3,
                          userInfo: [NSLocalizedDescriptionKey: "Could not read tap stream format"])
        }
        inputFormat = tapFormat
        converter = AVAudioConverter(from: tapFormat, to: targetFormat)
        guard converter != nil else {
            cleanupAggregate()
            cleanupTap()
            throw NSError(domain: "CoreAudioTap", code: -4,
                          userInfo: [NSLocalizedDescriptionKey: "Could not build tap AVAudioConverter"])
        }

        // 5. Install the IOProc and start the device.
        var newIOProcID: AudioDeviceIOProcID?
        let procStatus = AudioDeviceCreateIOProcIDWithBlock(
            &newIOProcID, aggregateID, ioQueue
        ) { [weak self] _, inInputData, _, _, _ in
            self?.process(inputData: inInputData)
        }
        guard procStatus == noErr, let procID = newIOProcID else {
            cleanupAggregate()
            cleanupTap()
            throw NSError(domain: "CoreAudioTap", code: Int(procStatus),
                          userInfo: [NSLocalizedDescriptionKey: "AudioDeviceCreateIOProcIDWithBlock failed (status=\(procStatus))"])
        }
        ioProcID = procID

        let startStatus = AudioDeviceStart(aggregateID, procID)
        guard startStatus == noErr else {
            cleanupIOProc()
            cleanupAggregate()
            cleanupTap()
            throw NSError(domain: "CoreAudioTap", code: Int(startStatus),
                          userInfo: [NSLocalizedDescriptionKey: "AudioDeviceStart failed (status=\(startStatus))"])
        }

        Log.info("CoreAudio tap started (input sr=\(tapFormat.sampleRate) ch=\(tapFormat.channelCount))")
    }

    func stop() {
        if stopped { return }
        stopped = true
        if #available(macOS 14.4, *) {
            cleanupIOProc()
            cleanupAggregate()
            cleanupTap()
        }
        Log.info("CoreAudio tap stopped")
    }

    // MARK: - IOProc

    /// Pull the tap's float buffers out of the IOProc input, resample to
    /// 16 kHz mono Int16 LE, and emit. Mirrors the proven conversion in
    /// ScreenCaptureAudio — but reads the AudioBufferList directly (no
    /// CMSampleBuffer extraction, which was the SCK path's bug).
    private func process(inputData: UnsafePointer<AudioBufferList>) {
        guard let inputFormat = inputFormat, let converter = converter else { return }

        guard let inBuffer = AVAudioPCMBuffer(
            pcmFormat: inputFormat,
            bufferListNoCopy: inputData,
            deallocator: nil
        ) else { return }

        let inFrames = inBuffer.frameLength
        if inFrames == 0 { return }

        let ratio = targetFormat.sampleRate / inputFormat.sampleRate
        let outCapacity = AVAudioFrameCount(Double(inFrames) * ratio + 1024)
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outCapacity) else {
            return
        }

        var consumed = false
        var error: NSError?
        let convStatus = converter.convert(to: outBuffer, error: &error) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return inBuffer
        }
        if let error = error {
            Log.error("tap convert: \(error.localizedDescription)")
            return
        }
        if convStatus == .error { return }

        guard let int16 = outBuffer.int16ChannelData else { return }
        let outFrames = Int(outBuffer.frameLength)
        if outFrames == 0 { return }
        let byteCount = outFrames * MemoryLayout<Int16>.size
        let data = Data(bytes: int16[0], count: byteCount)
        FrameWriter.write(tag: .tapPCM, payload: data)
    }

    // MARK: - Teardown helpers (reverse creation order)

    private func cleanupIOProc() {
        guard aggregateID != AudioObjectID(kAudioObjectUnknown), let procID = ioProcID else { return }
        AudioDeviceStop(aggregateID, procID)
        AudioDeviceDestroyIOProcID(aggregateID, procID)
        ioProcID = nil
    }

    private func cleanupAggregate() {
        guard aggregateID != AudioObjectID(kAudioObjectUnknown) else { return }
        AudioHardwareDestroyAggregateDevice(aggregateID)
        aggregateID = AudioObjectID(kAudioObjectUnknown)
    }

    @available(macOS 14.4, *)
    private func cleanupTap() {
        guard tapID != AudioObjectID(kAudioObjectUnknown) else { return }
        AudioHardwareDestroyProcessTap(tapID)
        tapID = AudioObjectID(kAudioObjectUnknown)
    }

    // MARK: - Core Audio queries

    /// Resolve a BSD process id to its Core Audio process object id.
    private func processObject(forPID pid: pid_t) -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var pidValue = pid
        var objectID = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            UInt32(MemoryLayout<pid_t>.size),
            &pidValue,
            &size,
            &objectID
        )
        guard status == noErr, objectID != AudioObjectID(kAudioObjectUnknown) else { return nil }
        return objectID
    }

    /// UID string of the current default *system* output device — used as the
    /// aggregate device's clock source / main sub-device.
    private func defaultOutputDeviceUID() -> String? {
        var deviceAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var deviceID = AudioObjectID(kAudioObjectUnknown)
        var deviceSize = UInt32(MemoryLayout<AudioObjectID>.size)
        var status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &deviceAddress, 0, nil, &deviceSize, &deviceID
        )
        guard status == noErr, deviceID != AudioObjectID(kAudioObjectUnknown) else { return nil }

        var uidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uid: CFString = "" as CFString
        var uidSize = UInt32(MemoryLayout<CFString>.size)
        status = withUnsafeMutablePointer(to: &uid) {
            AudioObjectGetPropertyData(deviceID, &uidAddress, 0, nil, &uidSize, $0)
        }
        guard status == noErr else { return nil }
        return uid as String
    }

    /// The tap's output stream format (typically Float32 at the output device's
    /// sample rate). Only valid on 14.4+ where `kAudioTapPropertyFormat` exists.
    @available(macOS 14.4, *)
    private func tapStreamFormat(_ tap: AudioObjectID) -> AVAudioFormat? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &asbd)
        guard status == noErr else {
            Log.error("kAudioTapPropertyFormat read failed (status=\(status))")
            return nil
        }
        return AVAudioFormat(streamDescription: &asbd)
    }
}
