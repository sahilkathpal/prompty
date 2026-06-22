import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Wipe the shared e2e call-log sink before each run so leaked/mock calls from a
// previous run don't accumulate. The dir is the fallback for any spec that runs
// a call without naming its own PROMPTY_CALL_LOG_DIR (see playwright.config.ts);
// it lives under the OS temp dir, never the developer's real ~/.prompty/calls.
export default function globalSetup(): void {
  const dir = process.env.PROMPTY_CALL_LOG_DIR ?? path.join(os.tmpdir(), "prompty-e2e-calls");
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  fs.mkdirSync(dir, { recursive: true });
}
