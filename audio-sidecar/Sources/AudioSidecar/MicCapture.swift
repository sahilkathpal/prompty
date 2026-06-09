import Foundation
import AVFoundation
import AudioSidecarCore

/// Captures the default input device (microphone) via AVAudioEngine,
/// resamples to 16 kHz mono Int16 little-endian PCM, and emits each chunk
/// as a tag-0x02 frame on stdout.
final class MicCapture {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
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
        input.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, _ in
            self?.handle(buffer: buffer)
        }

        try engine.start()
        Log.info("MicCapture started (input sr=\(inputFormat.sampleRate) ch=\(inputFormat.channelCount))")
    }

    func stop() {
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
