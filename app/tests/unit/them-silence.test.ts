// Unit: tap (them / system-audio) digital-silence detector (them-silence.ts).

import { describe, it, expect } from "vitest";
import { createThemSilenceDetector } from "../../src/main-process/them-silence";

describe("createThemSilenceDetector", () => {
  it("verdicts silent when the tap delivered enough frames but only zeros", () => {
    const d = createThemSilenceDetector(8); // small min-bytes for the test
    d.inspect(Buffer.alloc(4)); // 4 zero bytes — not yet enough
    expect(d.wasSilentAllCall()).toBe(false);
    d.inspect(Buffer.alloc(4)); // reaches 8 bytes, still all zero
    expect(d.wasSilentAllCall()).toBe(true);
  });

  it("latches healthy the moment any non-zero sample appears, forever", () => {
    const d = createThemSilenceDetector(8);
    d.inspect(Buffer.from([0, 0, 7, 0])); // one real sample
    // A long zero run afterwards must never flip the verdict back to silent.
    d.inspect(Buffer.alloc(1000));
    expect(d.wasSilentAllCall()).toBe(false);
  });

  it("does not verdict silent on a call too short to judge (below min-bytes)", () => {
    const d = createThemSilenceDetector(128); // ~ a few frames
    d.inspect(Buffer.alloc(4)); // only 4 zero bytes total — inconclusive
    expect(d.wasSilentAllCall()).toBe(false);
  });

  it("counts non-zero even when it arrives after a leading zero run", () => {
    const d = createThemSilenceDetector(8);
    d.inspect(Buffer.alloc(64)); // long silence first (capture warming up)
    d.inspect(Buffer.from([0, 0, 0, 3])); // then real audio
    expect(d.wasSilentAllCall()).toBe(false);
  });
});
