// Unit: the central agent tool-permission policy (agent-guard.ts).
//
// This is a SECURITY invariant test (audit findings #1/#2). Every Claude Agent
// SDK query in the app spreads toolPolicy() into its options. These tests pin the
// two protections so a future refactor can't silently weaken them:
//   1. tools:[] is always present (removes the claude_code built-in preset).
//   2. permissionMode is "default" (NOT bypassPermissions — bypass would skip the
//      gate), and the canUseTool gate denies by default.

import { describe, it, expect } from "vitest";
import { toolPolicy } from "../../src/main-process/agent-guard";

describe("toolPolicy", () => {
  it("always strips built-in tools and runs under the gate, not bypass", () => {
    const p = toolPolicy(["mcp__prompty-nudges__emit_nudge"]);
    expect(p.tools).toEqual([]);
    // The gate only runs when we are NOT bypassing permissions.
    expect(p.permissionMode).toBe("default");
    expect(typeof p.canUseTool).toBe("function");
  });

  it("allows a tool that is on the allowlist (and passes input through)", async () => {
    const p = toolPolicy(["mcp__prompty-prep__write_memory"]);
    const decision = await p.canUseTool("mcp__prompty-prep__write_memory", { text: "hi" });
    expect(decision.behavior).toBe("allow");
    if (decision.behavior === "allow") {
      expect(decision.updatedInput).toEqual({ text: "hi" });
    }
  });

  it("denies any tool not on the allowlist (built-ins included)", async () => {
    const p = toolPolicy(["mcp__prompty-nudges__emit_nudge"]);
    for (const tool of ["Bash", "Read", "Write", "mcp__prompty-prep__write_memory"]) {
      const decision = await p.canUseTool(tool, {});
      expect(decision.behavior).toBe("deny");
    }
  });

  it("denies EVERYTHING for a no-tool agent (answer / summary roles)", async () => {
    const p = toolPolicy();
    expect(p.allowedTools).toEqual([]);
    const decision = await p.canUseTool("Bash", { command: "rm -rf /" });
    expect(decision.behavior).toBe("deny");
  });
});
