import { test, expect, type ElectronApplication } from "@playwright/test";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  openMainWindow,
  getMainPage,
  e2e,
} from "./_helpers";

// The post-call teardown (close agent + generate the summary) takes several
// seconds, during which the session sits in the "ending" state. The main-window
// Start/End button must reflect that: it locks into a disabled "Ending…" so a
// re-click can't re-fire end(), and a status line explains the wait. The real
// mock end() flips through "ending" too fast to observe, so we drive the state
// directly through the same broadcast path the real flow uses.

const broadcastState = (app: ElectronApplication, state: string): Promise<void> =>
  e2e(app, "broadcastSessionState", state);

test("the main-window Start/End button reflects the 'ending' teardown state", async () => {
  const dir = await freshUserDataDir("e2e-endfeedback");
  await seedSettings(dir, { lastTab: "in-call" });
  const app = await launchApp(dir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // App has mounted once the Direction box is present. Give the one-time
    // initial session:state fetch (resolves to "idle") a beat to settle so it
    // can't race past a state we broadcast below.
    await expect(page.getByTestId("playground-direction")).toBeVisible();
    await page.waitForTimeout(400);

    // Idle: the primary CTA is "Start call".
    await expect(page.getByTestId("playground-start")).toHaveText("Start call");

    // Live: the button becomes a usable "End call".
    await broadcastState(app, "live");
    const endBtn = page.getByTestId("playground-end");
    await expect(endBtn).toHaveText("End call");
    await expect(endBtn).toBeEnabled();
    await expect(page.getByTestId("playground-ending")).toHaveCount(0);

    // Ending: the button locks into a disabled "Ending…" and the wrap-up status
    // line appears — so a second click can't re-fire end().
    await broadcastState(app, "ending");
    await expect(endBtn).toHaveText("Ending…");
    await expect(endBtn).toBeDisabled();
    const status = page.getByTestId("playground-ending");
    await expect(status).toBeVisible();
    await expect(status).toContainText("Wrapping up");
    await expect(status).toContainText("This can take a few seconds");

    // Back to idle: the CTA returns to "Start call" and the status line clears.
    await broadcastState(app, "idle");
    await expect(page.getByTestId("playground-start")).toHaveText("Start call");
    await expect(page.getByTestId("playground-ending")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
