import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let cached: string | undefined;

/**
 * A neutral, app-owned working directory for the spawned `claude` CLI.
 *
 * Pinning the agent's cwd here keeps the CLI's startup workspace probing out of
 * the user's TCC-protected folders (Desktop / Downloads / Documents / iCloud).
 * Without it the CLI inherits `process.cwd()` — for a Finder-launched app that's
 * `/` or the user's home — and its directory scan trips the macOS "Prompty wants
 * to access your Desktop/Downloads/…" prompts. `~/.prompty` is a plain home
 * dotfolder, not a protected location, so nothing prompts. Kept dependency-free
 * (no electron `app`) so it works in the headless smoke tests too.
 */
export function agentCwd(): string {
  const dir = join(homedir(), ".prompty", "agent");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort; if creation fails the CLI still starts from this path.
  }
  return dir;
}

/**
 * Resolves the path to the user's installed `claude` CLI binary, throwing if
 * none is found. Preserves the original server behavior (used by agent.ts).
 */
export function resolveClaudeCli(): string {
  if (cached) return cached;
  if (process.env.CLAUDE_CLI_PATH) {
    cached = process.env.CLAUDE_CLI_PATH;
    return cached;
  }
  const found = findClaudeBinary();
  if (!found) {
    throw new Error(
      "`claude` CLI not found. Install Claude Code or set CLAUDE_CLI_PATH.",
    );
  }
  cached = found;
  return cached;
}

/**
 * Probes well-known locations for the user's `claude` binary, in order:
 *   1. /usr/local/bin/claude
 *   2. ~/.claude/local/claude
 *   3. /opt/homebrew/bin/claude
 *   4. `which claude` from a shell
 *
 * Returns the first existing executable path, or null if none found.
 * Onboarding (Block F) calls this on first launch to decide whether to bail
 * to an "install Claude Code" screen.
 */
export function findClaudeBinary(): string | null {
  const candidates = [
    "/usr/local/bin/claude",
    join(homedir(), ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  try {
    const out = execSync("which claude", { encoding: "utf8" }).trim();
    if (out && existsSync(out)) return out;
  } catch {
    // ignore
  }
  return null;
}
