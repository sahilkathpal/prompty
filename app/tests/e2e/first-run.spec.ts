import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { APP_ROOT, freshUserDataDir } from "./_helpers";
import path from "node:path";
import fs from "node:fs/promises";

type Bridge = { prompty: { invoke: (c: string, p?: unknown) => Promise<unknown> } };

async function findWindow(app: ElectronApplication, fragment: string, timeoutMs = 10_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = app.windows().find((pg) => pg.url().includes(fragment));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${fragment} window not found within ${timeoutMs}ms`);
}

// Verifies the bug fix (onboarding:complete must OPEN the main window) and the
// guided first run (prep-bar coachmark on Home, playbook coachmark on Prep).
// Real onboarding flow (no PROMPTY_E2E, which skips it); PROMPTY_MOCK_AGENT
// satisfies the auth gate so complete() succeeds without real OAuth.
test("first run: complete onboarding opens Home with the prep + playbook coachmarks", async () => {
  test.setTimeout(60_000);

  const dir = await freshUserDataDir("verify-firstrun");
  const settingsPath = path.join(dir, "prompty-settings.json");
  await fs.writeFile(settingsPath, JSON.stringify({ onboardingCompleted: false, hotkey: "Alt+Shift+Space" }), "utf8");

  const app = await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${dir}`],
    env: { ...process.env, PROMPTY_MOCK_AGENT: "1", PROMPTY_CALL_LOG_DIR: path.join(dir, "calls") },
  });

  try {
    const ob = await findWindow(app, "onboarding");
    await expect(ob.locator("text=Meet Ruby")).toBeVisible({ timeout: 5_000 });

    // Stub shell.openExternal so "Speak to founders" records its URL instead of
    // launching a real browser during the test. Done after the onboarding window
    // is up — evaluating the main process mid-launch races window navigation and
    // can throw "Execution context was destroyed".
    await app.evaluate(({ shell }) => {
      (globalThis as unknown as { __opened: string[] }).__opened = [];
      shell.openExternal = (url: string) => {
        (globalThis as unknown as { __opened: string[] }).__opened.push(url);
        return Promise.resolve();
      };
    });

    // Complete (fire-and-forget: the handler tears down this window).
    await ob.evaluate(() => {
      void (window as unknown as Bridge).prompty.invoke("onboarding:complete", undefined);
    }).catch(() => {});

    // firstRunCoach armed in settings.
    await expect.poll(async () => {
      const raw = await fs.readFile(settingsPath, "utf8").catch(() => "{}");
      const s = JSON.parse(raw);
      return s.onboardingCompleted === true && s.firstRunCoach === true;
    }, { timeout: 5_000 }).toBe(true);

    // THE BUG FIX: the main window actually opens (not just tray + overlay).
    const main = await findWindow(app, "main-window", 8_000);
    await expect(main.getByTestId("home-direction")).toBeVisible({ timeout: 5_000 });

    // The Home prep coachmark is shown on first run.
    await expect(main.getByTestId("home-coach")).toBeVisible({ timeout: 5_000 });
    await main.bringToFront();

    // "Use an example" seeds the prep bar with a concrete brief. Electron swallows
    // the first click on a freshly-shown window (activation), so click again if the
    // first didn't land — a real user's repeat click works the same way.
    await main.getByTestId("home-coach-example").click();
    if ((await main.getByTestId("home-direction").inputValue()) === "") {
      await main.getByTestId("home-coach-example").click();
    }
    await expect(main.getByTestId("home-direction")).not.toHaveValue("");
    await main.screenshot({ path: path.join(APP_ROOT, "tests/e2e/__screens__/verify-home-coach.png") });

    // "Speak to founders" on Home opens the scheduling link.
    await expect(main.getByTestId("speak-to-founders")).toHaveText("Speak to founders");
    await main.getByTestId("speak-to-founders").click();

    // Enter prep → the playbook coachmark is shown there.
    await main.getByTestId("home-send").click();
    await expect(main.getByTestId("prep-skill-coach")).toBeVisible({ timeout: 8_000 });
    await main.screenshot({ path: path.join(APP_ROOT, "tests/e2e/__screens__/verify-prep-coach.png") });

    // "Want to add your own playbook? Speak to founders." under the note opens it too.
    await expect(main.getByTestId("prep-add-playbook")).toContainText("add your own playbook");
    await main.getByTestId("prep-speak-to-founders").click();

    const opened = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
    expect(opened.filter((u) => u.includes("calendly.com/sahil-revise")).length).toBe(2);

    // "Got it" ends the tour and persists firstRunCoach:false so it never returns.
    await main.getByTestId("prep-skill-coach-dismiss").click();
    await expect(main.getByTestId("prep-skill-coach")).toHaveCount(0);
    await expect.poll(async () => {
      const raw = await fs.readFile(settingsPath, "utf8").catch(() => "{}");
      return JSON.parse(raw).firstRunCoach;
    }, { timeout: 5_000 }).toBe(false);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
