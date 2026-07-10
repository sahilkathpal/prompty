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
///      (so Prompty's own sounds never land in the "them" stream).
///   2. `AudioHardwareCreateProcessTap` → a tap object.
///   3. A private aggregate device that contains the tap as a sub-tap, clocked by
///      the current default output device.
///   4. An IOProc on the aggregate device that pulls the tap's float buffers,
///      resamples them to 16 kHz mono Int16 LE, and emits tag-0x03 frames.
///   5. Full teardown on stop().
///
/// This requires only an audio-capture consent — it never touches Screen
/// Recording. It is the sole system-audio path; Prompty requires macOS 14.4+.
///
/// **Bluetooth robustness (the reason the graph is rebuildable):** the aggregate
/// is clocked by the output device captured at build time. When that device
/// changes mode/format mid-session — most importantly a Bluetooth headset
/// flipping A2DP→HFP the moment the mic opens — the aggregate built around the
/// old (A2DP) device stops delivering audio and the "them" stream goes silent.
/// Rebuilding only the converter (the previous behavior) does not fix that; the
/// aggregate itself is stale. So we watch for the transition — via the output
/// device's nominal sample rate changing (48 kHz→16 kHz on the A2DP→HFP flip),
/// the default output device changing, or the tap format changing — and rebuild
/// the whole graph around the new device state.
///
/// The class is available from the package's deployment target (macOS 14) so
/// `main.swift` can hold an optional reference unconditionally; `start()` and the
/// helpers that touch the 14.4-only Tap API are annotated `@available(macOS 14.4)`,
/// and `stop()` guards its teardown internally so it stays callable from the
/// shutdown path.
final class CoreAudioTap {
    private var tapID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?

    private var inputFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var stopped = false
    private var formatListener: AudioObjectPropertyListenerBlock?

    // Rebuild machinery (see the class doc). `outputDeviceID` is the real output
    // device the current graph is clocked by; `deviceRateListener` fires when its
    // nominal sample rate changes (the A2DP↔HFP tell), `defaultDeviceListener`
    // when the default output device itself changes. Both schedule a debounced
    // full-graph rebuild. `rebuilding` guards re-entrancy; `pendingRebuild`
    // coalesces the burst of notifications a single transition emits.
    private var outputDeviceID: AudioObjectID = AudioObjectID(kAudioObjectUnknown)
    private var deviceRateListener: AudioObjectPropertyListenerBlock?
    private var defaultDeviceListener: AudioObjectPropertyListenerBlock?
    private var pendingRebuild: DispatchWorkItem?
    private var rebuilding = false
    // Self-induced-rebuild guard. Creating/destroying the aggregate coerces the
    // output device's nominal sample rate, which re-fires deviceRateListener; on
    // Bluetooth (where the A2DP↔HFP flip already flaps the SR) that self-sustains a
    // rebuild storm — rebuilds several times a second for the whole call, spewing
    // redundant rebuilds and spurious tap_silent telemetry. We ignore listener-driven
    // rebuilds for a short settle window after each rebuild, so only a GENUINE
    // external device change re-triggers. The frame-flow watchdog (which calls
    // rebuildGraph directly, not through here) still catches a real change missed
    // during the window. Built-in/wired output never flaps its SR, so this is inert
    // there — matching the field data (built-in: 0 rebuilds; Bluetooth: the storm).
    // NB: this damps our own churn only. It does not stop the playback muting a BT
    // headset shows when the mic opens — that's the inherent A2DP→HFP flip (same in
    // Granola et al.), unavoidable while capturing the BT mic.
    private var listenerSuppressedUntil = DispatchTime.now()
    private let rebuildSettleWindow: TimeInterval = 2.0

    // Frame-flow watchdog. A live aggregate is clocked, so its IOProc fires
    // continuously and delivers buffers — zeros while the far end is silent —
    // meaning `frameCount` advances forever on a healthy tap. A tap built around
    // a *stale* device delivers NOTHING: its IOProc never fires. The classic case
    // is the Bluetooth startup race — the aggregate gets clocked on the headset's
    // A2DP profile in the instant before the mic opening flips it to HFP, and the
    // build-time device listeners miss the flip because they are attached only at
    // the END of buildGraph(), after the stale aggregate is already running. The
    // rate/default-device/format listeners therefore never fire, so nothing
    // rebuilds and "them" is silent for the whole call. The watchdog samples
    // `frameCount` on a timer and, when it stops advancing, forces a full
    // `rebuildGraph()` around the now-settled device. Bounded retries per silence
    // episode so a genuinely dead output can't spin forever.
    private var frameCount: UInt64 = 0
    private var watchdog: DispatchSourceTimer?
    private var lastWatchdogFrames: UInt64 = 0
    private var watchdogRebuilds = 0
    private var watchdogGaveUp = false
    private let watchdogInterval: TimeInterval = 1.0
    private let maxWatchdogRebuilds = 4

    // The output device the aggregate is currently clocked by (its name), logged
    // at build time so field diagnostics show which device the tap latched onto.
    private var outputDeviceName: String = "?"

    /// 16 kHz mono, Int16, interleaved, little-endian — the wire format every
    /// downstream consumer (tag 0x03) expects. Identical to MicCapture.
    private let targetFormat: AVAudioFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: true
    )!

    private let ioQueue = DispatchQueue(label: "prompty.sidecar.coreaudio.tap")

    init() {}

    @available(macOS 14.4, *)
    func start() throws {
        try buildGraph()
        // System-wide listener for the default output device changing (e.g. the
        // user switches from speakers to a Bluetooth headset). Added once and
        // kept for the object's lifetime; the per-device listeners are (re)added
        // inside buildGraph().
        addDefaultDeviceListener()
        // Recovery of last resort: if the graph we just built produces no frames
        // (the Bluetooth startup race the listeners can't see), rebuild it.
        startWatchdog()
    }

    /// Build the tap + aggregate + IOProc graph and start it. Re-runnable:
    /// `rebuildGraph()` tears down and calls this again when the output device
    /// flips (Bluetooth A2DP↔HFP, or a default-device change).
    @available(macOS 14.4, *)
    private func buildGraph() throws {
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
        // Clock the aggregate by the BUILT-IN output device, NOT the current
        // default. A global process tap captures the system-wide mix regardless of
        // which device that audio is finally routed to — but building the aggregate
        // AROUND the live output device (as a sub-device) means we take that device
        // over: on a Bluetooth call that both (a) cuts the user's own playback and
        // (b) leaves the tap capturing an empty stream. The built-in output is
        // always present, never flips A2DP↔HFP, and isn't the device the user is
        // listening on, so clocking to it leaves their Bluetooth route untouched
        // while the tap still captures the global mix. Fall back to the default
        // output only on a Mac with no built-in output (headless).
        guard let output = builtInOutputDevice() ?? defaultOutputDevice() else {
            cleanupTap()
            throw NSError(domain: "CoreAudioTap", code: -2,
                          userInfo: [NSLocalizedDescriptionKey: "No output device for aggregate clock"])
        }
        outputDeviceID = output.id
        outputDeviceName = deviceName(output.id)
        let outputUID = output.uid

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

        // The tap format changing is one signal that the output device flipped;
        // rebuild the whole graph (not just the converter — the aggregate is
        // stale too). Runs on ioQueue, so it never races `process`.
        var fmtAddress = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let fmtBlock: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.scheduleRebuild(reason: "tap format changed")
        }
        formatListener = fmtBlock
        AudioObjectAddPropertyListenerBlock(tapID, &fmtAddress, ioQueue, fmtBlock)

        // The most reliable signal for a Bluetooth A2DP→HFP flip: the output
        // device's nominal sample rate drops (e.g. 48 kHz→16 kHz). This fires
        // even when the tap's own format listener does not, so it is the primary
        // rebuild trigger for the silent-"them"-on-Bluetooth bug.
        var rateAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let rateBlock: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.scheduleRebuild(reason: "output device sample rate changed")
        }
        deviceRateListener = rateBlock
        AudioObjectAddPropertyListenerBlock(outputDeviceID, &rateAddress, ioQueue, rateBlock)

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

        Log.info("CoreAudio tap started (input sr=\(tapFormat.sampleRate) ch=\(tapFormat.channelCount) output='\(outputDeviceName)')")
    }

    // MARK: - Rebuild on device / format change

    /// Coalesce a burst of change notifications (one transition emits several)
    /// into a single debounced rebuild on the IO queue.
    @available(macOS 14.4, *)
    private func scheduleRebuild(reason: String) {
        guard !stopped else { return }
        if DispatchTime.now() < listenerSuppressedUntil {
            // Our own recent rebuild coerced the output SR — this notification is an
            // echo of our churn, not a real device change. Ignore it (the storm fix).
            Log.info("CoreAudio tap ignoring self-induced change (\(reason))")
            return
        }
        pendingRebuild?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.rebuildGraph(reason: reason) }
        pendingRebuild = work
        ioQueue.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    /// Tear down the current graph and build a fresh one around the current
    /// output device. Runs on `ioQueue`, serialized with `process`.
    @available(macOS 14.4, *)
    private func rebuildGraph(reason: String) {
        guard !stopped, !rebuilding else { return }
        rebuilding = true
        // Suppress listener-driven rebuilds while our own teardown+build coerces the
        // output SR — and for a window after, since the coercion echo can arrive
        // asynchronously once buildGraph re-attaches the listeners.
        listenerSuppressedUntil = DispatchTime.now() + rebuildSettleWindow
        Log.info("CoreAudio tap rebuilding (\(reason))")
        teardownGraph()
        do {
            try buildGraph()
        } catch {
            Log.error("CoreAudio tap rebuild failed: \(error.localizedDescription)")
        }
        rebuilding = false
        listenerSuppressedUntil = DispatchTime.now() + rebuildSettleWindow
    }

    // MARK: - Frame-flow watchdog

    /// Start the lifetime timer that samples `frameCount` for tap liveness. Like
    /// the default-device listener, it is created once and survives rebuilds.
    @available(macOS 14.4, *)
    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: ioQueue)
        timer.schedule(deadline: .now() + watchdogInterval, repeating: watchdogInterval)
        timer.setEventHandler { [weak self] in self?.watchdogTick() }
        watchdog = timer
        timer.resume()
    }

    /// Runs on `ioQueue`, serialized with `process` and `rebuildGraph`. If the
    /// tap delivered no new frames across the last interval it is dead/stale;
    /// rebuild the graph around the current device, bounded per silence episode.
    @available(macOS 14.4, *)
    private func watchdogTick() {
        guard !stopped, !rebuilding else { return }
        let current = frameCount
        if current != lastWatchdogFrames {
            // Frames are flowing — healthy. Clear any prior silence episode.
            lastWatchdogFrames = current
            if watchdogRebuilds > 0 {
                Log.info("CoreAudio tap frames recovered after \(watchdogRebuilds) rebuild(s)")
                FrameWriter.writeControl(["type": "tap_recovered", "rebuilds": watchdogRebuilds])
            }
            watchdogRebuilds = 0
            watchdogGaveUp = false
            return
        }
        // No new frames across a full interval → the "them" leg is silent.
        guard watchdogRebuilds < maxWatchdogRebuilds else {
            if !watchdogGaveUp {
                watchdogGaveUp = true
                Log.error("CoreAudio tap still silent after \(maxWatchdogRebuilds) rebuilds; giving up")
                FrameWriter.writeControl(["type": "tap_silent", "action": "gave_up", "attempt": watchdogRebuilds])
            }
            return
        }
        watchdogRebuilds += 1
        Log.info("CoreAudio tap silent (no frames in \(watchdogInterval)s); rebuilding (attempt \(watchdogRebuilds))")
        FrameWriter.writeControl(["type": "tap_silent", "action": "rebuild", "attempt": watchdogRebuilds])
        rebuildGraph(reason: "watchdog: no tap frames (attempt \(watchdogRebuilds))")
    }

    /// Tear down the tap/aggregate/IOProc and their per-graph listeners, leaving
    /// the object ready for a fresh `buildGraph()`. The system-wide
    /// default-device listener persists across rebuilds.
    @available(macOS 14.4, *)
    private func teardownGraph() {
        cleanupIOProc()
        cleanupAggregate()
        removeDeviceRateListener()
        cleanupTap()          // removes the tap format listener
        inputFormat = nil
        converter = nil
    }

    // MARK: - Device-change listeners

    @available(macOS 14.4, *)
    private func addDefaultDeviceListener() {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.scheduleRebuild(reason: "default output device changed")
        }
        defaultDeviceListener = block
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, ioQueue, block)
    }

    private func removeDefaultDeviceListener() {
        guard let block = defaultDeviceListener else { return }
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, ioQueue, block)
        defaultDeviceListener = nil
    }

    private func removeDeviceRateListener() {
        guard outputDeviceID != AudioObjectID(kAudioObjectUnknown), let block = deviceRateListener else { return }
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectRemovePropertyListenerBlock(outputDeviceID, &addr, ioQueue, block)
        deviceRateListener = nil
    }

    func stop() {
        if stopped { return }
        stopped = true
        watchdog?.cancel()
        watchdog = nil
        pendingRebuild?.cancel()
        pendingRebuild = nil
        removeDefaultDeviceListener()
        if #available(macOS 14.4, *) {
            cleanupIOProc()
            cleanupAggregate()
            removeDeviceRateListener()
            cleanupTap()
        }
        Log.info("CoreAudio tap stopped")
    }

    // MARK: - IOProc

    /// Pull the tap's float buffers out of the IOProc input, resample to
    /// 16 kHz mono Int16 LE, and emit. Reads the AudioBufferList directly via
    /// `AVAudioConverter` — the same conversion the mic path uses.
    private func process(inputData: UnsafePointer<AudioBufferList>) {
        guard let inputFormat = inputFormat, let converter = converter else { return }

        guard let inBuffer = AVAudioPCMBuffer(
            pcmFormat: inputFormat,
            bufferListNoCopy: inputData,
            deallocator: nil
        ) else { return }

        let inFrames = inBuffer.frameLength
        if inFrames == 0 { return }
        // Liveness signal for the watchdog: a clocked aggregate delivers buffers
        // continuously (zeros during far-end silence), so this advances forever
        // on a healthy tap and freezes the instant the graph goes stale.
        frameCount &+= 1

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
        if let listener = formatListener {
            var fmtAddress = AudioObjectPropertyAddress(
                mSelector: kAudioTapPropertyFormat,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            AudioObjectRemovePropertyListenerBlock(tapID, &fmtAddress, ioQueue, listener)
            formatListener = nil
        }
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

    /// The built-in output device (transport = BuiltIn, with output channels) —
    /// the stable clock we prefer so the aggregate never attaches to the user's
    /// actual (possibly Bluetooth) output. nil on a Mac with no built-in output.
    private func builtInOutputDevice() -> (id: AudioObjectID, uid: String)? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &dataSize) == noErr,
              dataSize > 0 else { return nil }
        let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
        var devices = [AudioObjectID](repeating: AudioObjectID(kAudioObjectUnknown), count: count)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &dataSize, &devices) == noErr else { return nil }
        for dev in devices where transportType(of: dev) == kAudioDeviceTransportTypeBuiltIn {
            if deviceHasOutputChannels(dev), let uid = deviceUID(dev) { return (dev, uid) }
        }
        return nil
    }

    private func transportType(of dev: AudioObjectID) -> UInt32 {
        guard dev != AudioObjectID(kAudioObjectUnknown) else { return 0 }
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var t: UInt32 = 0
        var sz = UInt32(MemoryLayout<UInt32>.size)
        _ = AudioObjectGetPropertyData(dev, &addr, 0, nil, &sz, &t)
        return t
    }

    private func deviceHasOutputChannels(_ dev: AudioObjectID) -> Bool {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioObjectPropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain)
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(dev, &addr, 0, nil, &dataSize) == noErr, dataSize > 0 else { return false }
        let ptr = UnsafeMutableRawPointer.allocate(byteCount: Int(dataSize),
                                                   alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { ptr.deallocate() }
        guard AudioObjectGetPropertyData(dev, &addr, 0, nil, &dataSize, ptr) == noErr else { return false }
        let abl = UnsafeMutableAudioBufferListPointer(ptr.assumingMemoryBound(to: AudioBufferList.self))
        for buf in abl where buf.mNumberChannels > 0 { return true }
        return false
    }

    private func deviceUID(_ dev: AudioObjectID) -> String? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var uid: CFString = "" as CFString
        var sz = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &uid) {
            AudioObjectGetPropertyData(dev, &addr, 0, nil, &sz, $0)
        }
        guard status == noErr else { return nil }
        return uid as String
    }

    /// The current default *system* output device — its object id (used to clock
    /// the aggregate and to watch its sample rate) and UID (used as the
    /// aggregate's main sub-device).
    private func defaultOutputDevice() -> (id: AudioObjectID, uid: String)? {
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
        return (deviceID, uid as String)
    }

    /// DIAGNOSTIC: human-readable name of a device (for logging which output the
    /// tap is clocked to across a mid-call device switch).
    private func deviceName(_ dev: AudioObjectID) -> String {
        guard dev != AudioObjectID(kAudioObjectUnknown) else { return "?" }
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var name: CFString = "" as CFString
        var size = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &name) {
            AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, $0)
        }
        guard status == noErr else { return "?" }
        return name as String
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
