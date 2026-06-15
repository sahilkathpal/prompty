// Minimal, zero-dependency `.env` loader.
//
// The app reads secrets (today just DEEPGRAM_API_KEY) from a gitignored `.env`
// at the repo root. There is no `dotenv` dependency, so this parses the file
// itself: `KEY=VALUE` lines, `#` comments, blank lines, optional surrounding
// quotes. Existing `process.env` values always win (so a real env var or a
// shell export overrides the file). Missing file = no-op.
//
// Call this once, as early as possible in the main process, before anything
// reads `process.env.DEEPGRAM_API_KEY`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `.env` from the repo root into `process.env` without overwriting
 * already-set variables. Searches a few candidate locations so it works both
 * from `app/` (dev/build cwd) and from a packaged app's resources.
 */
export function loadEnv(): void {
  const candidates = [
    join(process.cwd(), ".env"),
    join(process.cwd(), "..", ".env"),
    // Bundled main lives at dist/electron/electron/main.js; the repo root is a
    // few levels up in dev. These keep the dev experience working regardless of
    // where Electron is launched from.
    join(__dirname, "..", "..", "..", ".env"),
    join(__dirname, "..", "..", "..", "..", ".env"),
  ];
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const parsed = parseEnv(readFileSync(path, "utf8"));
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
      return; // first one found wins
    } catch {
      // ignore unreadable candidate, try the next
    }
  }
}
