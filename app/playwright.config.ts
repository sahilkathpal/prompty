import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

// Isolate ALL e2e call logs to a temp dir so specs that run a call never write
// into the developer's real ~/.prompty/calls. `--user-data-dir` does NOT change
// os.homedir(), so the app's call-log default would otherwise be the real home
// dir. Every spec spreads `...process.env` into its Electron launch, and this
// config module is evaluated in each worker process, so the override reaches
// specs that use their own launch helper too. A spec that needs a specific dir
// still sets PROMPTY_CALL_LOG_DIR explicitly, which wins.
if (!process.env.PROMPTY_CALL_LOG_DIR) {
  process.env.PROMPTY_CALL_LOG_DIR = path.join(os.tmpdir(), "prompty-e2e-calls");
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  globalSetup: "./tests/e2e/global-setup.ts",
  // `list` for live console output; `html` (never auto-opened) leaves a
  // browsable artifact under playwright-report/ when a run fails in CI/headless.
  reporter: [["list"], ["html", { open: "never" }]],
});
