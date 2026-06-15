import {
  test,
  expect,
  _electron as electron,
  ElectronApplication,
  Page,
} from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// The post-call teardown (close agent + generate the summary) takes several
// seconds, during which the session sits in the "ending" state. The main-window
// Start/End button must reflect that: it locks into a disabled "Ending…" so a
// re-click can't re-fire end(), and a status line explains the wait. The real
// mock end() flips through "ending" too fast to observe, so we drive the state
// directly through the same broadcast path the real flow uses.

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-endfeedback-"));
}

async function seedSettings(userDataDir: string): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, "prompty-settings.json"),
    JSON.stringify({
      panelPosition: null,
      launchAtLogin: false,
      hotkey: "Alt+Shift+Space",
      onboardingCompleted: true,
      loginItemPrompted: true,
      lastTab: "in-call",
    }),
    "utf8",
  );
}

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      PROMPTY_MOCK_AGENT: "1",
      NODE_ENV: "development",
    },
  });
}

async function waitForReady(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: electronApp }) => {
    if (!electronApp.isReady()) {
      await new Promise<void>((resolve) =>
        electronApp.once("ready", () => resolve()),
      );
    }
  });
}

async function openMainWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { openMainWindow: () => void };
    }).__prompty_e2e;
    h.openMainWindow();
  });
}

async function getMainPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const p = app.windows().find((pg) => pg.url().includes("main-window"));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("main window page not found");
}

async function broadcastState(app: ElectronApplication, state: string): Promise<void> {
  await app.evaluate(async (_electron, s) => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { broadcastSessionState: (state: string) => boolean };
    }).__prompty_e2e;
    h.broadcastSessionState(s);
  }, state);
}

test("the main-window Start/End button reflects the 'ending' teardown state", async () => {
  const dir = await freshUserDataDir();
  await seedSettings(dir);
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
