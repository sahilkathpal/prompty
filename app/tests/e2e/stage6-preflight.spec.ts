import { test, expect, _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// S6 verification: a start attempt that fails pre-flight (mic / auth / claude)
// must NOT open a dead overlay — it surfaces an actionable banner in the main
// window. A clean start (mocks, no forced failure) still opens the overlay.

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-preflight-"));
}
async function freshCallLogDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-preflight-calls-"));
}

async function seedSettings(userDataDir: string): Promise<void> {
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
      headsUpBar: true,
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

async function launchApp(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  const userDataDir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);
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

async function startSession(app: ElectronApplication): Promise<{ ok: boolean; error?: string }> {
  return (await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { startSession: () => Promise<{ ok: boolean; error?: string }> };
    }).__prompty_e2e;
    return h.startSession();
  })) as { ok: boolean; error?: string };
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

function overlayVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isVisible() && w.webContents.getURL().includes("overlay"),
    ),
  );
}

async function overlayStaysHidden(app: ElectronApplication, ms = 1500): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await overlayVisible(app)) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return true;
}

const CASES: { code: "mic" | "auth" | "claude"; action: string }[] = [
  { code: "mic", action: "preflight-grant-mic" },
  { code: "auth", action: "preflight-sign-in" },
  { code: "claude", action: "preflight-install-claude" },
];

for (const c of CASES) {
  test(`Stage 6: preflight '${c.code}' failure blocks start and shows the banner`, async () => {
    const app = await launchApp({ PROMPTY_E2E_FORCE_PREFLIGHT: c.code });
    try {
      await waitForReady(app);
      const res = await startSession(app);
      expect(res.ok).toBe(false);
      expect(res.error).toBe(c.code);

      // The main window opens and shows the actionable banner (via preflight:get
      // on mount and/or the preflight:failed broadcast).
      const main = await getMainPage(app);
      const banner = main.locator('[data-testid="preflight-error"]');
      await expect(banner).toBeVisible({ timeout: 8000 });
      await expect(banner).toHaveAttribute("data-code", c.code);
      await expect(main.locator(`[data-testid="${c.action}"]`)).toBeVisible();

      // No dead overlay.
      expect(await overlayStaysHidden(app)).toBe(true);
    } finally {
      await app.close();
    }
  });
}

test("Stage 6: a clean start (mocks, no forced failure) opens the overlay", async () => {
  const app = await launchApp();
  try {
    await waitForReady(app);
    const res = await startSession(app);
    expect(res.ok).toBe(true);
    // Overlay opens (preflight bypassed under E2E/mock).
    const deadline = Date.now() + 8000;
    let visible = false;
    while (Date.now() < deadline) {
      if (await overlayVisible(app)) {
        visible = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(visible).toBe(true);
  } finally {
    await app.close();
  }
});
