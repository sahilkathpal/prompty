import Foundation
// Protocol.swift is compiled into the same binary as this file; no module import needed.

/// Standalone test runner. Mirrors ProtocolTests.swift but uses `precondition`
/// instead of XCTest so it can run under Command Line Tools (no Xcode required).

@main
struct StandaloneTests {
    static var passed = 0
    static var failed = 0

    static func check(_ name: String, _ cond: @autoclosure () -> Bool, _ detail: String = "") {
        if cond() {
            passed += 1
            FileHandle.standardOutput.write(Data("ok   - \(name)\n".utf8))
        } else {
            failed += 1
            FileHandle.standardOutput.write(Data("FAIL - \(name) \(detail)\n".utf8))
        }
    }

    static func main() {
        // 1. Empty payload round-trip.
        do {
            let encoded = FrameWriter.encode(tag: .control, payload: Data())
            check("empty payload header size", encoded.count == 5)
            let d = FrameWriter.decode(encoded)
            check("empty payload decodes", d != nil)
            check("empty payload tag", d?.tag == .control)
            check("empty payload payload empty", d?.payload.count == 0)
            check("empty payload consumed=5", d?.consumed == 5)
        }

        // 2. PCM payload round-trip.
        do {
            let samples: [Int16] = [0, 1, -1, 32767, -32768, 1234]
            let payload = samples.withUnsafeBufferPointer { Data(buffer: $0) }
            let encoded = FrameWriter.encode(tag: .micPCM, payload: payload)
            check("pcm encoded length", encoded.count == 5 + payload.count)
            check("pcm tag byte", encoded[0] == FrameTag.micPCM.rawValue)
            let d = FrameWriter.decode(encoded)
            check("pcm decodes", d != nil)
            check("pcm tag round-trip", d?.tag == .micPCM)
            check("pcm payload round-trip", d?.payload == payload)
        }

        // 3. Control JSON round-trip.
        do {
            let obj: [String: Any] = ["type": "ready"]
            let payload = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
            let encoded = FrameWriter.encode(tag: .control, payload: payload)
            let d = FrameWriter.decode(encoded)
            check("control tag", d?.tag == .control)
            let rt = try! JSONSerialization.jsonObject(with: d!.payload) as? [String: String]
            check("control json type=ready", rt?["type"] == "ready")
        }

        // 4. Concatenated frames decode sequentially.
        do {
            let a = FrameWriter.encode(tag: .micPCM, payload: Data([0x01, 0x02, 0x03]))
            let b = FrameWriter.encode(tag: .tapPCM, payload: Data([0xAA, 0xBB]))
            var buf = Data()
            buf.append(a); buf.append(b)
            let first = FrameWriter.decode(buf)!
            check("concat first tag", first.tag == .micPCM)
            check("concat first payload", first.payload == Data([0x01, 0x02, 0x03]))
            let rest = buf.subdata(in: first.consumed..<buf.count)
            let second = FrameWriter.decode(rest)!
            check("concat second tag", second.tag == .tapPCM)
            check("concat second payload", second.payload == Data([0xAA, 0xBB]))
        }

        // 5. Short buffer returns nil.
        do {
            check("empty data decodes nil", FrameWriter.decode(Data()) == nil)
            check("1-byte decodes nil", FrameWriter.decode(Data([0x02])) == nil)
            var partial = Data([0x02, 0x00, 0x00, 0x00, 0x0A])
            partial.append(contentsOf: [0x01, 0x02, 0x03, 0x04, 0x05])
            check("partial payload decodes nil", FrameWriter.decode(partial) == nil)
        }

        // 6. Unknown tag → nil.
        do {
            let bad = Data([0x09, 0x00, 0x00, 0x00, 0x00])
            check("unknown tag decodes nil", FrameWriter.decode(bad) == nil)
        }

        // 7. Big-endian length encoding.
        do {
            let payload = Data(repeating: 0xCC, count: 258)
            let encoded = FrameWriter.encode(tag: .tapPCM, payload: payload)
            check("BE byte 0", encoded[0] == FrameTag.tapPCM.rawValue)
            check("BE byte 1", encoded[1] == 0x00)
            check("BE byte 2", encoded[2] == 0x00)
            check("BE byte 3", encoded[3] == 0x01)
            check("BE byte 4", encoded[4] == 0x02)
        }

        FileHandle.standardOutput.write(Data("\n\(passed) passed, \(failed) failed\n".utf8))
        exit(failed == 0 ? 0 : 1)
    }
}
