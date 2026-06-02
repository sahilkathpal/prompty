import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Secrets = {
  deepgramApiKey?: string;
};

let cached: Secrets | undefined;

export function loadSecrets(): Secrets {
  if (cached) return cached;
  const path = process.env.PROMPTY_SECRETS_PATH ?? join(homedir(), ".prompty", "secrets.json");
  try {
    const raw = readFileSync(path, "utf8");
    cached = JSON.parse(raw) as Secrets;
  } catch {
    cached = {};
  }
  // Env vars override file values — useful for smoke tests + CI.
  cached = {
    deepgramApiKey: process.env.DEEPGRAM_API_KEY ?? cached.deepgramApiKey,
  };
  return cached;
}
