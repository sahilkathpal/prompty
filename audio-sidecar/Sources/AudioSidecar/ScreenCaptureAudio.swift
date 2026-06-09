import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import AudioSidecarCore

/// Process-targeted system-audio capture via ScreenCaptureKit.
///
/// On macOS 13.0–14.3 this is the only supported path. On 14.4+ it's used as
/// the fallback while the CoreAudio Tap implementation is incomplete.
///
/// SCK audio-only configuration:
///   - `SCStreamConfiguration.capturesAudio = true`
///   - `excludesCurrentProcessAudio = true`
///   - Display content is captured (required by SCK) but the resulting video
///     frames are simply ignored. Only the audio sample buffers are processed.
///
/// We resample SCK's float32 interleaved buffers down to 16 kHz mono Int16 LE
/// and emit as tag 0x03 frames.
@available(macOS 13.0, *)
final class ScreenCaptureAudio: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private let targetFormat: AVAudioFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
    )!
    private let audioQueue = DispatchQueue(label: "prompty.sidecar.sck.audio")

    override init() {
        super.init()
    }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false,
                                                                          onScreenWindowsOnly: false)
        guard let display = content.displays.first else {
            throw NSError(domain: "SCK", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "No display available for SCK"])
        }

        // Always capture system-wide audio: every process on this display, no
        // per-app filter. The audio sample-buffer callback ignores video frames.
        let filter = SCContentFilter(display: display, excludingWindows: [])

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        // Video stream is required by SCK; keep it tiny and cheap.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 fps
        config.queueDepth = 5

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
        // Adding a video output is required for the stream to actually start delivering audio;
        // we ignore the frames.
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: audioQueue)

        try await stream.startCapture()
        self.stream = stream
        Log.info("SCK system-audio capture started")
    }

    func stop() {
        guard let stream = stream else { return }
        Task {
            try? await stream.stopCapture()
            Log.info("SCK audio capture stopped")
        }
        self.stream = nil
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee else {
            return
        }

        // Build / cache an input format that matches what SCK is actually sending.
        if inputFormat == nil ||
            inputFormat?.sampleRate != asbd.mSampleRate ||
            inputFormat?.channelCount != asbd.mChannelsPerFrame {
            var mutableASBD = asbd
            guard let fmt = AVAudioFormat(streamDescription: &mutableASBD) else { return }
            inputFormat = fmt
            converter = AVAudioConverter(from: fmt, to: targetFormat)
            Log.info("SCK input format sr=\(asbd.mSampleRate) ch=\(asbd.mChannelsPerFrame)")
        }
        guard let inputFormat = inputFormat, let converter = converter else { return }

        // Pull audio out of the CMSampleBuffer into an AVAudioPCMBuffer.
        let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frameCount > 0,
              let inBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frameCount) else {
            return
        }
        inBuffer.frameLength = frameCount

        var blockBuffer: CMBlockBuffer?
        var audioBufferList = AudioBufferList(
            mNumberBuffers: 1,
            mBuffers: AudioBuffer(mNumberChannels: 0, mDataByteSize: 0, mData: nil)
        )
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioBufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuffer
        )
        if status != noErr { return }

        // Copy bytes from the CMSampleBuffer's AudioBufferList into the AVAudioPCMBuffer's.
        let abl = UnsafeMutableAudioBufferListPointer(&audioBufferList)
        let dstAbl = UnsafeMutableAudioBufferListPointer(inBuffer.mutableAudioBufferList)
        for i in 0..<min(abl.count, dstAbl.count) {
            let src = abl[i]
            var dst = dstAbl[i]
            if let srcData = src.mData, let dstData = dst.mData {
                let n = min(Int(src.mDataByteSize), Int(dst.mDataByteSize))
                memcpy(dstData, srcData, n)
                dst.mDataByteSize = UInt32(n)
                dstAbl[i] = dst
            }
        }

        let ratio = targetFormat.sampleRate / inputFormat.sampleRate
        let outCapacity = AVAudioFrameCount(Double(frameCount) * ratio + 1024)
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
            Log.error("SCK convert: \(error.localizedDescription)")
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

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Log.error("SCK stream stopped with error: \(error.localizedDescription)")
        FrameWriter.writeControl(["type": "error", "msg": "sck_stopped: \(error.localizedDescription)"])
    }
}
