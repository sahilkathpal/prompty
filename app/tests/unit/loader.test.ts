// Unit: prompt-fragment loader (prompts/loader.ts). Resolves bundled base.md +
// skill fragments from the source tree (via __dirname), with no default
// fallback and no throw on unknown skills.

import { describe, it, expect } from "vitest";
import {
  loadBase,
  loadSkillFragment,
  listAvailableSkills,
} from "../../src/main-process/prompts/loader";

describe("prompt loader", () => {
  it("loadBase returns the non-empty invariant core", () => {
    const base = loadBase();
    expect(base.length).toBeGreaterThan(0);
    expect(base).toContain("real-time call coach");
  });

  it("loadSkillFragment returns content for a known skill", () => {
    expect(loadSkillFragment("user-interview", "in-call").trim().length).toBeGreaterThan(0);
  });

  it("loadSkillFragment returns '' for empty or unknown skills (no fallback, no throw)", () => {
    expect(loadSkillFragment("", "in-call")).toBe("");
    expect(loadSkillFragment("no-such-skill", "in-call")).toBe("");
  });

  it("listAvailableSkills finds the three bundled skills and no 'default'", () => {
    const names = listAvailableSkills().map((s) => s.name).sort();
    for (const s of ["discovery", "hiring", "user-interview"]) {
      expect(names).toContain(s);
    }
    expect(names).not.toContain("default");
  });
});
