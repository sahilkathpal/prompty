// Unit: memory store CRUD + injection block (memory-store.ts), isolated to a
// temp file via PROMPTY_MEMORY_FILE.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readMemory,
  addMemory,
  updateMemory,
  deleteMemory,
  memoryBlock,
} from "../../src/main-process/memory-store";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompty-mem-"));
  process.env.PROMPTY_MEMORY_FILE = path.join(dir, "memory.json");
});
afterEach(() => {
  delete process.env.PROMPTY_MEMORY_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("memory-store", () => {
  it("returns [] for a missing file", () => {
    expect(readMemory()).toEqual([]);
  });

  it("adds, reads back, updates, and deletes an item", () => {
    const item = addMemory("Keep nudges rare");
    expect(item).not.toBeNull();
    expect(readMemory()).toHaveLength(1);
    expect(readMemory()[0].text).toBe("Keep nudges rare");

    expect(updateMemory(item!.id, "Keep nudges very rare")).toBe(true);
    expect(readMemory()[0].text).toBe("Keep nudges very rare");

    expect(deleteMemory(item!.id)).toBe(true);
    expect(readMemory()).toEqual([]);
  });

  it("rejects empty/whitespace text on add and update", () => {
    expect(addMemory("   ")).toBeNull();
    const item = addMemory("real")!;
    expect(updateMemory(item.id, "  ")).toBe(false);
    expect(readMemory()[0].text).toBe("real");
  });

  it("returns false updating/deleting an unknown id", () => {
    expect(updateMemory("nope", "x")).toBe(false);
    expect(deleteMemory("nope")).toBe(false);
  });

  it("trims text on add and tolerates a corrupt file", () => {
    expect(addMemory("  padded  ")!.text).toBe("padded");
    fs.writeFileSync(process.env.PROMPTY_MEMORY_FILE!, "{not json");
    expect(readMemory()).toEqual([]);
  });

  it("memoryBlock renders a bullet list and '' when empty", () => {
    expect(memoryBlock([])).toBe("");
    expect(
      memoryBlock([
        { id: "1", text: "a", createdAt: 0 },
        { id: "2", text: "b", createdAt: 0 },
      ]),
    ).toBe("- a\n- b");
  });
});
