// Unit: the pure sidecar frame demuxer (sidecar-protocol.ts) — the JS twin of
// the Swift ProtocolTests on the other end of the wire.

import { describe, it, expect } from "vitest";
import {
  createFrameParser,
  FRAME_TAG_CONTROL,
  FRAME_TAG_MIC,
  FRAME_TAG_TAP,
} from "../../src/main-process/sidecar-protocol";

/** Encode one frame: [1B tag][4B BE len][payload]. */
function frame(tag: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head[0] = tag;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

describe("createFrameParser", () => {
  it("decodes multiple whole frames in one chunk, preserving tag + payload", () => {
    const p = createFrameParser();
    const mic = Buffer.from([1, 2, 3, 4]);
    const tap = Buffer.from([9, 8]);
    const frames = p.push(Buffer.concat([frame(FRAME_TAG_MIC, mic), frame(FRAME_TAG_TAP, tap)]));
    expect(frames).toHaveLength(2);
    expect(frames[0].tag).toBe(FRAME_TAG_MIC);
    expect(frames[0].payload.equals(mic)).toBe(true);
    expect(frames[1].tag).toBe(FRAME_TAG_TAP);
    expect(frames[1].payload.equals(tap)).toBe(true);
  });

  it("buffers a frame split across chunks until the remainder arrives", () => {
    const p = createFrameParser();
    const payload = Buffer.from("hello-control");
    const full = frame(FRAME_TAG_CONTROL, payload);
    expect(p.push(full.subarray(0, 3))).toHaveLength(0); // header only, partial
    expect(p.push(full.subarray(3, 8))).toHaveLength(0); // still mid-payload
    const frames = p.push(full.subarray(8)); // the rest
    expect(frames).toHaveLength(1);
    expect(frames[0].tag).toBe(FRAME_TAG_CONTROL);
    expect(frames[0].payload.toString()).toBe("hello-control");
  });

  it("handles a zero-length payload frame", () => {
    const p = createFrameParser();
    const frames = p.push(frame(FRAME_TAG_MIC, Buffer.alloc(0)));
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.length).toBe(0);
  });

  it("detaches payloads from later buffer growth", () => {
    const p = createFrameParser();
    const [f] = p.push(frame(FRAME_TAG_TAP, Buffer.from([7, 7])));
    const snapshot = Buffer.from(f.payload);
    p.push(frame(FRAME_TAG_TAP, Buffer.from([1, 1]))); // more traffic
    expect(f.payload.equals(snapshot)).toBe(true); // unchanged
  });
});
