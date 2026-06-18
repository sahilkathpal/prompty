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

    const directionTab = page.getByTestId("tab-direction");
    if (await directionTab.count()) await directionTab.click();

    const textarea = page.getByTestId("playground-direction");
    await expect(textarea).toBeVisible();
    await textarea.fill(DIR);

    await page.getByTestId("prep-open").click();
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

    const directionTab = page.getByTestId("tab-direction");
    if (await directionTab.count()) await directionTab.click();

    // Direction restored into the editor, and the armed cards re-render WITHOUT
    // re-opening prep — proof they came from disk, not a live prep session.
    const textarea = page.getByTestId("playground-direction");
    await expect(textarea).toBeVisible();
    await expect.poll(async () => await textarea.inputValue(), { timeout: 10_000 }).toBe(DIR);
    await expect(page.getByTestId("component-goal")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("component-checklist")).toBeVisible({ timeout: 10_000 });
    console.log("RESTART: direction + components restored after relaunch");

    // ===== Start a call — the brief is consumed and the persisted copy clears ==
    await page.getByTestId("playground-start").click();
    await expect(page.getByTestId("playground-end")).toBeVisible({ timeout: 20_000 });

    // Editor empties immediately; persisted brief is wiped (direction + components).
    await expect(textarea).toHaveValue("");
    await expect(page.getByTestId("component-goal")).toHaveCount(0);
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

    await page.getByTestId("playground-end").click();
    await expect(page.getByTestId("playground-start")).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
  }
});
