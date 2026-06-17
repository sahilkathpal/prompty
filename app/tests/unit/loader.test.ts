// Unit: prompt-fragment loader (prompts/loader.ts). Resolves bundled base.md +
// skill fragments from the source tree (via __dirname), with no default
// fallback and no throw on unknown skills.

import { describe, it, expect } from "vitest";
import {
  loadBase,
  loadSkillFragment,
  listAvailableSkills,
  listBundledSkills,
  parseFrontmatter,
} from "../../src/main-process/prompts/loader";

describe("prompt loader", () => {
  it("loadBase returns the non-empty invariant core", () => {
    const base = loadBase();
    expect(base.length).toBeGreaterThan(0);
    expect(base).toContain("real-time call coach");
  });

  it("loadSkillFragment returns content for a known skill", () => {
    expect(loadSkillFragment("user-interview", "in-call").trim().length).toBeGreaterThan(0);
  });

  it("loadSkillFragment returns '' for empty or unknown skills (no fallback, no throw)", () => {
    expect(loadSkillFragment("", "in-call")).toBe("");
    expect(loadSkillFragment("no-such-skill", "in-call")).toBe("");
  });

  it("listAvailableSkills finds the three bundled skills and no 'default'", () => {
    const names = listAvailableSkills().map((s) => s.name).sort();
    for (const s of ["discovery", "hiring", "user-interview"]) {
      expect(names).toContain(s);
    }
    expect(names).not.toContain("default");
  });

  it("loadSkillFragment strips frontmatter — only the playbook body is injected", () => {
    const frag = loadSkillFragment("discovery", "in-call");
    expect(frag).not.toContain("title:");
    expect(frag).not.toMatch(/^---/); // no leading frontmatter fence
    expect(frag).toContain("Playbook: sales discovery");
  });

  it("listBundledSkills returns bundled skills with frontmatter metadata", () => {
    const skills = listBundledSkills();
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
    expect(byName["discovery"]?.title).toBe("Sales discovery");
    expect(byName["discovery"]?.description).toMatch(/mine pain/i);
    // Every entry has a non-empty title (frontmatter or folder-name fallback).
    for (const s of skills) expect(s.title.length).toBeGreaterThan(0);
    // Bundled-only: no user-sourced skills leak in (loadSkillFragment can't load them).
    for (const s of ["discovery", "hiring", "user-interview"]) {
      expect(byName[s]).toBeTruthy();
    }
  });
});

describe("parseFrontmatter", () => {
  it("splits leading frontmatter into data + body", () => {
    const { data, body } = parseFrontmatter(
      '---\ntitle: Foo\ndescription: "a, b"\n---\n\n# Body\ntext',
    );
    expect(data.title).toBe("Foo");
    expect(data.description).toBe("a, b"); // quotes stripped
    expect(body).toBe("# Body\ntext");
  });

  it("passes text without frontmatter through byte-identical", () => {
    const text = "## Heading\n\nno frontmatter here";
    const { data, body } = parseFrontmatter(text);
    expect(data).toEqual({});
    expect(body).toBe(text);
  });
});
