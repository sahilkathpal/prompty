// Unit: call-log title derivation + slug + summary patching (call-log.ts).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deriveCallTitle,
  slugify,
  writeCallLog,
  updateCallLogSummary,
} from "../../src/main-process/call-log";

describe("deriveCallTitle", () => {
  it("prefers an explicit title over summary and direction", () => {
    expect(deriveCallTitle("Explicit", "FromSummary", "from direction")).toBe("Explicit");
  });

  it("falls back to the summary title when no explicit title", () => {
    expect(deriveCallTitle(undefined, "FromSummary", "from direction")).toBe("FromSummary");
    expect(deriveCallTitle("   ", "FromSummary", "x")).toBe("FromSummary");
  });

  it("falls back to the first line/sentence of the direction", () => {
    expect(deriveCallTitle(undefined, undefined, "Probe their pain. Then pitch.")).toBe(
      "Probe their pain",
    );
    expect(deriveCallTitle(undefined, undefined, "line one\nline two")).toBe("line one");
  });

  it("truncates a long direction-derived title to ~60 chars with an ellipsis", () => {
    const long = "a".repeat(80);
    const out = deriveCallTitle(undefined, undefined, long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(58); // 57 chars + ellipsis
  });

  it("returns '' when nothing is known", () => {
    expect(deriveCallTitle(undefined, undefined, undefined)).toBe("");
    expect(deriveCallTitle("", "", "")).toBe("");
  });
});

describe("slugify", () => {
  it("lowercases, collapses non-alphanumerics to single dashes, trims", () => {
    expect(slugify("Hello, World!")).toBe("hello-world");
    expect(slugify("  --Trim Me--  ")).toBe("trim-me");
  });

  it("caps length at 40 chars and never ends on a dash", () => {
    const out = slugify("word ".repeat(20));
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("-")).toBe(false);
  });

  it("falls back to 'call' for an empty/symbol-only title", () => {
    expect(slugify("")).toBe("call");
    expect(slugify("!!!")).toBe("call");
  });
});

describe("writeCallLog + updateCallLogSummary", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompty-calllog-"));
    process.env.PROMPTY_CALL_LOG_DIR = dir;
  });
  afterEach(() => {
    delete process.env.PROMPTY_CALL_LOG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a log file named from the title slug", async () => {
    const p = await writeCallLog({
      direction: "Discovery with Acme",
      title: "Discovery with Acme",
      transcript: [],
      nudges: [],
      startedAt: 1,
      endedAt: 2,
    });
    expect(fs.existsSync(p)).toBe(true);
    expect(path.basename(p)).toContain("discovery-with-acme");
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(parsed.direction).toBe("Discovery with Acme");
  });

  it("upgrades an auto-derived title to the summary title, clears summaryPending", async () => {
    const p = await writeCallLog({
      direction: "Talk to Dana about Kafka",
      title: deriveCallTitle(undefined, undefined, "Talk to Dana about Kafka"),
      transcript: [],
      nudges: [],
      startedAt: 1,
      endedAt: 2,
      summaryPending: true,
    });
    updateCallLogSummary(p, {
      title: "Dana — managed Kafka",
      recap: "Discussed scale.",
      insights: [],
    });
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(parsed.title).toBe("Dana — managed Kafka");
    expect(parsed.summaryPending).toBe(false);
    expect(parsed.summary.recap).toBe("Discussed scale.");
  });

  it("preserves a user-renamed title even after the summary lands", async () => {
    const p = await writeCallLog({
      direction: "Talk to Dana",
      title: "My Custom Name",
      transcript: [],
      nudges: [],
      startedAt: 1,
      endedAt: 2,
      summaryPending: true,
    });
    updateCallLogSummary(p, {
      title: "Auto Summary Title",
      recap: "x",
      insights: [],
    });
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(parsed.title).toBe("My Custom Name");
  });

  it("is a no-op on a missing file (never throws)", () => {
    expect(() =>
      updateCallLogSummary(path.join(dir, "does-not-exist.json"), undefined),
    ).not.toThrow();
  });
});
