import Foundation
import AVFoundation
import AudioSidecarCore

/// Captures the default input device (microphone) via AVAudioEngine,
/// resamples to 16 kHz mono Int16 little-endian PCM, and emits each chunk
/// as a tag-0x02 frame on stdout.
final class MicCapture {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var stopped = false
    private var configObserver: NSObjectProtocol?
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

        let inputFormat = try installTapForCurrentInput()

        try engine.start()
        Log.info("MicCapture started (input sr=\(inputFormat.sampleRate) ch=\(inputFormat.channelCount))")

        // The default input device's format can change mid-session — most
        // commonly when a VoIP call (WhatsApp/Zoom/etc.) starts and macOS flips a
        // Bluetooth headset from A2DP to narrowband HFP, or switches the input
        // device outright. AVAudioEngine tears down the tap and posts this
        // notification when that happens; without re-reading the format and
        // rebuilding the converter, every subsequent buffer is resampled against
        // a stale rate and the transcript turns to garble. Rebuild on change.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            self?.handleConfigChange()
        }
    }

    /// Read the current input format, (re)build the converter for it, and install
    /// the tap. Returns the input format used. Caller starts the engine.
    @discardableResult
    private func installTapForCurrentInput() throws -> AVAudioFormat {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else {
            throw NSError(domain: "MicCapture", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No microphone input available"])
        }

        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw NSError(domain: "MicCapture", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Could not build mic AVAudioConverter"])
        }
        self.converter = converter

        // ~100 ms buffer at input sample rate.
        let bufferSize = AVAudioFrameCount(inputFormat.sampleRate / 10)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, _ in
            self?.handle(buffer: buffer)
        }
        return inputFormat
    }

    private func handleConfigChange() {
        guard !stopped else { return }
        do {
            let newFormat = try installTapForCurrentInput()
            if !engine.isRunning { try engine.start() }
            Log.info("MicCapture reconfigured (input sr=\(newFormat.sampleRate) ch=\(newFormat.channelCount))")
        } catch {
            Log.error("MicCapture reconfigure failed: \(error.localizedDescription)")
        }
    }

    func stop() {
        stopped = true
        if let obs = configObserver {
            NotificationCenter.default.removeObserver(obs)
            configObserver = nil
        }
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
        Log.info("MicCapture stopped")
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
