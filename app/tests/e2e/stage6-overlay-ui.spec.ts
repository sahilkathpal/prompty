import { test, expect, _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// S4 verification: the overlay renders a live status dot, a "What should I ask?"
// button wired to the nudge path, and the headsUpBar split (ON → teleprompter +
// no in-overlay feed; OFF → in-overlay NudgeFeed + no teleprompter), including a
// mid-session toggle.

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-overlayui-"));
}
async function freshCallLogDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-overlayui-calls-"));
}

async function seedSettings(userDataDir: string, headsUpBar: boolean): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, "prompty-settings.json"),
    JSON.stringify({
      panelPosition: null,
      launchAtLogin: false,
      hotkey: "Alt+Shift+Space",
      signedIn: true,
      onboardingCompleted: true,
      loginItemPrompted: true,
      signedInUserId: "google-sub-abc",
      signedInEmail: "alice@example.com",
      lastTab: "in-call",
      headsUpBar,
    }),
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
      PROMPTY_NO_AUDIO_MS: "60000",
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

async function startSession(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { startSession: () => Promise<unknown> };
    }).__prompty_e2e;
    await h.startSession();
  });
}

async function injectUtterance(app: ElectronApplication, text: string): Promise<void> {
  // electronApplication.evaluate passes the electron module first, our arg second.
  await app.evaluate(async (_electron, t) => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { injectUtterance: (u: unknown) => boolean };
    }).__prompty_e2e;
    h.injectUtterance({ speaker: "them", text: t, startMs: 0, endMs: 0, isFinal: true });
  }, text);
}

async function getOverlayPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const p = app.windows().find((pg) => pg.url().includes("overlay"));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("overlay page not found");
}

function teleprompterVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isVisible() && w.webContents.getURL().includes("teleprompter"),
    ),
  );
}

async function waitTeleprompter(app: ElectronApplication, want: boolean, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await teleprompterVisible(app)) === want) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test("Stage 4: status dot reaches Listening (green) once audio flows", async () => {
  const dir = await freshUserDataDir();
  const calls = await freshCallLogDir();
  await seedSettings(dir, true);
  await seedSession(dir);
  const app = await launchApp(dir, { PROMPTY_CALL_LOG_DIR: calls });
  try {
    await waitForReady(app);
    await startSession(app);
    const overlay = await getOverlayPage(app);
    await overlay.waitForSelector('[data-testid="overlay-root"]');
    await injectUtterance(app, "hello, how are you");
    const label = overlay.locator('[data-testid="overlay-status-label"]');
    await expect(label).toHaveText("Listening", { timeout: 8000 });
    await expect(overlay.locator('[data-testid="overlay-status-dot"]')).toHaveAttribute(
      "data-tone",
      "green",
    );
  } finally {
    await app.close();
  }
});

test("Stage 4: 'What should I ask?' button produces a nudge in the overlay feed", async () => {
  const dir = await freshUserDataDir();
  const calls = await freshCallLogDir();
  // headsUpBar OFF → nudges land in the in-overlay feed where we can assert them.
  await seedSettings(dir, false);
  await seedSession(dir);
  const app = await launchApp(dir, { PROMPTY_CALL_LOG_DIR: calls });
  try {
    await waitForReady(app);
    await startSession(app);
    const overlay = await getOverlayPage(app);
    await overlay.waitForSelector('[data-testid="overlay-nudge-feed"]');
    await overlay.click('[data-testid="overlay-ask"]');
    // The mock agent emits a nudge on requestNudge (trigger=hotkey).
    await expect(overlay.locator('[data-testid="overlay-nudge-feed"]')).toContainText(
      "Mock nudge",
      { timeout: 8000 },
    );
  } finally {
    await app.close();
  }
});

test("Stage 4: headsUpBar OFF shows in-overlay feed and hides the teleprompter", async () => {
  const dir = await freshUserDataDir();
  const calls = await freshCallLogDir();
  await seedSettings(dir, false);
  await seedSession(dir);
  const app = await launchApp(dir, { PROMPTY_CALL_LOG_DIR: calls });
  try {
    await waitForReady(app);
    await startSession(app);
    const overlay = await getOverlayPage(app);
    await expect(overlay.locator('[data-testid="overlay-nudge-feed"]')).toHaveCount(1);
    expect(await waitTeleprompter(app, false)).toBe(true);
  } finally {
    await app.close();
  }
});

test("Stage 4: headsUpBar ON shows teleprompter and no in-overlay feed", async () => {
  const dir = await freshUserDataDir();
  const calls = await freshCallLogDir();
  await seedSettings(dir, true);
  await seedSession(dir);
  const app = await launchApp(dir, { PROMPTY_CALL_LOG_DIR: calls });
  try {
    await waitForReady(app);
    await startSession(app);
    const overlay = await getOverlayPage(app);
    await overlay.waitForSelector('[data-testid="overlay-root"]');
    await expect(overlay.locator('[data-testid="overlay-nudge-feed"]')).toHaveCount(0);
    expect(await waitTeleprompter(app, true)).toBe(true);
  } finally {
    await app.close();
  }
});

test("Stage 4: toggling the heads-up-bar mid-session flips feed/bar", async () => {
  const dir = await freshUserDataDir();
  const calls = await freshCallLogDir();
  await seedSettings(dir, true); // start ON: bar shown, no feed
  await seedSession(dir);
  const app = await launchApp(dir, { PROMPTY_CALL_LOG_DIR: calls });
  try {
    await waitForReady(app);
    await startSession(app);
    const overlay = await getOverlayPage(app);
    await overlay.waitForSelector('[data-testid="overlay-root"]');
    await expect(overlay.locator('[data-testid="overlay-nudge-feed"]')).toHaveCount(0);
    expect(await waitTeleprompter(app, true)).toBe(true);

    // Toggle OFF → feed appears, teleprompter hides.
    await overlay.click('[data-testid="overlay-headsup-toggle"]');
    await expect(overlay.locator('[data-testid="overlay-nudge-feed"]')).toHaveCount(1);
    expect(await waitTeleprompter(app, false)).toBe(true);
  } finally {
    await app.close();
  }
});
