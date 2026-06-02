import { execSync } from "node:child_process";

/**
 * Resolves the path to the user's installed `claude` CLI binary.
 *
 * Why this matters: the Agent SDK ships a bundled `cli.js` inside
 * node_modules/@anthropic-ai/claude-agent-sdk/ and spawns THAT by default.
 * The bundled CLI does not share the user's Claude.ai OAuth session, which
 * means:
 *   - User-level MCP servers (Calendar, Attio, etc.) are unreachable.
 *   - Subscription auth may not be picked up the way the installed CLI does.
 *
 * Passing the installed binary's path to `pathToClaudeCodeExecutable` fixes
 * both. Caches the result so we don't re-shell out each call.
 */
let cached: string | undefined;

export function resolveClaudeCli(): string {
  if (cached) return cached;
  if (process.env.CLAUDE_CLI_PATH) {
    cached = process.env.CLAUDE_CLI_PATH;
    return cached;
  }
  try {
    cached = execSync("which claude", { encoding: "utf8" }).trim();
    if (!cached) throw new Error("empty");
    return cached;
  } catch {
    throw new Error(
      "`claude` CLI not found in PATH. Install Claude Code or set CLAUDE_CLI_PATH.",
    );
  }
}
