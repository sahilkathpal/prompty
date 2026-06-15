import { test, expect, _electron as electron, ElectronApplication } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// S6 verification: a clean start (mocks, no forced failure) opens the overlay.
// (The parametrized preflight-failure cases asserted removed mic/auth/claude
// banner UI and were dropped in the Ruby MVP rebuild.)

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
      onboardingCompleted: true,
      loginItemPrompted: true,
      lastTab: "in-call",
    }),
    "utf8",
  );
}

async function launchApp(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
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

function overlayVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isVisible() && w.webContents.getURL().includes("overlay"),
    ),
  );
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
