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
import type { SkillInfo } from "../../shared/types";

export type { SkillInfo };

const BUNDLED_PROMPTS_DIR = __dirname;
const BUNDLED_SKILLS_DIR = join(BUNDLED_PROMPTS_DIR, "skills");
const USER_PROMPTS_DIR = join(homedir(), ".prompty");
const USER_SKILLS_DIR = join(USER_PROMPTS_DIR, "skills");

export type Fragment = "in-call" | "prep";

/**
 * Split leading frontmatter (`--- … ---`) from the body. Triggers ONLY on a
 * leading `---` line: a fragment without frontmatter passes through with
 * `body === text` (byte-identical), so existing playbooks are unaffected. Parses
 * only simple `key: value` string pairs — enough for `title`/`description`.
 */
export function parseFrontmatter(text: string): {
  data: Record<string, string>;
  body: string;
} {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)*/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    if (!key) continue;
    let val = line.slice(i + 1).trim();
    if (
      val.length >= 2 &&
      ((val[0] === '"' && val.endsWith('"')) ||
        (val[0] === "'" && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    data[key] = val;
  }
  return { data, body: text.slice(m[0].length) };
}

/**
 * Read the invariant in-call core. Loaded only from the bundled repo copy —
 * there is no user override, so a stray ~/.prompty/base.md can never silently
 * shadow a repo edit. The repo is the single source of truth for the base.
 */
export function loadBase(): string {
  const text = tryRead(join(BUNDLED_PROMPTS_DIR, "base.md"));
  if (text == null) throw new Error("no bundled base.md prompt found");
  return text;
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
 *
 * Any leading frontmatter (the picker's `title`/`description`) is stripped — only
 * the playbook body is injected into the prompt.
 */
export function loadSkillFragment(skill: string, fragment: Fragment): string {
  const s = (skill || "").trim();
  if (!s) return "";
  for (const path of [
    // join(USER_SKILLS_DIR, s, `${fragment}.md`),
    join(BUNDLED_SKILLS_DIR, s, `${fragment}.md`),
  ]) {
    const text = tryRead(path);
    if (text != null) return parseFrontmatter(text).body;
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

/**
 * The skills the picker offers: BUNDLED only, each with display metadata parsed
 * from its `in-call.md` frontmatter (folder name title-cased when absent). User
 * skills are intentionally excluded — `loadSkillFragment`'s user-override is
 * disabled, so a `~/.prompty` skill would show but load nothing. A folder with
 * no readable `in-call.md` is skipped (an in-call playbook is what makes it
 * pickable).
 */
export function listBundledSkills(): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const name of subdirs(BUNDLED_SKILLS_DIR)) {
    const raw = tryRead(join(BUNDLED_SKILLS_DIR, name, "in-call.md"));
    if (raw == null) continue;
    const { data } = parseFrontmatter(raw);
    out.push({
      name,
      title: data.title?.trim() || titleCase(name),
      description: data.description?.trim() || "",
    });
  }
  return out;
}

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
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
