// Unit: post-call summary parsing/sanitisation (summary.ts). The model does the
// attribution; OUR job is to extract the JSON and clamp it into a shape the
// renderer can trust — so that's what we test (extractJson, sanitize, fmtTime).

import { describe, it, expect } from "vitest";
import { extractJson, sanitize, fmtTime } from "../../src/main-process/summary";

describe("extractJson", () => {
  it("pulls JSON out of a fenced ```json block", () => {
    const out = extractJson('prose\n```json\n{"a":1}\n```\ntrailing');
    expect(out).toBe('{"a":1}');
  });
  it("falls back to the first bare {...} object", () => {
    expect(extractJson('noise {"a":1} more')).toBe('{"a":1}');
  });
  it("returns null when there is no JSON", () => {
    expect(extractJson("just prose")).toBeNull();
  });
});

describe("fmtTime", () => {
  it("renders mm:ss relative to the call start, clamped at 0", () => {
    const start = 1_000_000;
    expect(fmtTime(start, start)).toBe("0:00");
    expect(fmtTime(start + 65_000, start)).toBe("1:05");
    expect(fmtTime(start - 5_000, start)).toBe("0:00"); // negative clamped
  });
});

describe("sanitize", () => {
  it("clamps `used` into [0, surfaced] and trusts the real surfaced count", () => {
    const out = sanitize(
      { title: "T", recap: "R", insights: [], questionsNotAsked: [], stat: { surfaced: 99, used: 50 } },
      3,
    );
    expect(out).not.toBeNull();
    expect(out!.stat.surfaced).toBe(3);
    expect(out!.stat.used).toBe(3); // 50 clamped down to surfaced=3
  });

  it("drops the `via` clause on unassisted insights and keeps it on assisted ones", () => {
    const out = sanitize(
      {
        recap: "R",
        insights: [
          { text: "assisted one", assisted: true, via: "after Ruby's nudge" },
          { text: "plain one", assisted: false, via: "should be dropped" },
          { text: "   ", assisted: false, via: "" }, // empty text dropped
        ],
        questionsNotAsked: [{ text: "unasked" }, { text: "  " }],
        stat: { used: 1 },
      },
      2,
    );
    expect(out!.insights).toHaveLength(2);
    expect(out!.insights[0]).toEqual({ text: "assisted one", assisted: true, via: "after Ruby's nudge" });
    expect(out!.insights[1]).toEqual({ text: "plain one", assisted: false, via: "" });
    expect(out!.questionsNotAsked).toEqual([{ text: "unasked" }]);
  });

  it("returns null when recap is missing (malformed payload)", () => {
    expect(sanitize({ insights: [] }, 0)).toBeNull();
  });

  it("strips wrapping quotes from the title", () => {
    const out = sanitize({ title: '"Quoted"', recap: "R" }, 0);
    expect(out!.title).toBe("Quoted");
  });
});
