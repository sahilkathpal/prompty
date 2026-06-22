import { test, expect } from "@playwright/test";
import {
  launchApp,
  freshUserDataDir,
  seedSettings,
  waitForReady,
  e2e,
  openMainWindow,
  getMainPage,
} from "./_helpers";
import fs from "node:fs/promises";

type Ev = { event: string; properties: Record<string, unknown> };

// Analytics runs in the main process. Under PROMPTY_E2E (set by the harness) the
// client never touches the network — capture() records into an in-memory buffer
// exposed via the __prompty_e2e bridge. So this verifies the real capture path
// (main lifecycle + renderer IPC + allowlist + opt-out) with zero events sent.
test("analytics: lifecycle + renderer events recorded; allowlist + opt-out enforced", async () => {
  test.setTimeout(60_000);

  const dir = await freshUserDataDir("analytics");
  await seedSettings(dir); // onboardingCompleted: true
  const app = await launchApp(dir);

  try {
    // Don't let "Speak to founders" launch a real browser during the test.
    await app.evaluate(({ shell }) => {
      shell.openExternal = () => Promise.resolve();
    });
    await waitForReady(app);

    const events = (): Promise<Ev[]> =>
      app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { getAnalyticsEvents: () => Ev[] } }).__prompty_e2e.getAnalyticsEvents());
    const names = async (): Promise<string[]> => (await events()).map((e) => e.event);

    // Fired on app ready.
    await expect.poll(names, { timeout: 5_000 }).toContain("app_launched");

    // Main-process call lifecycle, via the session bridge.
    await e2e(app, "startSession");
    await expect.poll(names, { timeout: 5_000 }).toContain("call_started");
    await e2e(app, "endSession");
    await expect.poll(names, { timeout: 5_000 }).toContain("call_ended");

    // Renderer → IPC → recorder: click "Speak to founders" on Home.
    await openMainWindow(app);
    const main = await getMainPage(app);
    await main.bringToFront();
    await main.getByTestId("speak-to-founders").click();
    if (!(await names()).includes("speak_to_founders_clicked")) {
      await main.getByTestId("speak-to-founders").click(); // first click activates the window
    }
    await expect
      .poll(async () => (await events()).find((e) => e.event === "speak_to_founders_clicked")?.properties.where, { timeout: 5_000 })
      .toBe("home");

    // Dwell: navigating away from Home unmounts it and emits screen_viewed.
    await main.getByTestId("nav-memory").click();
    await expect
      .poll(async () => (await events()).some((e) => e.event === "screen_viewed" && e.properties.screen === "home" && typeof e.properties.duration_s === "number"), { timeout: 5_000 })
      .toBe(true);

    // Allowlist: a renderer event not on the allowlist is dropped.
    await main.evaluate(() => (window as unknown as { prompty: { invoke: (c: string, p: unknown) => Promise<unknown> } }).prompty.invoke("analytics:capture", { event: "evil_event" }));
    await main.waitForTimeout(250);
    expect(await names()).not.toContain("evil_event");

    // Opt-out: once off, even an allowlisted event isn't recorded.
    await main.evaluate(() => (window as unknown as { prompty: { invoke: (c: string, p: unknown) => Promise<unknown> } }).prompty.invoke("settings:set", { analyticsOptOut: true }));
    await main.evaluate(() => (window as unknown as { prompty: { invoke: (c: string, p: unknown) => Promise<unknown> } }).prompty.invoke("analytics:capture", { event: "prep_started" }));
    await main.waitForTimeout(250);
    expect(await names()).not.toContain("prep_started");
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
