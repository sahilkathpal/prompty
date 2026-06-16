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

// The gem overlay can end the call itself: click the gem to expand its panel,
// then "End call" in the footer drives the same teardown as the tray / main
// window. This runs against the BUILT app under real (non-headless) Electron.

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-overlayend-"));
}
async function freshCallLogDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-overlayend-calls-"));
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

async function launchApp(): Promise<ElectronApplication> {
  const userDataDir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(userDataDir);
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      PROMPTY_MOCK_AGENT: "1",
      PROMPTY_CALL_LOG_DIR: callLogDir,
      NODE_ENV: "development",
    },
  });
}

async function waitForReady(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: electronApp }) => {
    if (!electronApp.isReady()) {
      await new Promise<void>((resolve) => electronApp.once("ready", () => resolve()));
    }
  });
}

async function startSession(app: ElectronApplication): Promise<{ ok: boolean }> {
  return (await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { startSession: () => Promise<{ ok: boolean }> };
    }).__prompty_e2e;
    return h.startSession();
  })) as { ok: boolean };
}

function overlayVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isVisible() && w.webContents.getURL().includes("overlay"),
    ),
  );
}

async function getOverlayPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const p = app.windows().find((pg) => pg.url().includes("overlay"));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("overlay (gem) page not found");
}

async function waitUntil(fn: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test("the gem overlay can end the call from its expanded panel", async () => {
  const app = await launchApp();
  try {
    await waitForReady(app);

    const res = await startSession(app);
    expect(res.ok).toBe(true);
    expect(await waitUntil(() => overlayVisible(app))).toBe(true);

    const overlay = await getOverlayPage(app);

    // Expand the gem → the End-call control appears in the panel footer.
    await overlay.getByTestId("gem").click();
    const endBtn = overlay.getByTestId("gem-end");
    await expect(endBtn).toBeVisible();
    await expect(endBtn).toHaveText("End call");
    await expect(endBtn).toBeEnabled();

    // Ending tears the call down and hides the overlay (same path as the tray).
    await endBtn.click();
    expect(await waitUntil(() => overlayVisible(app).then((v) => !v))).toBe(true);
  } finally {
    await app.close();
  }
});

test("the End-call control stays reachable when the note history overflows", async () => {
  const app = await launchApp();
  try {
    await waitForReady(app);
    const res = await startSession(app);
    expect(res.ok).toBe(true);
    expect(await waitUntil(() => overlayVisible(app))).toBe(true);
    const overlay = await getOverlayPage(app);

    // Build a long note history the real way: each injected final utterance
    // drives a mock-agent consider → one nudge → one history row. 14 rows make
    // the scrollback taller than the window, reproducing the overflow.
    await new Promise((r) => setTimeout(r, 1500)); // let the session reach "live"
    for (let i = 0; i < 14; i++) {
      await app.evaluate(
        (t) =>
          (
            globalThis as unknown as {
              __prompty_e2e: { injectUtterance: (u: unknown) => void };
            }
          ).__prompty_e2e.injectUtterance({
            speaker: "them",
            text: t,
            startMs: 0,
            endMs: 0,
            isFinal: true,
          }),
        `Point ${i}: a reasonably long thing the other party said about the rollout.`,
      );
      await new Promise((r) => setTimeout(r, 500));
    }

    // Let the last blooms dwell out so they don't cover the gem, then expand.
    await new Promise((r) => setTimeout(r, 1500));
    await overlay.getByTestId("gem").click();
    await expect(overlay.getByTestId("gem-history")).toBeVisible({ timeout: 5_000 });
    expect(
      await waitUntil(
        async () =>
          (await overlay.getByTestId("gem-history").locator(".gem-history-item").count()) >= 12,
      ),
    ).toBe(true);

    // The End footer must sit WITHIN the window, not clipped past the bottom
    // (the bug: it spilled below and could only be ended from the main window).
    const endBtn = overlay.getByTestId("gem-end");
    await expect(endBtn).toBeVisible();
    const box = await endBtn.boundingBox();
    const vh = await overlay.evaluate(() => window.innerHeight);
    expect(box).toBeTruthy();
    expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 2);

    // And it still actually ends the call.
    await endBtn.click();
    expect(await waitUntil(() => overlayVisible(app).then((v) => !v))).toBe(true);
  } finally {
    await app.close();
  }
});
