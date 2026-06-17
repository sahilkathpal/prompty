// Unit: per-role model selection with env overrides (models.ts).

import { describe, it, expect, afterEach } from "vitest";
import { modelFor } from "../../src/main-process/models";

afterEach(() => {
  delete process.env.PROMPTY_MODEL_NUDGE;
  delete process.env.PROMPTY_MODEL_SUMMARY;
});

describe("modelFor", () => {
  it("returns the default model for each role", () => {
    expect(modelFor("nudge")).toBe("claude-sonnet-4-6");
    expect(modelFor("hotkey")).toBe("claude-sonnet-4-6");
    expect(modelFor("summary")).toBe("claude-haiku-4-5");
    expect(modelFor("recap")).toBe("claude-sonnet-4-6");
  });

  it("honours the per-role env override", () => {
    process.env.PROMPTY_MODEL_NUDGE = "claude-opus-4-8";
    expect(modelFor("nudge")).toBe("claude-opus-4-8");
  });

  it("ignores a blank/whitespace override", () => {
    process.env.PROMPTY_MODEL_SUMMARY = "   ";
    expect(modelFor("summary")).toBe("claude-haiku-4-5");
  });
});
