import { test, expect, _electron as electron, ElectronApplication } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// S2 verification: both in-call windows have content protection on (set-only;
// the meaningful regression guard is that they remain *locally* visible) and
// the tray "End session" path ends the session + writes a log.

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-hardening-"));
}
async function freshCallLogDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-hardening-calls-"));
}

async function seedSettings(userDataDir: string): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  const settings = {
    panelPosition: null,
    launchAtLogin: false,
    hotkey: "Alt+Shift+Space",
    signedIn: true,
    onboardingCompleted: true,
    loginItemPrompted: true,
    signedInUserId: "google-sub-abc",
    signedInEmail: "alice@example.com",
    lastTab: "in-call",
    headsUpBar: true,
  };
  await fs.writeFile(
    path.join(userDataDir, "prompty-settings.json"),
    JSON.stringify(settings, null, 2),
    "utf8",
  );
}

async function seedSession(userDataDir: string): Promise<void> {
  await fs.writeFile(
    path.join(userDataDir, "google-session.bin"),
    JSON.stringify({
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: Date.now() + 3_600_000,
      sub: "google-sub-abc",
      email: "alice@example.com",
      idToken: "fake-id-token",
    }),
    "utf8",
  );
}

async function launchApp(
  userDataDir: string,
  extraEnv: Record<string, string> = {},
): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      PROMPTY_MOCK_AGENT: "1",
      NODE_ENV: "development",
      ...extraEnv,
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

function windowVisible(app: ElectronApplication, urlPart: string): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }, part) => {
    return BrowserWindow.getAllWindows().some((w) => {
      if (w.isDestroyed() || !w.isVisible()) return false;
      return w.webContents.getURL().includes(part);
    });
  }, urlPart);
}

async function waitVisible(app: ElectronApplication, urlPart: string, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await windowVisible(app, urlPart)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function waitHidden(app: ElectronApplication, urlPart: string, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await windowVisible(app, urlPart))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function startSession(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { startSession: () => Promise<unknown> };
    }).__prompty_e2e;
    await h.startSession();
  });
}

test("Stage 2: content protection keeps overlay + teleprompter locally visible", async () => {
  const userDataDir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir, { PROMPTY_CALL_LOG_DIR: callLogDir });
  try {
    await waitForReady(app);
    await startSession(app);
    // Both windows must still be visible locally despite setContentProtection(true).
    expect(await waitVisible(app, "overlay")).toBe(true);
    // headsUpBar defaults true → the teleprompter is shown.
    expect(await waitVisible(app, "teleprompter")).toBe(true);

    // Sanity: both windows actually have content protection enabled. There is no
    // public getter, so assert the windows exist and visibility (the regression
    // we care about) holds; the set call is exercised at creation time.
    const windowCount = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter(
        (w) =>
          !w.isDestroyed() &&
          (w.webContents.getURL().includes("overlay") ||
            w.webContents.getURL().includes("teleprompter")),
      ).length,
    );
    expect(windowCount).toBeGreaterThanOrEqual(2);
  } finally {
    await app.close();
  }
});

test("Stage 2: tray End session ends the session, hides overlay, writes log", async () => {
  const userDataDir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir, { PROMPTY_CALL_LOG_DIR: callLogDir });
  try {
    await waitForReady(app);
    await startSession(app);
    expect(await waitVisible(app, "overlay")).toBe(true);

    // Invoke the exact function the tray "End session" item calls.
    await app.evaluate(async () => {
      const h = (globalThis as unknown as {
        __prompty_e2e: { trayEndSession: () => Promise<unknown> };
      }).__prompty_e2e;
      await h.trayEndSession();
    });

    expect(await waitHidden(app, "overlay")).toBe(true);
    expect(await waitHidden(app, "teleprompter")).toBe(true);
    const files = await fs.readdir(callLogDir);
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
  } finally {
    await app.close();
  }
});
