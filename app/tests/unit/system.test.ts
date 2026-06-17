// Unit: in-call system-prompt assembly (prompts/system.ts). Pure slot-filler —
// every optional section is rendered only when present, in priority order, with
// no "(none)" placeholders. Ports + expands the old smoke-system-prompt.ts.

import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/main-process/prompts/system";
import type { CallSetup } from "../../src/shared/types";

describe("buildSystemPrompt", () => {
  it("bare setup renders base only — no optional sections, no placeholders", () => {
    const p = buildSystemPrompt({});
    expect(p).not.toContain("{{");
    expect(p).not.toContain("## Direction\n");
    expect(p).not.toContain("## Goal\n");
    expect(p).not.toContain("## Checklist\n");
    expect(p).not.toContain("## Playbook:");
    expect(p).toContain("real-time call coach");
  });

  it("renders direction + skill playbook, with Direction before the playbook", () => {
    const setup: CallSetup = {
      direction: "Explore their ingestion pain before pitching; qualify fit.",
      skill: "discovery",
    };
    const p = buildSystemPrompt(setup);
    expect(p).toContain("## Direction\n");
    expect(p).toContain("Explore their ingestion pain before pitching");
    expect(p).toContain("sales discovery"); // discovery playbook
    // The skill's frontmatter (title/description) must never leak into the prompt.
    expect(p).not.toContain("title:");
    expect(p).not.toContain("description:");
  });

  it("injects the memory block when memories are present, omits it otherwise", () => {
    const withMem = buildSystemPrompt({
      memories: [{ id: "m1", text: "I dislike chatter.", createdAt: 0, source: "manual" }],
    });
    expect(withMem).toContain("## What Ruby knows about you");
    expect(withMem).toContain("- I dislike chatter.");

    const noMem = buildSystemPrompt({ memories: [] });
    expect(noMem).not.toContain("## What Ruby knows about you");
  });

  it("renders Goal + Checklist sections only when those components exist", () => {
    const p = buildSystemPrompt({
      components: [
        { type: "goal", id: "g1", text: "Decide whether to run a pilot." },
        {
          type: "checklist",
          id: "c1",
          items: [
            { id: "i1", text: "Confirm budget", done: false },
            { id: "i2", text: "Confirm timeline", done: true },
          ],
        },
      ],
    });
    expect(p).toContain("## Goal\nDecide whether to run a pilot.");
    expect(p).toContain("## Checklist\n");
    expect(p).toContain("- [ ] Confirm budget (id: i1)");
    expect(p).toContain("- [x] Confirm timeline (id: i2)");
  });

  it("unknown skill appends no playbook and never throws", () => {
    const p = buildSystemPrompt({ skill: "no-such-skill" });
    expect(p).not.toContain("## Playbook:");
    expect(p).toContain("real-time call coach");
  });
});
