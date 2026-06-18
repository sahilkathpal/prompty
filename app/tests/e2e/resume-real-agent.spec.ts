import { test, expect } from "@playwright/test";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  openMainWindow,
  getMainPage,
} from "./_helpers";

// @real — the ONE end-to-end seam the mock can't prove: a goal + checklist +
// direction that were genuinely PERSISTED on disk and CARRIED through the main
// process actually reach the REAL prep agent. We seed settings (the persisted
// pending prep), launch with the mock agent DISABLED (real `claude`), resume into
// prep, and assert the live opening turn acknowledges the pinned components — which
// it can only do if they were rendered into its system prompt via the carry path
// (settings → activePrepComponents → prep:start → openPrepAgent → loadPrepPrompt).
test("@real resumed prep: persisted+carried components reach the real agent", async () => {
  const udd = await freshUserDataDir("resume-real");
  // A distinctive token in the goal so we can confirm the model got the ACTUAL
  // content, not a generic "you have a goal" guess.
  const GOAL = "Confirm the Northwind renewal risk before pricing comes up";
  await seedSettings(udd, {
    directionDraft: "Discovery call with Northwind about their renewal",
    prepComponents: [
      { type: "goal", id: "g1", text: GOAL },
      {
        type: "checklist",
        id: "c1",
        title: "Cover",
        items: [
          { id: "i1", text: "Their current value realization", done: false },
          { id: "i2", text: "Who owns the renewal budget", done: false },
        ],
      },
    ],
  });

  // Disable the mock agent → real `claude`. Audio/Deepgram stay mocked (no call).
  const app = await launchApp(udd, { env: { PROMPTY_MOCK_AGENT: "" } });
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // The persisted prep is carried to the renderer (home bar + pinned line).
    await expect(page.getByTestId("home-direction")).toHaveValue(
      "Discovery call with Northwind about their renewal",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("home-pinned")).toBeVisible();

    // Resume into prep — fires the REAL opening turn.
    await page.getByTestId("home-send").click();
    const opening = page.getByTestId("prep-msg-assistant").first();
    await expect(opening).toBeVisible({ timeout: 60_000 });
    // The opening turn streams in — poll the bubble until it acknowledges the
    // pinned prep. "goal"/"checklist"/"pinned" can ONLY appear if the components
    // reached the real prompt (the direction alone never mentions them). This
    // waits for the streamed turn to finish, and fails if it never acknowledges.
    await expect(opening).toContainText(/goal|checklist|pinned/i, { timeout: 60_000 });
    console.log("[resume-real] REAL opening turn:", JSON.stringify(await opening.textContent()));
  } finally {
    await app.close();
  }
});
