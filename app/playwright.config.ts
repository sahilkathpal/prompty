import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  // `list` for live console output; `html` (never auto-opened) leaves a
  // browsable artifact under playwright-report/ when a run fails in CI/headless.
  reporter: [["list"], ["html", { open: "never" }]],
});
