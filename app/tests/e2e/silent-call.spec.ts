import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { launchApp, freshUserDataDir, seedSettings, waitForReady, e2e, injectUtterance } from "./_helpers";
import fs from "node:fs/promises";

type Err = Record<string, unknown>;

// The silent-failure → synthetic-issue bridge (RUBY_OBSERVABILITY_PLAN §5.4, the
// crux). A meaningful-duration call that transcribed nothing must manufacture a
// SilentCallError issue; a healthy call must not. PROMPTY_MEANINGFUL_CALL_S=0
// makes short test calls count as "meaningful" so the outcome logic runs.

const errors = (app: ElectronApplication): Promise<Err[]> =>
  app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { getAnalyticsErrors: () => Err[] } }).__prompty_e2e.getAnalyticsErrors());
const fpCount = async (app: ElectronApplication, fp: string): Promise<number> =>
  (await errors(app)).filter((e) => e.$exception_fingerprint === fp).length;

test("silent-call: a meaningful call with no transcript raises exactly one issue; a healthy call raises none", async () => {
  test.setTimeout(60_000);
  const dir = await freshUserDataDir("silent-call");
  await seedSettings(dir);
  const app = await launchApp(dir, { env: { PROMPTY_MEANINGFUL_CALL_S: "0" } });
  try {
    await waitForReady(app);

    // Call 1: start → end with ZERO utterances → silent-call issue.
    await e2e(app, "startSession");
    await e2e(app, "endSession");
    await expect.poll(() => fpCount(app, "capture:silent-call"), { timeout: 5_000 }).toBe(1);
    const issue = (await errors(app)).find((e) => e.$exception_fingerprint === "capture:silent-call")!;
    expect(issue.component).toBe("capture");
    expect(issue.name).toBe("SilentCallError");
    expect(issue.transcript_utterances).toBe(0);

    // Call 2: start → two final utterances → end → NO new silent-call issue.
    await e2e(app, "startSession");
    await injectUtterance(app, "we run eight brokers", "them");
    await injectUtterance(app, "pricing is the sticking point", "them");
    await e2e(app, "endSession");
    // Give the outcome check a beat, then assert the count did not grow.
    await app.evaluate(() => new Promise((r) => setTimeout(r, 250)));
    expect(await fpCount(app, "capture:silent-call")).toBe(1);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("silent-call: a call that captured us but not the far side raises a them-blackout issue", async () => {
  test.setTimeout(60_000);
  const dir = await freshUserDataDir("them-blackout");
  await seedSettings(dir);
  const app = await launchApp(dir, { env: { PROMPTY_MEANINGFUL_CALL_S: "0" } });
  try {
    await waitForReady(app);

    await e2e(app, "startSession");
    await injectUtterance(app, "our side spoke plenty", "me");
    await app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { simulateThemSilent: () => void } }).__prompty_e2e.simulateThemSilent());
    await e2e(app, "endSession");

    await expect.poll(() => fpCount(app, "capture:them-blackout"), { timeout: 5_000 }).toBe(1);
    // Not misclassified as a full silent call (we did transcribe our side).
    expect(await fpCount(app, "capture:silent-call")).toBe(0);
    const issue = (await errors(app)).find((e) => e.$exception_fingerprint === "capture:them-blackout")!;
    expect(issue.name).toBe("ThemBlackoutError");
    expect(issue.them_silent_seen).toBe(true);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
