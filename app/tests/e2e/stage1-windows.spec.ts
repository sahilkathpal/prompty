import { test, expect, _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const APP_ROOT = path.resolve(__dirname, "../..");

// Use an isolated userData dir so we don't trample real settings and we get a
// predictable starting state.
async function freshUserDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-"));
  return dir;
}

test("Stage 1: window structure", async () => {
  const userDataDir = await freshUserDataDir();

  const app: ElectronApplication = await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      // Avoid hitting the real auto-updater in tests.
      NODE_ENV: "development",
    },
  });

  try {
    // Wait briefly for app.ready + tray/overlay creation.
    await app.evaluate(async ({ app: electronApp }) => {
      if (!electronApp.isReady()) {
        await new Promise<void>((resolve) => electronApp.once("ready", () => resolve()));
      }
    });

    // 1. Overlay should NOT be visible by default.
    const overlayVisibleInitially = await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows();
      return wins.some(
        (w) => !w.isDestroyed() && w.isVisible() && w.getTitle() === "Prompty Overlay",
      );
    });
    expect(overlayVisibleInitially).toBe(false);

    // 2. Open main window via IPC by simulating tray click — call openMainWindow from main.
    await app.evaluate(async () => {
      const handles = (globalThis as unknown as {
        __prompty_e2e: { openMainWindow: (tab: string) => void };
      }).__prompty_e2e;
      handles.openMainWindow("prep");
    });

    // 3. Grab the main window page.
    let mainPage: Page | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const pages = app.windows();
      const candidate = pages.find((p) => p.url().includes("main-window"));
      if (candidate) {
        mainPage = candidate;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(mainPage, "main window page not found").not.toBeNull();
    const page = mainPage!;
    await page.waitForSelector('[data-testid="main-window-root"]', { timeout: 10_000 });

    // 4. Home view renders the core sections.
    await page.waitForSelector('[data-testid="view-home"]', { timeout: 5_000 });
    await page.waitForSelector('[data-testid="home-adhoc-button"]');
    await page.waitForSelector('[data-testid="upcoming-list"]');
    await page.waitForSelector('[data-testid="completed-list"]');

    // 5. Settings page reachable via gear icon and includes the expected sections.
    await page.click('[data-testid="topbar-settings"]');
    await page.waitForSelector('[data-testid="view-settings"]');
    const settingsText = await page.textContent('[data-testid="view-settings"]');
    expect(settingsText).toContain("Account");
    expect(settingsText).toContain("Permissions");
    expect(settingsText).toContain("Storage");
    expect(settingsText).toContain("About");
    expect(settingsText).toContain("Hotkey");
    // Back returns to home.
    await page.click('[data-testid="settings-back"]');
    await page.waitForSelector('[data-testid="view-home"]');

    // 6. Overlay still not visible until we open it.
    const overlayStillHidden = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().every(
        (w) => w.isDestroyed() || !w.isVisible() || w.getTitle() !== "Prompty Overlay",
      );
    });
    expect(overlayStillHidden).toBe(true);

    // 7. Open overlay via IPC handler path (showOverlay).
    await app.evaluate(async () => {
      const handles = (globalThis as unknown as {
        __prompty_e2e: { showOverlay: () => void };
      }).__prompty_e2e;
      handles.showOverlay();
    });
    // Give it a tick to show.
    await new Promise((r) => setTimeout(r, 500));
    const overlayVisible = await app.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows().some((w) => {
        if (w.isDestroyed() || !w.isVisible()) return false;
        const url = w.webContents.getURL();
        return url.includes("overlay");
      });
    });
    expect(overlayVisible).toBe(true);
  } finally {
    await app.close();
  }
});
