import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { launchApp, freshUserDataDir, seedSettings, waitForReady, e2e, getOverlayPage } from "./_helpers";
import fs from "node:fs/promises";

type Ev = { event: string; properties: Record<string, unknown> };

// audio_route_changed (RUBY_OBSERVABILITY_PLAN §7.3): a renderer's
// navigator.mediaDevices `devicechange` (plug/unplug, BT profile flip,
// default-device switch) is forwarded to main, which emits the event ONLY while
// a call is active (the John trigger — correlate with silent calls).

const events = (app: ElectronApplication): Promise<Ev[]> =>
  app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { getAnalyticsEvents: () => Ev[] } }).__prompty_e2e.getAnalyticsEvents());
const routeCount = async (app: ElectronApplication): Promise<number> =>
  (await events(app)).filter((e) => e.event === "audio_route_changed").length;

test("audio_route_changed: fires on a device change during a call, ignored outside one", async () => {
  test.setTimeout(60_000);
  const dir = await freshUserDataDir("audio-route");
  await seedSettings(dir);
  const app = await launchApp(dir);
  try {
    await waitForReady(app);
    const overlay = await getOverlayPage(app);
    const fireDeviceChange = () =>
      overlay.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event("devicechange")));

    // During a call → emitted with during_call:true.
    await e2e(app, "startSession");
    await expect.poll(async () => (await events(app)).some((e) => e.event === "call_started"), { timeout: 5_000 }).toBe(true);
    await fireDeviceChange();
    await expect.poll(() => routeCount(app), { timeout: 5_000 }).toBe(1);
    expect((await events(app)).find((e) => e.event === "audio_route_changed")!.properties.during_call).toBe(true);

    await e2e(app, "endSession");
    // Wait out the renderer coalesce window (1500ms) so the next change isn't
    // swallowed by the debounce, then confirm an out-of-call change is dropped.
    await overlay.waitForTimeout(1700);
    await fireDeviceChange();
    await overlay.waitForTimeout(300);
    expect(await routeCount(app)).toBe(1);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
