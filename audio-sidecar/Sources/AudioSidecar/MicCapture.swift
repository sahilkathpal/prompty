import Foundation
import AVFoundation
import CoreAudio
import AudioSidecarCore
import ObjCException

/// Captures the default input device (microphone) via AVAudioEngine,
/// resamples to 16 kHz mono Int16 little-endian PCM, and emits each chunk
/// as a tag-0x02 frame on stdout.
final class MicCapture {
    private var engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var converterInputFormat: AVAudioFormat?
    private var stopped = false
    private var configObserver: NSObjectProtocol?

    // Reconfiguration is debounced and retried — see handleConfigChange(). Both
    // the debounce and the retries run on .main (the observer's queue), so
    // `reconfigGen`/`pendingReconfig` are only ever touched from one queue.
    private var reconfigGen = 0
    private var pendingReconfig: DispatchWorkItem?
    private static let reconfigDebounce: TimeInterval = 0.3
    private static let reconfigMaxAttempts = 6
    private static let slowRetryInterval: TimeInterval = 2.0

    // The default-input device + nominal sample rate the running engine was last
    // built for. Used to tell a real device/format change from a spurious
    // configuration-change so we don't rebuild the engine in a storm (see the
    // no-op guard in reconfigure()).
    private var lastBuiltInputSignature: (deviceID: AudioObjectID, sampleRate: Double)?

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

        // The config-change observer is (re)installed inside buildAndStart →
        // rebuildEngine(), bound to the current engine instance so it stays armed
        // across engine recreations. The default input device/format can change
        // mid-session — most commonly when a call starts and macOS flips a
        // Bluetooth headset from A2DP to narrowband HFP, or the user switches the
        // input device outright — and handleConfigChange() rebuilds for it.
        do {
            try buildAndStart(label: "started")
        } catch {
            // A cold-start failure (often a device mid-flip) is recoverable — do
            // not leave the mic dead. Arm the same retry loop the config-change
            // path uses; it keeps trying until the format settles or stop().
            Log.error("MicCapture initial start failed: \(error.localizedDescription) — entering retry loop")
            handleConfigChange()
        }
    }

    /// Read the current input format, build the converter, install the tap, and
    /// start the engine. The two calls that can raise an uncatchable ObjC
    /// NSException during a hardware-format flip — `installTap` and
    /// `engine.start()` — run under `runCatchingObjCException`, so a transient
    /// mismatch surfaces as a thrown Swift error (→ retry) instead of a crash.
    private func buildAndStart(label: String) throws {
        // Recreate the engine so its inputNode re-binds to the CURRENT default
        // input device. AVAudioEngine's inputNode caches its hardware device at
        // creation; after a device switch (e.g. to a Bluetooth headset) the old
        // engine's inputNode stays stuck on the previous device — the
        // diagnostics showed inputNode pinned at 48 kHz while the new device ran
        // at 16 kHz — and engine.start() then fails with -10868
        // (FormatNotSupported). Stop/start does not refresh it; only a fresh
        // engine does. rebuildEngine() also re-arms the config observer on the
        // new instance.
        rebuildEngine()
        let input = engine.inputNode

        let inputFormat = input.outputFormat(forBus: 0)
        // Captured for the failure logs below: a device flip that leaves the
        // input and output nodes on mismatched rates is what surfaces as -10868.
        let outputNodeFormat = engine.outputNode.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            throw Self.err("No microphone input available (sr=0)")
        }

        // Install the tap with the node's OWN current format (format: nil), not
        // the `inputFormat` we just read. During a hardware-format flip (a
        // Bluetooth headset switching A2DP↔HFP) the real HW format can move
        // between the read above and the install below; handing installTap a
        // now-stale format is exactly what raises the uncatchable 'Input HW
        // format and tap format not matching' NSException. Letting the node use
        // its own format removes that mismatch by construction. The converter is
        // built lazily in handle(buffer:) from each buffer's actual format, so
        // resampling follows the real input even as it changes.
        // ~100 ms buffer at the current input sample rate.
        let bufferSize = AVAudioFrameCount(inputFormat.sampleRate / 10)
        do {
            try runCatchingObjCException {
                input.installTap(onBus: 0, bufferSize: bufferSize, format: nil) { [weak self] buffer, _ in
                    self?.handle(buffer: buffer)
                }
            }
        } catch {
            Log.error("MicCapture buildAndStart[\(label)] installTap failed (input sr=\(inputFormat.sampleRate), output sr=\(outputNodeFormat.sampleRate)): \(error.localizedDescription)")
            throw error
        }

        do {
            try runCatchingObjCException { try self.engine.start() }
        } catch {
            // Don't leave a tap installed on an engine that failed to start.
            input.removeTap(onBus: 0)
            Log.error("MicCapture buildAndStart[\(label)] engine.start failed (input sr=\(inputFormat.sampleRate), output sr=\(outputNodeFormat.sampleRate)): \(error.localizedDescription)")
            throw error
        }

        // Record what we just bound to, so a later configuration-change can be
        // compared against it (real change → rebuild; same device+rate → skip).
        lastBuiltInputSignature = Self.currentInputSignature()

        Log.info("MicCapture \(label) (input sr=\(inputFormat.sampleRate) ch=\(inputFormat.channelCount))")
    }

    /// The current default INPUT device id + its nominal sample rate, read straight
    /// from CoreAudio. Deliberately NOT from engine.inputNode: after a device switch
    /// the inputNode can stay pinned to the previous device/format, which would make
    /// a real change look unchanged. Returns nil if the query fails (caller then
    /// rebuilds rather than risk skipping a needed reconfigure).
    private static func currentInputSignature() -> (deviceID: AudioObjectID, sampleRate: Double)? {
        var devAddr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var devID = AudioObjectID(kAudioObjectUnknown)
        var sz = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &devAddr, 0, nil, &sz, &devID) == noErr,
              devID != AudioObjectID(kAudioObjectUnknown) else { return nil }
        var srAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var sr: Double = 0
        var srSz = UInt32(MemoryLayout<Double>.size)
        guard AudioObjectGetPropertyData(devID, &srAddr, 0, nil, &srSz, &sr) == noErr, sr > 0 else { return nil }
        return (devID, sr)
    }

    /// Replace the AVAudioEngine with a fresh instance and (re)install the
    /// config-change observer on it. Needed because `inputNode` binds to its
    /// hardware device at engine-creation time and does not follow a
    /// default-input-device change; a fresh engine picks up the current device.
    private func rebuildEngine() {
        if let obs = configObserver {
            NotificationCenter.default.removeObserver(obs)
            configObserver = nil
        }
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        engine = AVAudioEngine()
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            self?.handleConfigChange()
        }
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

        // No-op guard (storm breaker): a fresh AVAudioEngine's own start() emits a
        // configuration-change, so rebuilding on every notification is
        // self-sustaining — on a Bluetooth mic it reconfigured every ~2-4s for a
        // whole call, starving the mic leg. If the engine is already running on the
        // SAME default-input device at the SAME sample rate we last built for, this
        // change is spurious: skip the rebuild (which would just provoke the next
        // one). A genuine change — device switch, or an A2DP↔HFP flip that moves the
        // sample rate — differs from lastBuiltInputSignature, so we fall through and
        // rebuild. Only applied on the first attempt; recovery retries always run.
        let nowSig = Self.currentInputSignature()
        if attempt == 0,
           let last = lastBuiltInputSignature,
           let now = nowSig,
           now.deviceID == last.deviceID, now.sampleRate == last.sampleRate {
            // Spurious change: the default-input device + rate is exactly what we
            // built for, so the inputNode is NOT stale and a full rebuild is pointless
            // — worse, recreating the engine re-touches the shared audio device and
            // feeds a tap<->mic storm on Bluetooth (the tap's aggregate coerces the
            // device rate → config-change here → rebuild → coercion → ...). If the
            // engine is still running, no-op. If the config-change merely STOPPED it
            // (the reason the old `engine.isRunning` guard never fired — the change
            // arrives with the engine already stopped), just restart it in place. Only
            // a real device/rate change (different signature) falls through to rebuild.
            if engine.isRunning {
                Log.info("MicCapture config-change ignored (input unchanged: device=\(now.deviceID) sr=\(now.sampleRate))")
                return
            }
            do {
                try runCatchingObjCException { try self.engine.start() }
                Log.info("MicCapture config-change: engine restarted in place (input unchanged: device=\(now.deviceID) sr=\(now.sampleRate))")
                return
            } catch {
                Log.error("MicCapture in-place restart failed: \(error.localizedDescription) — falling through to rebuild")
            }
        }

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
                // Don't give up permanently. A slow or flapping device (some
                // Bluetooth headsets) can take longer than the fast burst to
                // settle, and the old behavior left the mic dead for the rest of
                // the call. Fall back to a slow background retry that keeps
                // trying until it succeeds, stop() is called, or a newer device
                // change (gen bump) supersedes this chain.
                Log.error("MicCapture reconfigure still failing after \(Self.reconfigMaxAttempts) fast attempts: \(error.localizedDescription) — retrying every \(Self.slowRetryInterval)s until it recovers")
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.slowRetryInterval) { [weak self] in
                    self?.reconfigure(attempt: attempt, gen: gen)
                }
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
        let inFormat = buffer.format
        guard inFormat.sampleRate > 0 else { return }

        // Build (or rebuild) the converter to match THIS buffer's actual format.
        // Because the tap is installed with the node's own format, the delivered
        // format can change mid-session (Bluetooth A2DP↔HFP); rebuilding here
        // keeps resampling correct without reinstalling the tap. Runs only on the
        // tap's serial callback thread, so converter/converterInputFormat access
        // stays single-threaded.
        if converter == nil
            || converterInputFormat?.sampleRate != inFormat.sampleRate
            || converterInputFormat?.channelCount != inFormat.channelCount {
            guard let newConverter = AVAudioConverter(from: inFormat, to: targetFormat) else {
                Log.error("mic convert: could not build converter for sr=\(inFormat.sampleRate) ch=\(inFormat.channelCount)")
                return
            }
            converter = newConverter
            converterInputFormat = inFormat
        }
        guard let converter = converter else { return }

        // Output capacity scales with the sample-rate ratio.
        let ratio = targetFormat.sampleRate / inFormat.sampleRate
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
