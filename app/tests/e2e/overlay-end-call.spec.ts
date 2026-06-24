import { test, expect, type ElectronApplication } from "@playwright/test";
import {
  freshUserDataDir,
  seedSettings,
  launchApp as launchAppBase,
  waitForReady,
  getOverlayPage,
  e2e,
} from "./_helpers";

// The gem overlay can end the call itself: open its panel (hover reveals it; a
// click pins it open), then "Finish listening" in the footer drives the same
// teardown as the tray / main window. The clicks below pin the panel open, which
// is why they still reveal the End control. Runs against the BUILT app under real
// (non-headless) Electron.

async function launchApp(): Promise<ElectronApplication> {
  const userDataDir = await freshUserDataDir("e2e-overlayend");
  const callLogDir = await freshUserDataDir("e2e-overlayend-calls");
  await seedSettings(userDataDir, { lastTab: "in-call" });
  return launchAppBase(userDataDir, { env: { PROMPTY_CALL_LOG_DIR: callLogDir } });
}

const startSession = (app: ElectronApplication): Promise<{ ok: boolean }> =>
  e2e(app, "startSession");

function overlayVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isVisible() && w.webContents.getURL().includes("overlay"),
    ),
  );
}

async function waitUntil(fn: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test("the gem overlay can end the call from its expanded panel", async () => {
  const app = await launchApp();
  try {
    await waitForReady(app);

    const res = await startSession(app);
    expect(res.ok).toBe(true);
    expect(await waitUntil(() => overlayVisible(app))).toBe(true);

    const overlay = await getOverlayPage(app);

    // Expand the gem → the Finish-listening control appears in the panel footer.
    await overlay.getByTestId("gem").click();
    const endBtn = overlay.getByTestId("gem-end");
    await expect(endBtn).toBeVisible();
    await expect(endBtn).toHaveText("Finish listening");
    await expect(endBtn).toBeEnabled();

    // Ending tears the call down and hides the overlay (same path as the tray).
    await endBtn.click();
    expect(await waitUntil(() => overlayVisible(app).then((v) => !v))).toBe(true);
  } finally {
    await app.close();
  }
});

test("the End-call control stays reachable when the note history overflows", async () => {
  const app = await launchApp();
  try {
    await waitForReady(app);
    const res = await startSession(app);
    expect(res.ok).toBe(true);
    expect(await waitUntil(() => overlayVisible(app))).toBe(true);
    const overlay = await getOverlayPage(app);

    // Build a long note history the real way: each injected final utterance
    // drives a mock-agent consider → one nudge → one history row. 14 rows make
    // the scrollback taller than the window, reproducing the overflow.
    await new Promise((r) => setTimeout(r, 1500)); // let the session reach "live"
    for (let i = 0; i < 14; i++) {
      await app.evaluate(
        (t) =>
          (
            globalThis as unknown as {
              __prompty_e2e: { injectUtterance: (u: unknown) => void };
            }
          ).__prompty_e2e.injectUtterance({
            speaker: "them",
            text: t,
            startMs: 0,
            endMs: 0,
            isFinal: true,
          }),
        `Point ${i}: a reasonably long thing the other party said about the rollout.`,
      );
      await new Promise((r) => setTimeout(r, 500));
    }

    // Let the last blooms dwell out so they don't cover the gem, then expand.
    await new Promise((r) => setTimeout(r, 1500));
    await overlay.getByTestId("gem").click();
    await expect(overlay.getByTestId("gem-history")).toBeVisible({ timeout: 5_000 });
    expect(
      await waitUntil(
        async () =>
          (await overlay.getByTestId("gem-history").locator(".gem-history-item").count()) >= 12,
      ),
    ).toBe(true);

    // The End footer must sit WITHIN the window, not clipped past the bottom
    // (the bug: it spilled below and could only be ended from the main window).
    const endBtn = overlay.getByTestId("gem-end");
    await expect(endBtn).toBeVisible();
    const box = await endBtn.boundingBox();
    const vh = await overlay.evaluate(() => window.innerHeight);
    expect(box).toBeTruthy();
    expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 2);

    // And it still actually ends the call.
    await endBtn.click();
    expect(await waitUntil(() => overlayVisible(app).then((v) => !v))).toBe(true);
  } finally {
    await app.close();
  }
});
