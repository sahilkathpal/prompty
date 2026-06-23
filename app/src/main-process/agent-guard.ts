// Central tool-permission policy for EVERY Claude Agent SDK query in this app.
//
// Security invariant (RUBY security audit, finding #2): no agent that ever sees
// untrusted content — the call transcript, calendar/email text, attendee-supplied
// strings, stored memory — may reach a filesystem/shell tool. The remote party on
// a call is an untrusted input source, so a prompt injection in the transcript
// must not be able to drive a Bash/Read/Write call. We enforce that two ways at
// once, so neither is a single point of failure:
//
//   1. `tools: []` removes the claude_code built-in preset (Bash/Read/Write/…),
//      so dangerous tools are never even registered with the model.
//   2. A deny-by-default `canUseTool` gate under `permissionMode: "default"`:
//      only the explicitly-listed MCP tool names are allowed; every other tool
//      is denied (and logged). This is the REAL gate — it still holds if a
//      future change reintroduces a built-in tool, where (1) alone would
//      silently fail open.
//
// Previously every agent ran `permissionMode: "bypassPermissions"`, which skips
// canUseTool entirely — making the *absence* of tools the only protection. This
// helper flips that: the *allowlist* is the protection. Built-ins removed AND
// gated; the allowlisted MCP tools run without an interactive prompt because they
// are both in `allowedTools` and accepted by the gate.
//
// Keep ALL agents on this helper. The unit test in tests/unit/agent-guard.test.ts
// asserts the deny-by-default behavior; treat "every query() spreads toolPolicy"
// as a hard rule.

/** Subset of the SDK's PermissionResult we ever return (structurally assignable). */
type GuardDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/**
 * The hardened tool-policy fields to spread into a query's `options`.
 * Structurally matches the SDK Options (tools / allowedTools / permissionMode /
 * canUseTool) so it can be spread directly: `options: { model, ...toolPolicy([…]) }`.
 */
export interface ToolPolicy {
  tools: string[];
  allowedTools: string[];
  permissionMode: "default";
  canUseTool: (toolName: string, input: Record<string, unknown>) => Promise<GuardDecision>;
}

/**
 * Build the hardened tool-policy options for an agent query.
 *
 * @param allowedTools fully-qualified MCP tool names this agent may call, e.g.
 *   "mcp__prompty-nudges__emit_nudge". Pass nothing for a no-tool agent (the
 *   one-shot answer/summary roles) — then the gate denies everything.
 */
export function toolPolicy(allowedTools: string[] = []): ToolPolicy {
  const allow = new Set(allowedTools);
  return {
    // (1) Strip the claude_code built-in preset entirely.
    tools: [],
    // Pre-allow our own MCP tools so they run without a permission prompt.
    allowedTools,
    // (2) Consult canUseTool (bypassPermissions would skip it) and deny by default.
    permissionMode: "default",
    canUseTool: async (toolName, input) => {
      if (allow.has(toolName)) {
        return { behavior: "allow", updatedInput: input };
      }
      // With tools:[] this is unreachable in normal operation — so if it ever
      // fires, something tried to use a tool outside the allowlist (e.g. a
      // reintroduced built-in, or an injection-driven tool call). Log loudly.
      console.warn(
        `[agent-guard] DENIED tool "${toolName}" — not in allowlist [${allowedTools.join(", ") || "(none)"}]`,
      );
      return {
        behavior: "deny",
        message: `Tool "${toolName}" is not permitted for this agent.`,
      };
    },
  };
}
