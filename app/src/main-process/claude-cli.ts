import { execSync, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  statSync,
  realpathSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

let cached: string | undefined;
let cachedLoginPath: string | undefined;
let pathRepaired = false;

/**
 * Recovers the PATH the user sees in their terminal by running their login
 * shell once.
 *
 * A macOS app launched from Finder/Dock does NOT inherit the shell PATH — it
 * gets a stunted `/usr/bin:/bin:/usr/sbin:/sbin`-ish PATH with no Homebrew,
 * `~/.local/bin`, nvm/fnm/volta/bun, or any custom prefix. That's the real
 * reason `claude` (and the `node` an npm-installed `claude` needs) can't be
 * found — not the install location. This is the well-known Electron problem
 * that `fix-path` / `shell-env` solve.
 *
 * We parse `env` output (KEY=VALUE) rather than `$PATH` so it works regardless
 * of the shell (bash / zsh / fish format PATH differently). Cached; best-effort
 * — returns null if the probe fails, leaving the inherited PATH untouched.
 */
function loginShellPath(): string | null {
  if (cachedLoginPath !== undefined) return cachedLoginPath || null;
  cachedLoginPath = "";
  if (process.platform === "win32") return null;
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const D = "__PROMPTY_ENV__";
    const out = execSync(`${shell} -lic 'echo ${D}; env; echo ${D}'`, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const between = out.split(D)[1] ?? "";
    const line = between.split("\n").find((l) => l.startsWith("PATH="));
    if (line) cachedLoginPath = line.slice("PATH=".length).trim();
  } catch {
    // Best-effort; fall back to the inherited PATH.
  }
  return cachedLoginPath || null;
}

/**
 * Merges the login-shell PATH into `process.env.PATH` once, so every downstream
 * lookup — `which`, the SDK-spawned `claude`, and the `node` it may shell out
 * to — sees the user's real PATH. Idempotent and safe to call eagerly.
 */
export function repairProcessPath(): void {
  if (pathRepaired) return;
  pathRepaired = true;
  const recovered = loginShellPath();
  if (!recovered) return;
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...recovered.split(":"), ...(process.env.PATH || "").split(":")]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  process.env.PATH = merged.join(":");
}

/**
 * A neutral, app-owned working directory for the spawned `claude` CLI.
 *
 * Pinning the agent's cwd here keeps the CLI's startup workspace probing out of
 * the user's TCC-protected folders (Desktop / Downloads / Documents / iCloud).
 * Without it the CLI inherits `process.cwd()` — for a Finder-launched app that's
 * `/` or the user's home — and its directory scan trips the macOS "Ruby wants
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
  // Repair PATH before spawning so the CLI (and any `node` it needs) is found.
  repairProcessPath();
  if (process.env.CLAUDE_CLI_PATH) {
    // The env override is NOT exempt from the trust check (audit finding #3) —
    // it's the easiest hijack vector if an attacker can influence the launch env.
    assertTrustedCli(process.env.CLAUDE_CLI_PATH);
    cached = process.env.CLAUDE_CLI_PATH;
    return cached;
  }
  const found = findClaudeBinary();
  if (!found) {
    throw new Error(
      "`claude` CLI not found. Install Claude Code or set CLAUDE_CLI_PATH.",
    );
  }
  assertTrustedCli(found);
  cached = found;
  return cached;
}

/**
 * Trust check run before we hand a path to the SDK to spawn (audit finding #3).
 *
 * The resolved `claude` binary runs as our agent — a hijacked one would see every
 * prompt and transcript and execute with the user's privileges. We can't defend
 * against malware already running as this user (it could patch the app itself),
 * but we refuse the clearly-illegitimate cases and leave an audit trail:
 *
 *   - HARD FAIL if the binary file itself is world-writable — no legitimate
 *     install is, and it means any local process can overwrite the executable.
 *   - WARN if the containing directory is world-writable (don't block: sticky
 *     temp dirs like /tmp are world-writable yet routinely used), and if a
 *     Mach-O binary doesn't pass code-signature verification (don't block:
 *     npm-installed `claude` is a script launcher, not a signed Mach-O).
 *   - Always log the resolved real path so a binary swap is visible in logs.
 */
function assertTrustedCli(path: string): void {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // realpath can fail (e.g. broken symlink); existsSync upstream already gated
    // discovered paths, so fall back to the given path.
  }

  try {
    const fileMode = statSync(real).mode & 0o777;
    if (fileMode & 0o002) {
      throw new Error(
        `Refusing to launch the claude CLI: "${real}" is world-writable ` +
          `(mode ${fileMode.toString(8)}). Any local process could replace it. ` +
          `Fix its permissions, or set CLAUDE_CLI_PATH to a trusted install.`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Refusing to launch")) throw e;
    // stat failed for another reason — leave the spawn to surface a clear error.
  }

  try {
    const dirMode = statSync(dirname(real)).mode & 0o777;
    if (dirMode & 0o002) {
      console.warn(
        `[claude-cli] resolved binary lives in a world-writable directory ` +
          `(${dirname(real)}, mode ${dirMode.toString(8)}) — verify it is the genuine CLI.`,
      );
    }
  } catch {
    // best-effort
  }

  auditCliSignature(real);
  console.log(`[claude-cli] using ${real}`);
}

/**
 * Best-effort code-signature audit. If the resolved file is a Mach-O binary,
 * verify its signature and warn (never block) on failure. Script launchers
 * (npm installs) aren't Mach-O, so they're skipped silently.
 */
function auditCliSignature(real: string): void {
  try {
    const buf = Buffer.alloc(4);
    const fd = openSync(real, "r");
    try {
      readSync(fd, buf, 0, 4, 0);
    } finally {
      closeSync(fd);
    }
    const magic = buf.readUInt32BE(0);
    // Mach-O thin (feedface/feedfacf) and fat (cafebabe) magics, both byte orders.
    const machO = new Set([
      0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe, 0xbebafeca,
    ]);
    if (!machO.has(magic)) return; // script / non-Mach-O — nothing to verify
    execFileSync("codesign", ["--verify", "--strict", real], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 5000,
    });
  } catch (e) {
    console.warn(
      `[claude-cli] code-signature check did not pass for the resolved binary — ` +
        `proceeding, but confirm this is the genuine claude CLI: ${(e as Error).message}`,
    );
  }
}

/**
 * Locates the user's `claude` binary.
 *
 * Fast path: a few well-known install locations, checked without spawning a
 * subprocess. These are an optimization, NOT the mechanism — they only cover
 * the common cases.
 *
 * Robust path: scan the user's real login-shell PATH (see {@link loginShellPath}).
 * This finds `claude` wherever it actually lives — Homebrew, the native
 * installer's `~/.local/bin`, npm global, nvm/fnm/volta/bun, a custom prefix —
 * without assuming the location, which is the only reliable approach for a
 * Finder/Dock-launched app whose inherited PATH is stunted.
 *
 * Returns the first existing executable path, or null if none found.
 * Onboarding (Block F) calls this on first launch to decide whether to bail
 * to an "install Claude Code" screen.
 */
export function findClaudeBinary(): string | null {
  // Fast path — instant, covers the common installs.
  const fast = [
    join(homedir(), ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(homedir(), ".claude/local/claude"),
  ];
  for (const path of fast) {
    if (existsSync(path)) return path;
  }
  // Robust path — resolve through the user's actual PATH.
  const loginPath = loginShellPath();
  if (loginPath) {
    for (const dir of loginPath.split(":")) {
      if (!dir) continue;
      const candidate = join(dir, "claude");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
