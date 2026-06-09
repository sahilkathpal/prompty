import Foundation

/// Wire protocol for the AudioSidecar → Electron main process.
///
/// All bytes flow on stdout. stderr is human-readable logs only.
///
/// Frame layout (no padding, no terminator):
///
///     ┌────────┬─────────────────────────┬────────────────────┐
///     │ 1 byte │ 4 bytes (uint32, BE)    │  N bytes payload   │
///     │  tag   │  payload length N       │                    │
///     └────────┴─────────────────────────┴────────────────────┘
///
/// Tags:
///   0x01 = control JSON (UTF-8 encoded JSON object)
///   0x02 = mic PCM       (16 kHz, mono, signed 16-bit little-endian)
///   0x03 = tap PCM       (16 kHz, mono, signed 16-bit little-endian)
///
/// Control frames emitted by the sidecar:
///   {"type":"ready"}
///   {"type":"screen_share_started"}
///   {"type":"screen_share_stopped"}
///   {"type":"error","msg":"..."}
///
/// stdout writes are guarded by a global mutex so PCM chunks and control
/// frames never interleave at the byte level.
public enum FrameTag: UInt8 {
    case control = 0x01
    case micPCM = 0x02
    case tapPCM = 0x03
}

public enum FrameWriter {
    private static let lock = NSLock()
    private static let stdout = FileHandle.standardOutput

    /// Writes a single framed payload to stdout. Thread-safe.
    public static func write(tag: FrameTag, payload: Data) {
        let frame = encode(tag: tag, payload: payload)
        lock.lock()
        defer { lock.unlock() }
        do {
            try stdout.write(contentsOf: frame)
        } catch {
            // stdout closed → parent likely died. Exit cleanly.
            FileHandle.standardError.write(Data("sidecar: stdout write failed: \(error)\n".utf8))
            exit(0)
        }
    }

    /// Convenience for emitting a control message.
    public static func writeControl(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
        write(tag: .control, payload: data)
    }

    /// Encodes a frame into a Data blob (used by tests and any in-process consumer).
    public static func encode(tag: FrameTag, payload: Data) -> Data {
        var out = Data(capacity: 5 + payload.count)
        out.append(tag.rawValue)
        var len = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
        out.append(payload)
        return out
    }

    /// Decodes a single frame from the front of `data`. Returns (tag, payload, bytesConsumed)
    /// or nil if `data` is too short for a full frame.
    public static func decode(_ data: Data) -> (tag: FrameTag, payload: Data, consumed: Int)? {
        guard data.count >= 5 else { return nil }
        let rawTag = data[data.startIndex]
        guard let tag = FrameTag(rawValue: rawTag) else { return nil }
        let lenBytes = data.subdata(in: (data.startIndex + 1)..<(data.startIndex + 5))
        let len = lenBytes.withUnsafeBytes { raw -> UInt32 in
            raw.load(as: UInt32.self).bigEndian
        }
        guard data.count >= 5 + Int(len) else { return nil }
        let payloadEnd = data.startIndex + 5 + Int(len)
        let payload = data.subdata(in: (data.startIndex + 5)..<payloadEnd)
        return (tag, payload, 5 + Int(len))
    }
}

/// Stderr logger (human-readable, never machine-parsed).
public enum Log {
    public static func info(_ msg: String) {
        FileHandle.standardError.write(Data("[sidecar] \(msg)\n".utf8))
    }
    public static func error(_ msg: String) {
        FileHandle.standardError.write(Data("[sidecar][ERROR] \(msg)\n".utf8))
    }
}
