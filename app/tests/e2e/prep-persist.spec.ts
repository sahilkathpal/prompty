import { test, expect } from "@playwright/test";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  openMainWindow,
  getMainPage,
  prepArmComponents,
  e2e,
} from "./_helpers";

// Gap 2: the pending prep — direction + goal/checklist — is one persisted unit
// that survives an app quit, and is cleared (not leaked) when a call starts.
// Skill is sticky and out of scope here. We drive a true restart: close the app
// and relaunch against the same user-data dir so the main process re-reads the
// brief from disk, not just a renderer remount.

type PersistedSettings = { directionDraft?: string; prepComponents?: unknown[] };

test("prepped brief (direction + components) survives an app restart, then clears on call start", async () => {
  const userDataDir = await freshUserDataDir("e2e-prep-persist");
  await seedSettings(userDataDir);

  const DIR = `Persisted brief ${Math.random().toString(36).slice(2, 8)}: qualify the buyer.`;
  const M = `pricing scope ${Math.random().toString(36).slice(2, 8)}`;

  // ===== Session 1: type a direction, arm components, confirm both persist =====
  let app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    let page = await getMainPage(app);

    // Enter prep from the home bar (openPrep seeds the direction), then arm a
    // goal + checklist.
    await page.getByTestId("home-direction").fill(DIR);
    await page.getByTestId("home-send").click();
    await expect(page.getByTestId("prep-direction")).toBeVisible({ timeout: 15_000 });
    await prepArmComponents(page, M);
    await expect(page.getByTestId("component-goal")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("component-checklist")).toBeVisible({ timeout: 15_000 });

    // Both halves of the brief are on disk.
    await expect
      .poll(
        async () => {
          const s = await e2e<PersistedSettings>(app, "getSettings");
          return { dir: s?.directionDraft ?? "", n: (s?.prepComponents ?? []).length };
        },
        { timeout: 5_000 },
      )
      .toEqual({ dir: DIR, n: 2 });
    console.log("PERSIST: direction + 2 components written to settings");
  } finally {
    await app.close();
  }

  // ===== Session 2: relaunch (fresh main process) — brief is restored =====
  app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // The prepped brief is restored from disk AND surfaced on the home screen:
    // the bar shows the direction and the "Pinned" line summarises the components.
    await expect(page.getByTestId("home-direction")).toHaveValue(DIR, { timeout: 10_000 });
    await expect(page.getByTestId("home-pinned")).toBeVisible();
    // H1: the restored-draft surface offers a primary "Continue prep" beside the
    // quieter "Start fresh".
    await expect(page.getByTestId("home-continue-prep")).toBeVisible();
    await expect(page.getByTestId("home-start-fresh")).toBeVisible();
    // ...and the persistence layer agrees.
    await expect
      .poll(
        async () => {
          const s = await e2e<PersistedSettings>(app, "getSettings");
          return { dir: s?.directionDraft ?? "", n: (s?.prepComponents ?? []).length };
        },
        { timeout: 10_000 },
      )
      .toEqual({ dir: DIR, n: 2 });
    console.log("RESTART: brief restored to the home bar + pinned line, and on disk");

    // ===== Resume into prep — the restored components actually reach the agent ==
    // "Continue prep" re-enters the draft with components intact (H1). Blur the
    // autofocused home textarea first so its mousedown-blur doesn't race the click.
    await page.locator(".home-section-heading").click();
    await page.getByTestId("home-continue-prep").click();
    // Entering prep does NOT wipe the restored prep: both cards re-render...
    await expect(page.getByTestId("component-goal")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("component-checklist")).toBeVisible({ timeout: 15_000 });
    // ...and the components reached the agent — they're carried into prep:start →
    // openPrepAgent, so the opening turn fires the RESUME variant that acknowledges
    // the pinned prep (proves the disk→main-process→agent hop end to end).
    await expect(
      page.getByTestId("prep-msg-assistant").filter({ hasText: "pinned" }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // ===== Start the call — the pending prep is consumed =====
    await expect(page.getByTestId("prep-begin")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("prep-begin").click();
    // Start listening returns to Home; the live call is the top row — open it
    // to reach the in-progress view's Finish-listening control.
    await expect(page.getByTestId("home-live-row")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("home-live-row").click();
    await expect(page.getByTestId("end-call")).toBeVisible({ timeout: 20_000 });

    // The persisted brief is wiped (direction + components) by the main process.
    await expect
      .poll(
        async () => {
          const s = await e2e<PersistedSettings>(app, "getSettings");
          return { dir: s?.directionDraft ?? "", n: (s?.prepComponents ?? []).length };
        },
        { timeout: 5_000 },
      )
      .toEqual({ dir: "", n: 0 });
    console.log("CLEAR-ON-START: persisted brief wiped after call start");

    await page.getByTestId("end-call").click();
    await expect(page.getByTestId("home-direction")).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
  }
});
