import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  openMainWindow,
  getMainPage,
} from "./_helpers";

// Phase 3 of the UX audit: the dedicated Live screen is cut. Starting a call
// returns to Home, where the live call is the TOP ROW of the calls list
// (pulsing dot + "Live · mm:ss"); clicking it opens a calm, read-only
// in-progress view backed by the prep plan, carrying the Finish-listening
// control. We drive the real built app through a real (mocked-agent) call.

test("the live call shows as a Home row → in-progress view → finish", async () => {
  const userDataDir = await freshUserDataDir("e2e-phase3-live");
  const callLogDir = path.join(userDataDir, "calls");
  await fs.mkdir(callLogDir, { recursive: true });
  await seedSettings(userDataDir);

  const app = await launchApp(userDataDir, {
    env: { PROMPTY_CALL_LOG_DIR: callLogDir },
  });
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // Prep, then start the call from prep.
    await page.getByTestId("home-direction").fill("Discovery call with Acme");
    await page.getByTestId("home-send").click();
    await expect(page.getByTestId("prep-direction")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("prep-begin").click();

    // 1) Start returns to HOME (no dedicated live screen) — the home bar is back.
    await expect(page.getByTestId("home-direction")).toBeVisible({ timeout: 20_000 });

    // 2) The live call is the top row of the calls list with a "Live · mm:ss"
    //    elapsed timer.
    const liveRow = page.getByTestId("home-live-row");
    await expect(liveRow).toBeVisible({ timeout: 20_000 });
    await expect(liveRow).toContainText(/Live · \d+:\d\d/);

    // 3) Clicking the live row opens the calm in-progress view: status line,
    //    read-only plan, elapsed timer, and the Finish-listening control.
    await liveRow.click();
    await expect(page.getByTestId("in-progress-status")).toContainText(
      "Ruby's listening",
    );
    await expect(page.getByTestId("in-progress-timer")).toContainText(/\d+:\d\d/);
    await expect(page.locator(".ip-direction")).not.toHaveText("");
    const finish = page.getByTestId("end-call");
    await expect(finish).toHaveText("Finish listening");

    // 4) Back returns to Home; the live row persists (call still live).
    await page.getByTestId("in-progress-back").click();
    await expect(liveRow).toBeVisible();

    // 5) Finish from the in-progress view → teardown → back on Home, with the
    //    just-finished call now in the list (no longer the live row).
    await liveRow.click();
    await page.getByTestId("end-call").click();
    await expect(page.getByTestId("home-direction")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("home-live-row")).toHaveCount(0);
    await expect(page.getByTestId("call-row").first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
  }
});
