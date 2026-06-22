import { test, expect } from "@playwright/test";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  openMainWindow,
  getMainPage,
  prepArmComponents,
} from "./_helpers";

// Phase 5 of the UX audit: prep interaction polish. Drives the real built app
// through the mock prep agent (offer→confirm arms a goal + checklist) and
// asserts the kind glyphs (P5), the hover-revealed item × (P6), the card entry
// animation (P1), and the chat a11y + copy (P10/P14).

test("prep polish: kind glyphs, hover-revealed item ×, card animation, a11y", async () => {
  const userDataDir = await freshUserDataDir("e2e-phase5-prep");
  await seedSettings(userDataDir);
  const MSG = `rollout scope ${Math.random().toString(36).slice(2, 8)}`;

  const app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    await page.getByTestId("home-direction").fill("Prep this call");
    await page.getByTestId("home-send").click();
    await expect(page.getByTestId("prep-direction")).toBeVisible({ timeout: 15_000 });

    // P14 / P10: back reads "← Home"; the chat log is a polite live log; send is labelled.
    await expect(page.getByTestId("prep-back")).toHaveText("← Home");
    await expect(page.getByTestId("prep-log")).toHaveAttribute("role", "log");
    await expect(page.getByTestId("prep-log")).toHaveAttribute("aria-live", "polite");
    await expect(page.getByTestId("prep-send")).toHaveAttribute("aria-label", "Send message to Ruby");

    // Arm a goal + checklist via the mock agent.
    await prepArmComponents(page, MSG);
    const goalCard = page.getByTestId("component-goal");
    const checklistCard = page.getByTestId("component-checklist");
    await expect(goalCard).toBeVisible({ timeout: 15_000 });
    await expect(checklistCard).toBeVisible({ timeout: 15_000 });

    // P5: each kind carries a leading glyph.
    await expect(goalCard.locator(".prep-comp-glyph")).toHaveCount(1);
    await expect(checklistCard.locator(".prep-comp-glyph")).toHaveCount(1);

    // P1: the card block lands with the entry animation wired up.
    const animName = await goalCard.evaluate(
      (el) => getComputedStyle(el).animationName,
    );
    expect(animName).toContain("prep-comp-in");

    // P6: the per-item × is hidden at rest (opacity 0) and revealed on row hover.
    const item = page.getByTestId("checklist-item").first();
    const del = item.getByTestId("checklist-item-delete");
    const opacity = () => del.evaluate((el) => getComputedStyle(el).opacity);
    await expect.poll(opacity, { timeout: 5_000 }).toBe("0");
    await item.hover();
    await expect.poll(opacity, { timeout: 5_000 }).toBe("1");
  } finally {
    await app.close();
  }
});
