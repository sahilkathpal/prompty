// Memory store — the user's curated personalisation for how Ruby coaches them.
//
// A flat list of freeform natural-language items (RUBY upgrade B1), global to
// every call, persisted as a single JSON array at ~/.prompty/memory.json. The
// Memory tab does CRUD over it; the agent prompts inject it (see memoryBlock).
//
// Mirrors call-log.ts: plain sync fs, an env override for tests
// (PROMPTY_MEMORY_FILE), and defensive reads that never throw into the caller.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryItem } from "./types";

function memoryFile(): string {
  return (
    process.env.PROMPTY_MEMORY_FILE ??
    join(homedir(), ".prompty", "memory.json")
  );
}

function isMemoryItem(x: unknown): x is MemoryItem {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.text === "string";
}

/** Current memory items, newest last. Returns [] for a missing/corrupt file. */
export function readMemory(): MemoryItem[] {
  try {
    const parsed = JSON.parse(readFileSync(memoryFile(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMemoryItem).map((i) => ({
      id: i.id,
      text: i.text,
      createdAt: typeof i.createdAt === "number" ? i.createdAt : 0,
    }));
  } catch {
    return [];
  }
}

function writeMemory(items: MemoryItem[]): void {
  const file = memoryFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(items, null, 2));
}

/** Append a new item. Empty/whitespace text is rejected (returns null). */
export function addMemory(text: string): MemoryItem | null {
  const clean = text.trim();
  if (!clean) return null;
  const item: MemoryItem = {
    id: randomUUID(),
    text: clean,
    createdAt: Date.now(),
  };
  const items = readMemory();
  items.push(item);
  writeMemory(items);
  return item;
}

/** Re-insert a previously-deleted item at a given index, preserving its id, text,
 *  and createdAt (Undo, M2). No-ops to the existing item if the id is already
 *  present; clamps the index into range. */
export function restoreMemory(item: MemoryItem, index: number): MemoryItem {
  const items = readMemory();
  if (items.some((i) => i.id === item.id)) return item;
  const at = Math.max(0, Math.min(index, items.length));
  items.splice(at, 0, item);
  writeMemory(items);
  return item;
}

/** Edit an item's text in place. False if the id is unknown or text is empty. */
export function updateMemory(id: string, text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  const items = readMemory();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return false;
  items[idx] = { ...items[idx], text: clean };
  writeMemory(items);
  return true;
}

/** Remove an item. False if the id was not present. */
export function deleteMemory(id: string): boolean {
  const items = readMemory();
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) return false;
  writeMemory(next);
  return true;
}

/**
 * Bulleted block for injection into agent prompts (Phase 1b). Empty string when
 * there are no items, so callers can omit the surrounding section entirely.
 */
export function memoryBlock(items: MemoryItem[] = readMemory()): string {
  const lines = items.map((i) => i.text.trim()).filter(Boolean);
  return lines.map((l) => `- ${l}`).join("\n");
}
