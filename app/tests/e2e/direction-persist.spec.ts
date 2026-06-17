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
// prepped/typed brief survives closing and reopening the window. Reloading the
// renderer remounts it with empty initial state — the on-mount seed must restore
// the draft from the main process. We drive the real built app.

test("direction draft persists across a window reload", async () => {
  const userDataDir = await freshUserDataDir("e2e-direction-persist");
  await seedSettings(userDataDir);

  const DIR = `Persisted brief ${Math.random().toString(36).slice(2, 8)}: qualify the buyer.`;

  const app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    const directionTab = page.getByTestId("tab-direction");
    if (await directionTab.count()) await directionTab.click();

    const textarea = page.getByTestId("playground-direction");
    await expect(textarea).toBeVisible();

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

    // ===== Reload the renderer (fresh mount, empty initial state) =====
    await page.reload();
    const textareaAfter = page.getByTestId("playground-direction");
    await expect(textareaAfter).toBeVisible();

    // ===== The on-mount seed restores the draft =====
    await expect
      .poll(async () => await textareaAfter.inputValue(), { timeout: 10_000 })
      .toBe(DIR);
    console.log("PERSIST: direction restored after reload:", JSON.stringify(DIR));
  } finally {
    await app.close();
  }
});
