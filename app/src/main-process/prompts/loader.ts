// Prompt loaders shared by the in-call (system.ts) and prep (prep-system.ts)
// prompts.
//
// Layout on disk (bundled beside this file; mirrored under ~/.prompty for
// per-fragment user overrides):
//
//   prompts/
//     base.md                       invariant in-call core
//     skills/
//       <skill>/in-call.md          thin per-skill playbook (addendum to base)
//       <skill>/prep.md             per-skill guidance for the prep interviewer
//
// A "skill" is a folder. Skills are OPTIONAL enrichment: a call with no skill
// runs on base + direction alone. Fragments resolve user-override → bundled,
// with NO default fallback. There is intentionally no legacy flat-file support.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUNDLED_PROMPTS_DIR = __dirname;
const BUNDLED_SKILLS_DIR = join(BUNDLED_PROMPTS_DIR, "skills");
const USER_PROMPTS_DIR = join(homedir(), ".prompty");
const USER_SKILLS_DIR = join(USER_PROMPTS_DIR, "skills");

export type Fragment = "in-call" | "prep";

/**
 * Read the invariant in-call core.
 *
 * NOTE: the ~/.prompty user override is intentionally DISABLED while we finalise
 * the prompts — the repo is the single source of truth, so a stray
 * ~/.prompty/base.md can't silently shadow a repo edit. Re-enable by
 * uncommenting the USER_PROMPTS_DIR line below (and the matching one in
 * loadSkillFragment) when we want runtime overrides back.
 */
export function loadBase(): string {
  for (const path of [
    // join(USER_PROMPTS_DIR, "base.md"),
    join(BUNDLED_PROMPTS_DIR, "base.md"),
  ]) {
    const text = tryRead(path);
    if (text != null) return text;
  }
  throw new Error("no base.md prompt found (bundled or user)");
}

/**
 * Read a skill's fragment from the bundled/repo copy.
 *
 * The ~/.prompty/skills/<skill> user override is DISABLED for now (see loadBase)
 * — repo is the single source of truth while we finalise the prompts.
 *
 * Skills are optional: an empty/blank `skill` returns "" (no playbook). When a
 * named skill has no matching fragment, this also returns "" — there is no
 * default fallback, and a no-skill (or unknown-skill) call is valid, so neither
 * `in-call` nor `prep` ever throws.
 */
export function loadSkillFragment(skill: string, fragment: Fragment): string {
  const s = (skill || "").trim();
  if (!s) return "";
  for (const path of [
    // join(USER_SKILLS_DIR, s, `${fragment}.md`),
    join(BUNDLED_SKILLS_DIR, s, `${fragment}.md`),
  ]) {
    const text = tryRead(path);
    if (text != null) return text;
  }
  return "";
}

/** List available skills (a skill = a folder under bundled or user skills dir). */
export function listAvailableSkills(): { name: string; source: "user" | "bundled" }[] {
  const out = new Map<string, "user" | "bundled">();
  for (const name of subdirs(BUNDLED_SKILLS_DIR)) out.set(name, "bundled");
  for (const name of subdirs(USER_SKILLS_DIR)) out.set(name, "user");
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
