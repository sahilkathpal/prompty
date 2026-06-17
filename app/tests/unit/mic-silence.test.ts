// Unit: mic digital-silence detector (mic-silence.ts).

import { describe, it, expect } from "vitest";
import { createMicSilenceDetector } from "../../src/main-process/mic-silence";

describe("createMicSilenceDetector", () => {
  it("fires exactly once when the all-zero run crosses the threshold", () => {
    const d = createMicSilenceDetector(8); // small threshold for the test
    expect(d.inspect(Buffer.alloc(4))).toBe(false); // 4 zero bytes
    expect(d.isSilent()).toBe(false);
    expect(d.inspect(Buffer.alloc(4))).toBe(true); // crosses 8 → fires
    expect(d.isSilent()).toBe(true);
    expect(d.inspect(Buffer.alloc(4))).toBe(false); // sticky, never fires again
  });

  it("latches healthy the moment any non-zero sample appears", () => {
    const d = createMicSilenceDetector(8);
    expect(d.inspect(Buffer.from([0, 0, 1, 0]))).toBe(false);
    expect(d.isSilent()).toBe(false);
    // Even a long zero run afterwards must not flip it to silent.
    expect(d.inspect(Buffer.alloc(1000))).toBe(false);
    expect(d.isSilent()).toBe(false);
  });
});
