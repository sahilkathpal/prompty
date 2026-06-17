// Pure wire-protocol demuxer for the Swift AudioSidecar's stdout stream.
//
// Frame format (see audio-sidecar/Sources/AudioSidecarCore/Protocol.swift):
//   [1B tag][4B BE uint32 payload length][N bytes payload]
//   tag 0x01 = control JSON, 0x02 = mic PCM, 0x03 = tap PCM
//
// Kept dependency-free (no electron, no child_process) so the framing can be
// unit-tested directly — it's the JS twin of the Swift ProtocolTests on the
// other end of the same wire.

export const FRAME_TAG_CONTROL = 0x01;
export const FRAME_TAG_MIC = 0x02;
export const FRAME_TAG_TAP = 0x03;

/** A single decoded frame. `payload` is a detached copy, safe to retain. */
export interface Frame {
  tag: number;
  payload: Buffer;
}

export interface FrameParser {
  /**
   * Feed a raw stdout chunk. Returns every complete frame decodable so far and
   * buffers any partial remainder for the next push. A chunk that splits a
   * frame mid-payload yields nothing until the rest arrives.
   */
  push(chunk: Buffer): Frame[];
}

/** Create a stateful demuxer for the length-prefixed sidecar frame protocol. */
export function createFrameParser(): FrameParser {
  let buffer: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Buffer): Frame[] {
      buffer =
        buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      const frames: Frame[] = [];
      while (buffer.length >= 5) {
        const tag = buffer[0]!;
        const len = buffer.readUInt32BE(1);
        if (buffer.length < 5 + len) break;
        // Copy the payload so it's detached from the growing buffer below.
        const payload = Buffer.from(buffer.subarray(5, 5 + len));
        buffer = buffer.subarray(5 + len);
        frames.push({ tag, payload });
      }
      return frames;
    },
  };
}
