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

    // App has mounted once the home chat bar is present. Give the one-time
    // initial session:state fetch (resolves to "idle") a beat to settle so it
    // can't race past a state we broadcast below.
    await expect(page.getByTestId("home-direction")).toBeVisible();
    await page.waitForTimeout(400);

    // Idle: we sit on the home screen.
    await expect(page.getByTestId("home-direction")).toBeVisible();

    // Live: the session auto-navigates to the live screen with a usable
    // "Finish listening" button.
    await broadcastState(app, "live");
    const endBtn = page.getByTestId("end-call");
    await expect(endBtn).toHaveText("Finish listening");
    await expect(endBtn).toBeEnabled();
    await expect(page.getByTestId("playground-ending")).toHaveCount(0);

    // Ending: the button locks into a disabled "Finishing…" and the wrap-up
    // status banner appears — so a second click can't re-fire end().
    await broadcastState(app, "ending");
    await expect(endBtn).toHaveText("Finishing…");
    await expect(endBtn).toBeDisabled();
    const status = page.getByTestId("playground-ending");
    await expect(status).toBeVisible();
    await expect(status).toContainText("Wrapping up");
    await expect(status).toContainText("few seconds");

    // Ended: teardown done — back on the home screen and the status banner clears.
    await broadcastState(app, "ended");
    await expect(page.getByTestId("home-direction")).toBeVisible();
    await expect(page.getByTestId("playground-ending")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
