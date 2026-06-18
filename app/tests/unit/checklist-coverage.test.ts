// Unit: checklistStateBlock — the live per-turn coverage block fed into each
// consider() turn (agent.ts). This is what closes the loop: the static system
// prompt freezes the checklist at session start, so the agent only sees ticks
// land through this block, rebuilt from setup.components every turn.

import { describe, it, expect } from "vitest";
import { checklistStateBlock } from "../../src/main-process/agent";
import type { CallSetup } from "../../src/shared/types";

const withChecklist = (done: boolean[]): CallSetup => ({
  direction: "x",
  components: [
    {
      type: "checklist",
      id: "cl",
      items: done.map((d, i) => ({ id: `id-${i}`, text: `Item ${i}`, done: d })),
    },
  ],
});

describe("checklistStateBlock", () => {
  it("returns empty string when there's no checklist", () => {
    expect(checklistStateBlock({ direction: "x" })).toBe("");
    expect(checklistStateBlock({ direction: "x", components: [{ type: "goal", id: "g", text: "win" }] })).toBe("");
  });

  it("renders open/covered marks, item ids, and an open count", () => {
    const block = checklistStateBlock(withChecklist([false, true, false]));
    expect(block).toContain("2 still open");
    expect(block).toContain("- [ ] Item 0 (id: id-0)");
    expect(block).toContain("- [x] Item 1 (id: id-1)");
    expect(block).toContain("- [ ] Item 2 (id: id-2)");
    // Ids must be present so mark_covered can target the right item.
    expect(block).toContain("mark_covered");
  });

  it("reflects a tick landing in place (the closed-loop case)", () => {
    const setup = withChecklist([false, false]);
    expect(checklistStateBlock(setup)).toContain("2 still open");
    // mark_covered mutates setup.components items in place; the next turn's block
    // must reflect it without rebuilding setup.
    const checklist = setup.components![0];
    if (checklist.type === "checklist") checklist.items[0].done = true;
    const after = checklistStateBlock(setup);
    expect(after).toContain("1 still open");
    expect(after).toContain("- [x] Item 0 (id: id-0)");
  });

  it("shows 0 still open when everything is covered", () => {
    expect(checklistStateBlock(withChecklist([true, true]))).toContain("0 still open");
  });
});
