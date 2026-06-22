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
  it("leads with the takeaway, keeps an evidence quote, and drops `via` on unassisted", () => {
    const out = sanitize({
      recap: "R",
      insights: [
        {
          takeaway: "Renewal timing is the lever",
          quote: "Our contract's up in March.",
          assisted: true,
          via: "after Ruby flagged the renewal date",
        },
        { takeaway: "Reporting is a hard gate", assisted: false, via: "should be dropped" },
        { takeaway: "   ", assisted: false, via: "" }, // empty takeaway dropped
      ],
    });
    expect(out!.insights).toHaveLength(2);
    expect(out!.insights[0]).toEqual({
      takeaway: "Renewal timing is the lever",
      quote: "Our contract's up in March.",
      assisted: true,
      via: "after Ruby flagged the renewal date",
    });
    // Unassisted: no `quote` key at all, empty `via`.
    expect(out!.insights[1]).toEqual({ takeaway: "Reporting is a hard gate", assisted: false, via: "" });
  });

  it("omits the quote field when it's empty/whitespace", () => {
    const out = sanitize({
      recap: "R",
      insights: [{ takeaway: "T", quote: "   ", assisted: false, via: "" }],
    });
    expect(out!.insights[0]).not.toHaveProperty("quote");
  });

  it("back-fills `takeaway` from a legacy `text` field", () => {
    const out = sanitize({
      recap: "R",
      insights: [{ text: "legacy insight body", assisted: false, via: "" }],
    });
    expect(out!.insights[0].takeaway).toBe("legacy insight body");
  });

  it("returns null when recap is missing (malformed payload)", () => {
    expect(sanitize({ insights: [] })).toBeNull();
  });

  it("strips wrapping quotes from the title", () => {
    const out = sanitize({ title: '"Quoted"', recap: "R" });
    expect(out!.title).toBe("Quoted");
  });
});
