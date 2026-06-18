import { test, expect } from "@playwright/test";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  openMainWindow,
  getMainPage,
  e2e,
} from "./_helpers";

// The working direction is persisted as a draft (settings.directionDraft) so a
// prepped brief survives closing and reopening the window. The prep screen's
// "Note to Ruby" editor is bound to the persisted `direction`; the on-mount seed
// restores the draft from the main process. We drive the real built app.
//
// NOTE (design-merge): the redesigned flow split the entry into a transient home
// chat bar (local state) and the prep-screen direction editor (the persisted
// draft). Re-entering prep via the home bar calls openPrep(message), which
// overwrites `direction` with the freshly-typed message — so there is no longer
// a UI surface that shows the restored draft without clobbering it. This spec
// therefore asserts the observable contract: the draft is written on edit and
// survives a renderer reload in persisted settings. The "restored into the
// editor" UX needs a product decision (e.g. seed the home bar from the draft)
// before it can be asserted through the UI again.

test("direction draft persists across a window reload", async () => {
  const userDataDir = await freshUserDataDir("e2e-direction-persist");
  await seedSettings(userDataDir);

  const DIR = `Persisted brief ${Math.random().toString(36).slice(2, 8)}: qualify the buyer.`;

  const app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // Enter prep — the "Note to Ruby" editor (prep-direction) is bound to the
    // persisted `direction`.
    await page.getByTestId("home-direction").fill("Prep this call");
    await page.getByTestId("home-send").click();
    const textarea = page.getByTestId("prep-direction");
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    // ===== Type a direction and let the debounced save (400ms) flush =====
    await textarea.fill(DIR);
    // Poll the persisted settings file until the draft lands, so we don't race
    // the debounce.
    await expect
      .poll(
        async () =>
          (await e2e<{ directionDraft?: string }>(app, "getSettings"))
            ?.directionDraft ?? "",
        { timeout: 5_000 },
      )
      .toBe(DIR);
    console.log("PERSIST: draft written to settings");

    // ===== Reload the renderer; the draft must survive in persisted settings,
    // and the on-mount seed re-reads it into `direction` state =====
    await page.reload();
    await expect
      .poll(
        async () =>
          (await e2e<{ directionDraft?: string }>(app, "getSettings"))
            ?.directionDraft ?? "",
        { timeout: 10_000 },
      )
      .toBe(DIR);
    console.log("PERSIST: draft survived reload in settings:", JSON.stringify(DIR));
  } finally {
    await app.close();
  }
});
