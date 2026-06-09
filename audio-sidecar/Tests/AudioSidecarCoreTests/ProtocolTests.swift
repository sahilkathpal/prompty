import XCTest
@testable import AudioSidecarCore

final class ProtocolTests: XCTestCase {
    func testRoundTripEmptyPayload() throws {
        let encoded = FrameWriter.encode(tag: .control, payload: Data())
        XCTAssertEqual(encoded.count, 5)
        let decoded = FrameWriter.decode(encoded)
        XCTAssertNotNil(decoded)
        XCTAssertEqual(decoded?.tag, .control)
        XCTAssertEqual(decoded?.payload.count, 0)
        XCTAssertEqual(decoded?.consumed, 5)
    }

    func testRoundTripPCMPayload() throws {
        let samples: [Int16] = [0, 1, -1, 32767, -32768, 1234]
        let payload = samples.withUnsafeBufferPointer { Data(buffer: $0) }
        let encoded = FrameWriter.encode(tag: .micPCM, payload: payload)
        XCTAssertEqual(encoded.count, 5 + payload.count)
        XCTAssertEqual(encoded[0], FrameTag.micPCM.rawValue)

        let decoded = FrameWriter.decode(encoded)
        XCTAssertEqual(decoded?.tag, .micPCM)
        XCTAssertEqual(decoded?.payload, payload)
        XCTAssertEqual(decoded?.consumed, encoded.count)
    }

    func testRoundTripControlJSON() throws {
        let obj: [String: Any] = ["type": "ready"]
        let payload = try JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
        let encoded = FrameWriter.encode(tag: .control, payload: payload)
        let decoded = FrameWriter.decode(encoded)
        XCTAssertEqual(decoded?.tag, .control)
        let roundtrip = try JSONSerialization.jsonObject(with: decoded!.payload) as? [String: String]
        XCTAssertEqual(roundtrip?["type"], "ready")
    }

    func testConcatenatedFramesDecodeSequentially() throws {
        let a = FrameWriter.encode(tag: .micPCM, payload: Data([0x01, 0x02, 0x03]))
        let b = FrameWriter.encode(tag: .tapPCM, payload: Data([0xAA, 0xBB]))
        var buf = Data()
        buf.append(a)
        buf.append(b)

        let first = FrameWriter.decode(buf)!
        XCTAssertEqual(first.tag, .micPCM)
        XCTAssertEqual(first.payload, Data([0x01, 0x02, 0x03]))

        let rest = buf.subdata(in: first.consumed..<buf.count)
        let second = FrameWriter.decode(rest)!
        XCTAssertEqual(second.tag, .tapPCM)
        XCTAssertEqual(second.payload, Data([0xAA, 0xBB]))
    }

    func testShortBufferReturnsNil() {
        XCTAssertNil(FrameWriter.decode(Data()))
        XCTAssertNil(FrameWriter.decode(Data([0x02])))
        // Header claims 10 bytes, only 5 present after header → incomplete.
        var partial = Data([0x02, 0x00, 0x00, 0x00, 0x0A])
        partial.append(contentsOf: [0x01, 0x02, 0x03, 0x04, 0x05])
        XCTAssertNil(FrameWriter.decode(partial))
    }

    func testUnknownTagDecodesNil() {
        let bad = Data([0x09, 0x00, 0x00, 0x00, 0x00])
        XCTAssertNil(FrameWriter.decode(bad))
    }

    func testBigEndianLengthEncoding() {
        // 258 = 0x0102 → bytes 0x00 0x00 0x01 0x02
        let payload = Data(repeating: 0xCC, count: 258)
        let encoded = FrameWriter.encode(tag: .tapPCM, payload: payload)
        XCTAssertEqual(encoded[0], FrameTag.tapPCM.rawValue)
        XCTAssertEqual(encoded[1], 0x00)
        XCTAssertEqual(encoded[2], 0x00)
        XCTAssertEqual(encoded[3], 0x01)
        XCTAssertEqual(encoded[4], 0x02)
    }
}
