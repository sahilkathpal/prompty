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
    // The output device's nominal sample rate at build time. The rate listener
    // compares against it to ignore spurious rate-change echoes — our own aggregate
    // creation coerces the device rate, re-firing the listener with no real change.
    private var builtOutputSampleRate: Double = 0
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

    // Content-based silent-tap probe. The structural device-change listeners
    // (rate/default-device/format) handle the common failure — the tap going stale
    // when the output device or route changes — and never fire on mere silence, so
    // a far party going quiet or a pre-call gap never triggers a rebuild. This probe
    // is the backstop for the one case they miss: a tap that keeps its device but
    // delivers only silence (a stale graph, or the "clocked-but-all-zero" state).
    //
    // It is mute-safe by construction. We key on BIT-EXACT-ZERO content, not low
    // energy: a working tap on a quiet source always carries a noise floor (non-zero),
    // while a broken tap emits literal zeros. `lastNonZeroAt` is stamped whenever a
    // chunk carries any non-zero sample. If nothing non-zero arrives for
    // `silenceProbeWindow` — far longer than any conversational pause — we do ONE
    // rebuild "probe": if content returns, the tap was broken and is fixed; if it
    // stays silent, the source was genuinely quiet, so we back off (`probedThisEpisode`)
    // until non-zero content resets us. A wrong probe is harmless: a brief rebuild
    // during silence loses no audio and (measured) doesn't disturb playback.
    private var watchdog: DispatchSourceTimer?
    private var lastNonZeroAt: DispatchTime = .now()
    private var probedThisEpisode = false
    private let watchdogInterval: TimeInterval = 1.0
    // 45s: longer than any normal conversational mute/hold (so a live call's quiet
    // stretches don't probe), short enough to recover a genuinely dead tap within a
    // minute. A probe on a still-longer silence is harmless (see above).
    private let silenceProbeWindow: TimeInterval = 45.0

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
        // Backstop for the failure the structural listeners can't see: a tap that
        // keeps its device but delivers only silence. Mute-safe (see watchdogTick).
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
        // Clock the aggregate on the ACTUAL default output device (the Bluetooth
        // device during a BT call), falling back to built-in only on a headless Mac.
        // This is what makes Bluetooth "them" capture work: the far-party audio lives
        // on whatever device it's rendered to, so the aggregate must be clocked on
        // THAT device to see it. Clocking on the built-in output (the prior behavior)
        // left the tap blind to Bluetooth-routed audio — the empty-"them" bug.
        // Confirmed 2026-07-15: a real WhatsApp BT call captured the far party with
        // this clock, and the user's playback was NOT disrupted.
        guard let output = defaultOutputDevice() ?? builtInOutputDevice() else {
            cleanupTap()
            throw NSError(domain: "CoreAudioTap", code: -2,
                          userInfo: [NSLocalizedDescriptionKey: "No output device for aggregate clock"])
        }
        outputDeviceID = output.id
        outputDeviceName = deviceName(output.id)
        builtOutputSampleRate = currentOutputSampleRate() ?? 0
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
            guard let self = self else { return }
            // Value-based guard: creating our aggregate coerces the output device's
            // nominal rate, which re-fires this listener even though the rate is
            // unchanged. If it still matches what we built for, the change is spurious
            // — skip the rebuild (rebuilding re-coerces the device and, on Bluetooth,
            // feeds a tap<->mic storm). Only a REAL move (A2DP↔HFP) differs. More
            // robust than the time-based suppression window, which leaked rebuilds.
            if let now = self.currentOutputSampleRate(), now == self.builtOutputSampleRate {
                Log.info("CoreAudio tap ignoring rate-change (output rate unchanged: \(now))")
                return
            }
            self.scheduleRebuild(reason: "output device sample rate changed")
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

    /// Start the lifetime timer that drives the silent-tap probe (content liveness).
    /// Like the default-device listener, it is created once and survives rebuilds.
    @available(macOS 14.4, *)
    private func startWatchdog() {
        lastNonZeroAt = .now()
        let timer = DispatchSource.makeTimerSource(queue: ioQueue)
        timer.schedule(deadline: .now() + watchdogInterval, repeating: watchdogInterval)
        timer.setEventHandler { [weak self] in self?.watchdogTick() }
        watchdog = timer
        timer.resume()
    }

    /// Runs on `ioQueue`, serialized with `process` and `rebuildGraph`. Mute-safe
    /// silent-tap probe: if no non-zero audio has arrived for `silenceProbeWindow`
    /// (far longer than any conversational pause, and keyed on bit-exact-zero so a
    /// quiet-but-working tap doesn't count), do ONE rebuild probe. If content
    /// returns, `process` clears `probedThisEpisode` and reports recovery; if it
    /// stays silent, we hold off until non-zero content resets us.
    @available(macOS 14.4, *)
    private func watchdogTick() {
        guard !stopped, !rebuilding, !probedThisEpisode else { return }
        let silentNs = DispatchTime.now().uptimeNanoseconds &- lastNonZeroAt.uptimeNanoseconds
        guard silentNs > UInt64(silenceProbeWindow * 1_000_000_000) else { return }
        probedThisEpisode = true
        Log.info("CoreAudio tap silent \(Int(silenceProbeWindow))s (no non-zero content); rebuild probe")
        FrameWriter.writeControl(["type": "tap_silent", "action": "probe"])
        rebuildGraph(reason: "silent-tap probe (no content in \(Int(silenceProbeWindow))s)")
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

    /// The current nominal sample rate of the output device the aggregate is clocked
    /// by. Used to tell a real rate move (A2DP↔HFP) from our own coercion echo.
    private func currentOutputSampleRate() -> Double? {
        guard outputDeviceID != AudioObjectID(kAudioObjectUnknown) else { return nil }
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var sr: Double = 0
        var sz = UInt32(MemoryLayout<Double>.size)
        guard AudioObjectGetPropertyData(outputDeviceID, &addr, 0, nil, &sz, &sr) == noErr, sr > 0 else { return nil }
        return sr
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

        // Content liveness for the silent-tap probe: a working tap on a quiet source
        // still carries a noise floor, so any non-zero sample means the tap is really
        // capturing. Bit-exact-zero over a long window is what the probe acts on.
        let samples = int16[0]
        var anyNonZero = false
        for i in 0..<outFrames where samples[i] != 0 { anyNonZero = true; break }
        if anyNonZero {
            if probedThisEpisode {
                Log.info("CoreAudio tap content resumed after silent-probe rebuild")
                FrameWriter.writeControl(["type": "tap_recovered"])
            }
            lastNonZeroAt = .now()
            probedThisEpisode = false
        }

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
