import { test, expect } from "@playwright/test";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  openMainWindow,
  getMainPage,
} from "./_helpers";

// Negative case for the suggest-then-create gate: on a low-value (casual) call,
// prep should still produce a working direction but NEITHER offer NOR create a
// goal/checklist. This guards against regressing to over-eager creation — the
// whole point of making the structured tools optional.
//
// Under PROMPTY_MOCK_AGENT=1 a message mentioning "casual"/"catch up" takes the
// mock's low-value path: the direction is rewritten ("Focus: M") and the
// assistant replies WITHOUT an offer, so no component cards ever appear.

test("prep low-value call: direction only, no goal/checklist offered or created", async () => {
  const userDataDir = await freshUserDataDir("e2e-prep-no-suggest");
  await seedSettings(userDataDir);

  // Must hit the mock's low-value heuristic ("casual" / "catch up").
  const MSG = `casual catch-up with an old colleague ${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // Enter prep from the home chat bar (the seed direction is stored silently —
    // the mock only responds to chat sends, so it triggers no offer).
    await page.getByTestId("home-direction").fill("Prep this call");
    await page.getByTestId("home-send").click();
    await expect(page.getByTestId("prep-input")).toBeVisible({ timeout: 15_000 });

    // ===== Send the low-value message and wait for the assistant turn =====
    await page.getByTestId("prep-input").fill(MSG);
    await page.getByTestId("prep-send").click();

    const asst = page.getByTestId("prep-msg-assistant").first();
    await expect(asst).toBeVisible({ timeout: 15_000 });
    const asstText = (await asst.textContent()) ?? "";
    console.log("NEG assistant bubble:", JSON.stringify(asstText));

    // ===== Criterion 1: the direction was still updated (prep functioned) =====
    const textarea = page.getByTestId("prep-direction");
    await expect
      .poll(async () => await textarea.inputValue(), { timeout: 15_000 })
      .toContain(`Focus: ${MSG}`);
    console.log("NEG CRIT1: direction updated with Focus line");

    // ===== Criterion 2: Ruby did NOT offer a goal/checklist =====
    expect(asstText.toLowerCase()).not.toContain("pin a goal");
    console.log("NEG CRIT2: assistant did not offer to pin a goal/checklist");

    // ===== Criterion 3: NO component cards or panel exist =====
    await expect(page.getByTestId("prep-components")).toHaveCount(0);
    await expect(page.getByTestId("component-goal")).toHaveCount(0);
    await expect(page.getByTestId("component-checklist")).toHaveCount(0);
    console.log("NEG CRIT3: no goal/checklist cards rendered");
  } finally {
    await app.close();
  }
});
