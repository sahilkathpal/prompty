import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

// Vitest drives the fast, deterministic, ZERO-QUOTA test layer: pure-logic unit
// tests (tests/unit) and module-seam integration tests (tests/integration). The
// Playwright E2E suite (tests/e2e) is run separately via `npm run e2e` and is
// intentionally excluded here.
export default defineConfig({
  resolve: {
    alias: {
      // Main-process modules (sidecar, coach-session) `import { app } from
      // "electron"`. Outside an Electron runtime the `electron` package resolves
      // to a path string, not the API, so we alias it to the same minimal fake
      // the smoke tests use.
      electron: `${root}tests/fixtures/fake-electron.cjs`,
      "@shared": `${root}src/shared`,
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    // The integration layer drives real timers (reconnect backoff, no-audio
    // flips); give them headroom without masking a genuine hang.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
      include: ["src/main-process/**/*.ts"],
      // Type-only and prose/asset modules carry no executable logic to cover.
      exclude: ["src/main-process/types.ts", "src/main-process/prompts/skills/**"],
      // Thresholds are reported, not enforced, while the suite is young — raise
      // to `thresholds: { lines: 70 }` once the integration layer settles.
    },
  },
});
