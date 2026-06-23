// Encrypted-at-rest secret persistence, with a hard guard against ever writing
// a secret in plaintext in a production build (audit finding).
//
// Secrets (the Google OAuth session, minted Deepgram keys) are written to
// userData encrypted via Electron's safeStorage (the OS keychain). safeStorage
// is NOT available in headless dev/E2E, where these helpers fall back to
// plaintext so the tests can round-trip. The risk that fix closes: a *packaged*
// build where safeStorage is somehow unavailable would previously have written
// the refresh token / Deepgram key to disk in cleartext. Here, a packaged build
// with no encryption persists NOTHING (caller keeps the value in memory) rather
// than leak it — and won't trust a plaintext file on read either.

import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

/** Plaintext persistence is acceptable only in dev/E2E, never in a packaged app. */
function plaintextAllowed(): boolean {
  return !app.isPackaged;
}

/**
 * Write `data`, encrypted via safeStorage when available. Returns true if it was
 * written. In a packaged build with no encryption, writes nothing and returns
 * false (the caller should keep the value in memory only).
 */
export function writeSecretFile(filePath: string, data: string): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(filePath, safeStorage.encryptString(data));
      return true;
    }
    if (plaintextAllowed()) {
      fs.writeFileSync(filePath, data, "utf8");
      return true;
    }
    console.warn(
      "[secret-file] encryption unavailable in a packaged build — refusing to " +
        "persist secret in plaintext; keeping it in memory only",
    );
    return false;
  } catch (e) {
    console.error("[secret-file] write failed:", (e as Error).message);
    return false;
  }
}

/**
 * Read a secret previously written by {@link writeSecretFile}. Returns null if
 * missing/unreadable. A packaged build only trusts an encrypted blob; a
 * plaintext file is read only in dev/E2E.
 */
export function readSecretFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath);
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(raw);
      } catch {
        // Not an encrypted blob (e.g. a plaintext file from a prior dev run).
        return plaintextAllowed() ? raw.toString("utf8") : null;
      }
    }
    return plaintextAllowed() ? raw.toString("utf8") : null;
  } catch (e) {
    console.error("[secret-file] read failed:", (e as Error).message);
    return null;
  }
}
