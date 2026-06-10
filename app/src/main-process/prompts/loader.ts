// Prompt loaders shared by the in-call (system.ts) and prep (prep-system.ts)
// prompts.
//
// Layout on disk (bundled beside this file; mirrored under ~/.prompty for
// per-fragment user overrides):
//
//   prompts/
//     base.md                      invariant in-call core
//     modes/
//       <mode>/in-call.md          thin per-mode flavor (addendum to base)
//       <mode>/prep.md             per-mode guidance for the prep interviewer
//
// A "mode" is a folder. Fragments resolve user-override → bundled → bundled
// `default/`. There is intentionally no legacy flat-file support.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUNDLED_PROMPTS_DIR = __dirname;
const BUNDLED_MODES_DIR = join(BUNDLED_PROMPTS_DIR, "modes");
const USER_PROMPTS_DIR = join(homedir(), ".prompty");
const USER_MODES_DIR = join(USER_PROMPTS_DIR, "modes");

export const DEFAULT_MODE = "default";

export type Fragment = "in-call" | "prep";

/** Read the invariant in-call core. User override wins; otherwise bundled. */
export function loadBase(): string {
  for (const path of [
    join(USER_PROMPTS_DIR, "base.md"),
    join(BUNDLED_PROMPTS_DIR, "base.md"),
  ]) {
    const text = tryRead(path);
    if (text != null) return text;
  }
  throw new Error("no base.md prompt found (bundled or user)");
}

/**
 * Read a mode's fragment, resolving:
 *   1. ~/.prompty/modes/<mode>/<fragment>.md   (user override)
 *   2. <bundled>/modes/<mode>/<fragment>.md     (bundled)
 *   3. <bundled>/modes/default/<fragment>.md    (bundled default fallback)
 *
 * `in-call` is required — throws if nothing resolves (a correct build always
 * ships modes/default/in-call.md). `prep` is optional — returns "" so a mode
 * without prep guidance simply runs a generic, non-mode-aware prep.
 */
export function loadModeFragment(mode: string, fragment: Fragment): string {
  const m = (mode || DEFAULT_MODE).trim() || DEFAULT_MODE;
  for (const path of [
    join(USER_MODES_DIR, m, `${fragment}.md`),
    join(BUNDLED_MODES_DIR, m, `${fragment}.md`),
    join(BUNDLED_MODES_DIR, DEFAULT_MODE, `${fragment}.md`),
  ]) {
    const text = tryRead(path);
    if (text != null) return text;
  }
  if (fragment === "prep") return "";
  throw new Error(`no in-call fragment found for mode "${mode}" (or default)`);
}

/** List available modes (a mode = a folder under bundled or user modes dir). */
export function listAvailableModes(): { name: string; source: "user" | "bundled" }[] {
  const out = new Map<string, "user" | "bundled">();
  for (const name of subdirs(BUNDLED_MODES_DIR)) out.set(name, "bundled");
  for (const name of subdirs(USER_MODES_DIR)) out.set(name, "user");
  return [...out].map(([name, source]) => ({ name, source }));
}

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
