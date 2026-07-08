import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { launchApp, freshUserDataDir, seedSettings, waitForReady, e2e, openMainWindow, getMainPage } from "./_helpers";
import fs from "node:fs/promises";

type Ev = { event: string; properties: Record<string, unknown> };
type Err = Record<string, unknown>;

// Phase 6 diagnostics (RUBY_OBSERVABILITY_PLAN §3.3, §7.3): transcription
// transport health as analytics events, and native/process crashes (which JS
// exception capture can't see) as tagged PostHog exceptions.

const events = (app: ElectronApplication): Promise<Ev[]> =>
  app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { getAnalyticsEvents: () => Ev[] } }).__prompty_e2e.getAnalyticsEvents());
const errors = (app: ElectronApplication): Promise<Err[]> =>
  app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { getAnalyticsErrors: () => Err[] } }).__prompty_e2e.getAnalyticsErrors());

test("deepgram_disconnected/recovered fire on a socket drop + recover", async () => {
  test.setTimeout(60_000);
  const dir = await freshUserDataDir("dg-health");
  await seedSettings(dir);
  const app = await launchApp(dir);
  try {
    await waitForReady(app);
    await e2e(app, "startSession");
    await expect.poll(async () => (await events(app)).some((e) => e.event === "call_started"), { timeout: 5_000 }).toBe(true);

    // Drive the REAL latch: a socket drop ("reconnecting") then a successful
    // reopen ("open") → disconnected, then recovered.
    await app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { simulateDeepgramStatus: (s: string) => void } }).__prompty_e2e.simulateDeepgramStatus("reconnecting"));
    await app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { simulateDeepgramStatus: (s: string) => void } }).__prompty_e2e.simulateDeepgramStatus("open"));

    await expect.poll(async () => (await events(app)).some((e) => e.event === "deepgram_disconnected"), { timeout: 5_000 }).toBe(true);
    await expect.poll(async () => (await events(app)).some((e) => e.event === "deepgram_recovered"), { timeout: 5_000 }).toBe(true);
    const disc = (await events(app)).find((e) => e.event === "deepgram_disconnected")!;
    expect(disc.properties.during_call).toBe(true);
    await e2e(app, "endSession");
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a hard renderer crash lands as a tagged render-process-gone exception", async () => {
  test.setTimeout(60_000);
  const dir = await freshUserDataDir("render-crash");
  await seedSettings(dir);
  const app = await launchApp(dir);
  try {
    await waitForReady(app);
    // Bring up a real renderer, then hard-crash its process.
    await openMainWindow(app);
    await getMainPage(app);
    await app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { forceRenderCrash: () => void } }).__prompty_e2e.forceRenderCrash());

    await expect
      .poll(async () => (await errors(app)).some((e) => e.component === "renderer-ui" && String(e.$exception_fingerprint).startsWith("renderer-ui:process-gone")), { timeout: 10_000 })
      .toBe(true);
    const crash = (await errors(app)).find((e) => e.component === "renderer-ui" && String(e.$exception_fingerprint).startsWith("renderer-ui:process-gone"))!;
    expect(crash.name).toBe("RenderProcessGone");
    expect(typeof crash.reason).toBe("string");
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
