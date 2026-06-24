import { shell } from "electron";

// Scheme allowlist before handing any URL to the OS (audit finding #5). A
// compromised/XSS'd renderer — or a bad value from the relay's /config — could
// otherwise pass file:// (local-file exfiltration) or a custom-scheme/javascript:
// URL to trigger an arbitrary system handler. These four cover every legitimate
// caller: web links, mailto, and the x-apple.systempreferences: mic-pane deep link.
const ALLOWED_SCHEMES = new Set([
  "https:",
  "http:",
  "mailto:",
  "x-apple.systempreferences:",
]);

/**
 * Open an external URL via the OS, but only if its scheme is allowlisted.
 * Returns true if it was opened. Used by the open-external IPC, the dynamic
 * links:open IPC, and the tray.
 */
export function openExternalSafely(url: string): boolean {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    console.warn(`[open-external] dropped unparseable url: ${url}`);
    return false;
  }
  if (!ALLOWED_SCHEMES.has(scheme)) {
    console.warn(`[open-external] dropped disallowed scheme "${scheme}": ${url}`);
    return false;
  }
  void shell.openExternal(url);
  return true;
}
