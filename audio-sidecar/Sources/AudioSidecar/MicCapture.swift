import Foundation
import AVFoundation
import AudioSidecarCore
import ObjCException

/// Captures the default input device (microphone) via AVAudioEngine,
/// resamples to 16 kHz mono Int16 little-endian PCM, and emits each chunk
/// as a tag-0x02 frame on stdout.
final class MicCapture {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var stopped = false
    private var configObserver: NSObjectProtocol?

    // Reconfiguration is debounced and retried — see handleConfigChange(). Both
    // the debounce and the retries run on .main (the observer's queue), so
    // `reconfigGen`/`pendingReconfig` are only ever touched from one queue.
    private var reconfigGen = 0
    private var pendingReconfig: DispatchWorkItem?
    private static let reconfigDebounce: TimeInterval = 0.3
    private static let reconfigMaxAttempts = 6

    private let targetFormat: AVAudioFormat = {
        // 16 kHz mono, Int16, interleaved, little-endian (native on macOS).
        return AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16_000,
            channels: 1,
            interleaved: true
        )!
    }()

    func start() throws {
        // macOS may start the engine and deliver all-zero (silent) buffers when
        // mic access isn't effectively granted, rather than failing. Surface the
        // authorization state up front so a denial is visible in the logs even
        // though capture still "succeeds". The app's runtime silence detector is
        // the authoritative backstop for the granted-but-silent case.
        let micAuth = AVCaptureDevice.authorizationStatus(for: .audio)
        if micAuth != .authorized {
            Log.error("microphone not authorized (status=\(micAuth.rawValue)) — capture may be silent; grant Microphone access in System Settings → Privacy & Security")
        }

        try buildAndStart(label: "started")

        // The default input device's format can change mid-session — most
        // commonly when a VoIP call (WhatsApp/Zoom/etc.) starts and macOS flips a
        // Bluetooth headset from A2DP to narrowband HFP, or switches the input
        // device outright. AVAudioEngine tears down the tap and posts this
        // notification when that happens. We must rebuild the tap+converter
        // against the new format — but the new HW format is often still settling
        // when the notification fires, and installing a tap against a mismatched
        // format raises an *Objective-C* NSException ('Input HW format and tap
        // format not matching') that Swift can't catch → SIGABRT, killing the
        // whole sidecar (and the "them" stream with it). handleConfigChange()
        // debounces the burst, stops the engine first, runs the risky calls
        // under an NSException shim, and retries while the format settles.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            self?.handleConfigChange()
        }
    }

    /// Read the current input format, build the converter, install the tap, and
    /// start the engine. The two calls that can raise an uncatchable ObjC
    /// NSException during a hardware-format flip — `installTap` and
    /// `engine.start()` — run under `runCatchingObjCException`, so a transient
    /// mismatch surfaces as a thrown Swift error (→ retry) instead of a crash.
    private func buildAndStart(label: String) throws {
        let input = engine.inputNode

        // Always tear down to a known-stopped state first. Installing a tap on a
        // running engine mid-format-flip is exactly what triggers the mismatch
        // NSException; stopping first lets the engine re-resolve the HW format.
        if engine.isRunning { engine.stop() }
        input.removeTap(onBus: 0)

        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            throw Self.err("No microphone input available (sr=0)")
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw Self.err("Could not build mic AVAudioConverter")
        }

        // ~100 ms buffer at input sample rate.
        let bufferSize = AVAudioFrameCount(inputFormat.sampleRate / 10)
        try runCatchingObjCException {
            input.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, _ in
                self?.handle(buffer: buffer)
            }
        }
        self.converter = converter

        do {
            try runCatchingObjCException { try self.engine.start() }
        } catch {
            // Don't leave a tap installed on an engine that failed to start.
            input.removeTap(onBus: 0)
            throw error
        }

        Log.info("MicCapture \(label) (input sr=\(inputFormat.sampleRate) ch=\(inputFormat.channelCount))")
    }

    private func handleConfigChange() {
        guard !stopped else { return }
        // A single device transition (e.g. AirPods A2DP↔HFP) fires several
        // configuration-change notifications in a burst. Coalesce them: bump the
        // generation, cancel any pending reconfigure, and schedule one after a
        // short debounce. Any in-flight retry from a prior generation will bail.
        reconfigGen += 1
        let gen = reconfigGen
        pendingReconfig?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.reconfigure(attempt: 0, gen: gen)
        }
        pendingReconfig = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.reconfigDebounce, execute: work)
    }

    private func reconfigure(attempt: Int, gen: Int) {
        guard !stopped, gen == reconfigGen else { return }  // superseded or stopped
        do {
            try buildAndStart(label: "reconfigured")
        } catch {
            if attempt + 1 < Self.reconfigMaxAttempts {
                // The HW format is likely still settling. Back off and retry;
                // a newer config-change (gen bump) cancels this chain.
                let delay = 0.25 * Double(attempt + 1)
                Log.error("MicCapture reconfigure failed (attempt \(attempt + 1)/\(Self.reconfigMaxAttempts)): \(error.localizedDescription) — retrying in \(delay)s")
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.reconfigure(attempt: attempt + 1, gen: gen)
                }
            } else {
                Log.error("MicCapture reconfigure gave up after \(Self.reconfigMaxAttempts) attempts: \(error.localizedDescription) — mic capture inactive until the next input-device change")
            }
        }
    }

    func stop() {
        stopped = true
        pendingReconfig?.cancel()
        pendingReconfig = nil
        if let obs = configObserver {
            NotificationCenter.default.removeObserver(obs)
            configObserver = nil
        }
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        Log.info("MicCapture stopped")
    }

    private static func err(_ message: String) -> NSError {
        NSError(domain: "MicCapture", code: 1,
                userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func handle(buffer: AVAudioPCMBuffer) {
        guard let converter = converter else { return }

        // Output capacity scales with the sample-rate ratio.
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let outCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1024)
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outCapacity) else {
            return
        }

        var consumed = false
        var error: NSError?
        let status = converter.convert(to: outBuffer, error: &error) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }

        if let error = error {
            Log.error("mic convert: \(error.localizedDescription)")
            return
        }
        if status == .error { return }

        guard let int16 = outBuffer.int16ChannelData else { return }
        let frames = Int(outBuffer.frameLength)
        if frames == 0 { return }
        let byteCount = frames * MemoryLayout<Int16>.size
        let data = Data(bytes: int16[0], count: byteCount)
        FrameWriter.write(tag: .micPCM, payload: data)
    }
}

/// Run `block`, converting any ObjC `NSException` it raises into a thrown Swift
/// error. Swift errors thrown by `block` propagate unchanged. This bridges the
/// gap that makes AVAudioEngine's exception-raising calls uncatchable from pure
/// Swift (see ObjCException.h / ocx_try).
func runCatchingObjCException(_ block: () throws -> Void) throws {
    var swiftError: Error?
    var objcError: NSError?
    let ok = ocx_try({
        do { try block() } catch { swiftError = error }
    }, &objcError)
    if let swiftError = swiftError { throw swiftError }
    if !ok {
        throw objcError ?? NSError(domain: "ObjCException", code: 0,
                                   userInfo: [NSLocalizedDescriptionKey: "unknown ObjC exception"])
    }
}
