import { test, expect, _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-stage2-"));
}

interface SeedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  sub: string;
  email: string;
  idToken?: string;
}

async function seedSession(userDataDir: string, session: SeedSession): Promise<void> {
  // Write the session file as plaintext JSON. google-auth's readSession()
  // tries decryptString first, then falls back to plaintext on failure.
  // Writing plaintext side-steps needing access to safeStorage before launch.
  const file = path.join(userDataDir, "google-session.bin");
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(session), "utf8");
}

async function seedSettings(userDataDir: string, signedIn: boolean, email: string | null, userId: string | null): Promise<void> {
  // electron-store writes <name>.json under userData.
  const file = path.join(userDataDir, "prompty-settings.json");
  await fs.mkdir(userDataDir, { recursive: true });
  const settings = {
    compact: false,
    panelPosition: null,
    launchAtLogin: false,
    hotkey: "Alt+Shift+Space",
    signedIn,
    onboardingCompleted: true,
    loginItemPrompted: true,
    signedInUserId: userId,
    signedInEmail: email,
    lastTab: "settings",
  };
  await fs.writeFile(file, JSON.stringify(settings, null, 2), "utf8");
}

async function launchApp(userDataDir: string, extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      NODE_ENV: "development",
      ...extraEnv,
    },
  });
}

async function getMainPage(app: ElectronApplication): Promise<Page> {
  await app.evaluate(async () => {
    const handles = (globalThis as unknown as {
      __prompty_e2e: { openMainWindow: (tab: string) => void };
    }).__prompty_e2e;
    handles.openMainWindow("settings");
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pages = app.windows();
    const candidate = pages.find((p) => p.url().includes("main-window"));
    if (candidate) {
      await candidate.waitForSelector('[data-testid="main-window-root"]', { timeout: 10_000 });
      return candidate;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("main window not found");
}

test("Stage 2: signed-in state propagates to Settings tab", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSession(userDataDir, {
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    expiresAt: Date.now() + 60 * 60 * 1000,
    sub: "google-sub-abc",
    email: "alice@example.com",
    idToken: "fake-id-token",
  });
  await seedSettings(userDataDir, true, "alice@example.com", "google-sub-abc");

  const app = await launchApp(userDataDir);
  try {
    await app.evaluate(async ({ app: electronApp }) => {
      if (!electronApp.isReady()) {
        await new Promise<void>((resolve) => electronApp.once("ready", () => resolve()));
      }
    });

    const page = await getMainPage(app);
    await page.click('[data-testid="topbar-settings"]');
    await page.waitForSelector('[data-testid="settings-account-status"]');
    const statusText = await page.textContent('[data-testid="settings-account-status"]');
    expect(statusText).toContain("alice@example.com");
    await page.waitForSelector('[data-testid="settings-sign-out"]');
  } finally {
    await app.close();
  }
});

test("Stage 2: sign out clears state", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSession(userDataDir, {
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    expiresAt: Date.now() + 60 * 60 * 1000,
    sub: "google-sub-abc",
    email: "alice@example.com",
    idToken: "fake-id-token",
  });
  await seedSettings(userDataDir, true, "alice@example.com", "google-sub-abc");

  const app = await launchApp(userDataDir);
  try {
    await app.evaluate(async ({ app: electronApp }) => {
      if (!electronApp.isReady()) {
        await new Promise<void>((resolve) => electronApp.once("ready", () => resolve()));
      }
    });

    const page = await getMainPage(app);
    await page.click('[data-testid="topbar-settings"]');
    await page.waitForSelector('[data-testid="settings-sign-out"]');
    await page.click('[data-testid="settings-sign-out"]');
    // After sign-out, we expect the sign-in button to appear.
    await page.waitForSelector('[data-testid="settings-sign-in"]', { timeout: 5_000 });
    const statusText = await page.textContent('[data-testid="settings-account-status"]');
    expect(statusText).not.toContain("alice@example.com");
    expect(statusText).toMatch(/not signed in/i);
  } finally {
    await app.close();
  }
});

test("Stage 2: calendar arm fires notification for fake event", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSession(userDataDir, {
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    expiresAt: Date.now() + 60 * 60 * 1000,
    sub: "google-sub-abc",
    email: "alice@example.com",
    idToken: "fake-id-token",
  });
  await seedSettings(userDataDir, true, "alice@example.com", "google-sub-abc");

  const app = await launchApp(userDataDir, { PROMPTY_E2E_FAKE_EVENT: "1" });
  try {
    await app.evaluate(async ({ app: electronApp }) => {
      if (!electronApp.isReady()) {
        await new Promise<void>((resolve) => electronApp.once("ready", () => resolve()));
      }
    });

    // Trigger a calendar arm poll directly instead of waiting 60s.
    await app.evaluate(async () => {
      const handles = (globalThis as unknown as {
        __prompty_e2e: { pollCalendarArm: () => Promise<void> };
      }).__prompty_e2e;
      await handles.pollCalendarArm();
    });

    // Give the notification a tick to fire.
    await new Promise((r) => setTimeout(r, 500));

    const notifications = await app.evaluate(() => {
      const handles = (globalThis as unknown as {
        __prompty_e2e: { getE2ENotifications: () => { title: string; body: string }[] };
      }).__prompty_e2e;
      return handles.getE2ENotifications();
    });
    expect(notifications.length).toBeGreaterThan(0);
    const titles = notifications.map((n) => n.title).join(" | ");
    expect(titles).toMatch(/Discovery call with Alex Chen|Ready for/);
    const bodies = notifications.map((n) => n.body).join(" | ");
    expect(bodies).toMatch(/click to start/i);
  } finally {
    await app.close();
  }
});
