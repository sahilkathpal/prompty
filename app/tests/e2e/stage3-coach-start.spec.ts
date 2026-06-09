import { test, expect, _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-stage3-"));
}

async function freshCallLogDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-stage3-calls-"));
}

async function seedSettings(userDataDir: string): Promise<void> {
  const file = path.join(userDataDir, "prompty-settings.json");
  await fs.mkdir(userDataDir, { recursive: true });
  const settings = {
    compact: false,
    panelPosition: null,
    launchAtLogin: false,
    hotkey: "Alt+Shift+Space",
    signedIn: true,
    onboardingCompleted: true,
    loginItemPrompted: true,
    signedInUserId: "google-sub-abc",
    signedInEmail: "alice@example.com",
    lastTab: "in-call",
  };
  await fs.writeFile(file, JSON.stringify(settings, null, 2), "utf8");
}

async function seedSession(userDataDir: string): Promise<void> {
  const file = path.join(userDataDir, "google-session.bin");
  await fs.writeFile(
    file,
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

async function getMainPage(app: ElectronApplication, tab = "in-call"): Promise<Page> {
  await app.evaluate(async (_ctx, t) => {
    const handles = (globalThis as unknown as {
      __prompty_e2e: { openMainWindow: (tab: string) => void };
    }).__prompty_e2e;
    handles.openMainWindow(t);
  }, tab);
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

async function waitForReady(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: electronApp }) => {
    if (!electronApp.isReady()) {
      await new Promise<void>((resolve) => electronApp.once("ready", () => resolve()));
    }
  });
}

function overlayVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => {
    return BrowserWindow.getAllWindows().some((w) => {
      if (w.isDestroyed() || !w.isVisible()) return false;
      return w.webContents.getURL().includes("overlay");
    });
  });
}

async function waitOverlayVisible(app: ElectronApplication, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await overlayVisible(app)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function waitOverlayHidden(app: ElectronApplication, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await overlayVisible(app))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

test("Stage 3: startSession via bridge opens overlay", async () => {
  const userDataDir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir, { PROMPTY_CALL_LOG_DIR: callLogDir });
  try {
    await waitForReady(app);
    await app.evaluate(async () => {
      const h = (globalThis as unknown as {
        __prompty_e2e: { startSession: () => Promise<unknown> };
      }).__prompty_e2e;
      await h.startSession();
    });
    expect(await waitOverlayVisible(app)).toBe(true);
  } finally {
    await app.close();
  }
});

test("Stage 3: Injected utterance produces nudge (persisted in call log)", async () => {
  const userDataDir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir, { PROMPTY_CALL_LOG_DIR: callLogDir });
  try {
    await waitForReady(app);
    await app.evaluate(async () => {
      const h = (globalThis as unknown as {
        __prompty_e2e: {
          startSession: () => Promise<unknown>;
          injectUtterance: (u: unknown) => boolean;
        };
      }).__prompty_e2e;
      await h.startSession();
      h.injectUtterance({
        speaker: "them",
        text: "We've got about 8 brokers and a 5 person team.",
        startMs: 0,
        endMs: 0,
        isFinal: true,
      });
    });
    // Give the (mock) agent a moment to fire.
    await new Promise((r) => setTimeout(r, 1500));
    await app.evaluate(async () => {
      const h = (globalThis as unknown as {
        __prompty_e2e: { endSession: () => Promise<unknown> };
      }).__prompty_e2e;
      await h.endSession();
    });
    // Poll for the persisted call log and check it contains the mock nudge.
    const deadline = Date.now() + 10_000;
    let sawNudge = false;
    while (Date.now() < deadline) {
      const files = await fs.readdir(callLogDir).catch(() => []);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const body = await fs.readFile(path.join(callLogDir, f), "utf8");
        if (/Mock nudge/i.test(body)) {
          sawNudge = true;
          break;
        }
      }
      if (sawNudge) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sawNudge).toBe(true);
  } finally {
    await app.close();
  }
});

test("Stage 3: endSession hides overlay and writes log", async () => {
  const userDataDir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir, { PROMPTY_CALL_LOG_DIR: callLogDir });
  try {
    await waitForReady(app);
    await app.evaluate(async () => {
      const h = (globalThis as unknown as {
        __prompty_e2e: { startSession: () => Promise<unknown> };
      }).__prompty_e2e;
      await h.startSession();
    });
    expect(await waitOverlayVisible(app)).toBe(true);
    await app.evaluate(async () => {
      const h = (globalThis as unknown as {
        __prompty_e2e: { endSession: () => Promise<unknown> };
      }).__prompty_e2e;
      await h.endSession();
    });
    expect(await waitOverlayHidden(app)).toBe(true);
    // A log file was written.
    const files = await fs.readdir(callLogDir);
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
  } finally {
    await app.close();
  }
});

test("Stage 3: Armed event Run-the-call starts a session", async () => {
  const userDataDir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir, {
    PROMPTY_CALL_LOG_DIR: callLogDir,
    PROMPTY_E2E_FAKE_EVENT: "1",
  });
  try {
    await waitForReady(app);
    await app.evaluate(async () => {
      const h = (globalThis as unknown as {
        __prompty_e2e: { pollCalendarArm: () => Promise<void> };
      }).__prompty_e2e;
      await h.pollCalendarArm();
    });

    const page = await getMainPage(app, "prep");
    await page.waitForSelector('[data-testid="armed-event-card"]', { timeout: 10_000 });
    await page.click('[data-testid="armed-event-start-now"]');
    expect(await waitOverlayVisible(app)).toBe(true);
  } finally {
    await app.close();
  }
});
