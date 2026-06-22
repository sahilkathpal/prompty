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

// Phase 1 of the UX audit (copy / naming sweep). Independent regression that the
// renamed labels and rewritten empty states render, and that the word "coaching"
// never reaches user-facing copy. Drives the real built Electron app.

const APP_ROOT = path.resolve(__dirname, "../..");

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

async function launchApp(
  userDataDir: string,
  memoryFile: string,
): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      PROMPTY_MOCK_AGENT: "1",
      PROMPTY_MEMORY_FILE: memoryFile,
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
    const h = (
      globalThis as unknown as {
        __prompty_e2e: { openMainWindow: () => void };
      }
    ).__prompty_e2e;
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

test("Phase 1 copy: home signposting, empty states, no 'coaching'", async () => {
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "prompty-e2e-phase1-"),
  );
  const memoryFile = path.join(userDataDir, "memory.json");
  await seedSettings(userDataDir);

  const app = await launchApp(userDataDir, memoryFile);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // --- Home: H1 send button signposts that it opens prep (not a call).
    const send = page.getByTestId("home-send");
    await expect(send).toHaveAttribute("aria-label", "Prepare for this call");
    await expect(send).toHaveAttribute("title", "Set up your prep");

    // --- Home: H8 keyboard hint appears on focus.
    await page.getByTestId("home-direction").click();
    await expect(page.getByTestId("home-bar-hint")).toHaveText(
      "Enter to start prepping · Shift+Enter for a new line",
    );

    // --- Memory: M1 titled empty state, "nudge" framing, no "coaching".
    await page.getByTestId("nav-memory").click();
    await expect(page.getByTestId("memory-empty")).toContainText(
      "Teach me how to nudge you",
    );
    await expect(page.locator(".fullscreen-intro")).toHaveText(
      "Tell me how to nudge you. These apply to every call.",
    );
    await expect(page.locator("body")).not.toContainText(/coach/i);
  } finally {
    await app.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
});
