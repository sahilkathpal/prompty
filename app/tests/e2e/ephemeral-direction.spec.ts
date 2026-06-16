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

// Independent verification of Phase 2a: ephemeral per-call direction.
// Direction is no longer persisted to ~/.prompty/playground/direction.md and
// reloaded on launch. It must:
//   1. start EMPTY on a fresh launch,
//   2. be passed straight into the call and snapshotted into the CallLog,
//   3. NOT survive across a relaunch (no pre-call persistence).
// We drive the real built Electron app and read the on-disk CallLog.

const APP_ROOT = path.resolve(__dirname, "../..");

async function seedSettings(userDataDir: string): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, "prompty-settings.json"),
    JSON.stringify({
      onboardingCompleted: true,
      loginItemPrompted: true,
      hotkey: "Alt+Shift+Space",
      panelPosition: null,
      launchAtLogin: false,
      lastTab: "direction",
    }),
    "utf8",
  );
}

async function launchApp(
  userDataDir: string,
  callLogDir: string,
): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_DEBUG: "1",
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

// Read the newest *.json CallLog in the dir, polling until `direction` is set.
async function waitForNewestCallLog(
  callLogDir: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    let names: string[] = [];
    try {
      names = (await fs.readdir(callLogDir)).filter((n) => n.endsWith(".json"));
    } catch {
      names = [];
    }
    if (names.length > 0) {
      names.sort();
      const newest = names[names.length - 1];
      try {
        const raw = await fs.readFile(path.join(callLogDir, newest), "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        last = parsed;
        if (typeof parsed.direction === "string") return parsed;
      } catch {
        // file may be mid-write; retry
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (last) return last;
  throw new Error("no CallLog json written within deadline");
}

test("ephemeral direction: empty on launch, reaches call, not persisted", async () => {
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "prompty-e2e-ephemeral-dir-"),
  );
  const callLogDir = path.join(userDataDir, "calls");
  await fs.mkdir(callLogDir, { recursive: true });
  await seedSettings(userDataDir);

  const UNIQUE_DIRECTION = `Ephemeral brief ${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}: probe pricing objections head-on.`;

  // ===== Launch 1 =====
  let app = await launchApp(userDataDir, callLogDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    const textarea = page.getByTestId("playground-direction");
    await expect(textarea).toBeVisible();

    // --- Criterion 1: EMPTY ON LAUNCH
    const initialValue = await textarea.inputValue();
    console.log("LAUNCH-1 textarea value:", JSON.stringify(initialValue));
    expect(initialValue).toBe("");

    // --- Criterion 2: DIRECTION REACHES THE CALL
    await textarea.fill(UNIQUE_DIRECTION);
    await page.getByTestId("playground-start").click();

    // Wait for live state: Start button gone, End button present.
    await expect(page.getByTestId("playground-end")).toBeVisible({
      timeout: 15_000,
    });

    // End the call.
    await page.getByTestId("playground-end").click();

    // Wait for the call to finish (button returns to Start), then read the log.
    await expect(page.getByTestId("playground-start")).toBeVisible({
      timeout: 30_000,
    });

    const log = await waitForNewestCallLog(callLogDir);
    console.log("CALLLOG direction:", JSON.stringify(log.direction));
    expect(log.direction).toBe(UNIQUE_DIRECTION);
  } finally {
    await app.close();
  }

  // ===== Launch 2: relaunch, SAME userDataDir =====
  app = await launchApp(userDataDir, callLogDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    const textarea = page.getByTestId("playground-direction");
    await expect(textarea).toBeVisible();

    // --- Criterion 3: NO PERSISTENCE ACROSS RELAUNCH
    const relaunchValue = await textarea.inputValue();
    console.log("LAUNCH-2 textarea value:", JSON.stringify(relaunchValue));
    expect(relaunchValue).toBe("");
  } finally {
    await app.close();
  }
});
