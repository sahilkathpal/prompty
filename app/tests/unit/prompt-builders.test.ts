// Unit: the pure prompt builders for the hotkey one-shot (answer.ts) and the
// background running summary (running-summary.ts), plus answer.ts's cleanLine.

import { describe, it, expect } from "vitest";
import { buildPrompt as buildAnswerPrompt, cleanLine } from "../../src/main-process/answer";
import { buildPrompt as buildSummaryPrompt } from "../../src/main-process/running-summary";
import type { CallSetup, TranscriptUtterance } from "../../src/shared/types";

const utt = (speaker: "me" | "them", text: string): TranscriptUtterance => ({
  speaker,
  text,
  startMs: 0,
  endMs: 1000,
  isFinal: true,
});

describe("answer.buildPrompt", () => {
  const setup: CallSetup = { direction: "Probe Kafka pain" };

  it("renders direction, transcript, recent nudges, and the memory section", () => {
    const p = buildAnswerPrompt({
      setup: {
        ...setup,
        memories: [{ id: "m", text: "Be terse", createdAt: 0, source: "manual" }],
      },
      summary: "We covered scale.",
      recent: [utt("me", "How big is the team?"), utt("them", "Five engineers.")],
      recentNudges: ["Ask about on-call"],
    });
    expect(p).toContain("Probe Kafka pain");
    expect(p).toContain("[me] How big is the team?");
    expect(p).toContain("[them] Five engineers.");
    expect(p).toContain("We covered scale.");
    expect(p).toContain("- Ask about on-call");
    expect(p).toContain("Be terse"); // memory injected
  });

  it("uses placeholders for empty transcript / summary / nudges", () => {
    const p = buildAnswerPrompt({ setup, summary: "", recent: [], recentNudges: [] });
    expect(p).toContain("(nothing said yet)");
    expect(p).toContain("(call just started)");
    expect(p).toContain("(none yet)");
  });

  it("omits the memory section when there are no memories", () => {
    const p = buildAnswerPrompt({ setup, summary: "", recent: [], recentNudges: [] });
    expect(p).not.toContain("standing preferences");
  });
});

describe("answer.cleanLine", () => {
  it("returns the first non-empty line", () => {
    expect(cleanLine("\n\nWhat changed?\nsecond line")).toBe("What changed?");
  });
  it("strips surrounding quotes and leading bullets", () => {
    expect(cleanLine('"What did you try before?"')).toBe("What did you try before?");
    expect(cleanLine("- Ask about budget")).toBe("Ask about budget");
    expect(cleanLine("• Ask about budget")).toBe("Ask about budget");
  });
  it("returns '' for empty input", () => {
    expect(cleanLine("")).toBe("");
    expect(cleanLine("   \n  ")).toBe("");
  });
});

describe("running-summary.buildPrompt", () => {
  it("includes the direction section only when a direction is set", () => {
    const withDir = buildSummaryPrompt({ direction: "Qualify fit" }, [
      utt("them", "We're scaling fast."),
    ]);
    expect(withDir).toContain("## Direction");
    expect(withDir).toContain("Qualify fit");
    expect(withDir).toContain("[them] We're scaling fast.");

    const noDir = buildSummaryPrompt({}, [utt("me", "Hi")]);
    expect(noDir).not.toContain("## Direction");
    expect(noDir).toContain("[me] Hi");
  });
});
