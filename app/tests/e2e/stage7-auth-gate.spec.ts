import { test, expect, _electron as electron, ElectronApplication } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// Phase C (RUBY_AUTH_RELAY_PLAN.md): preflight auth-gating.
//   - signed-out (forced) blocks call start with code "auth", no overlay.
//   - a seeded google-session.bin is detected by the real app as signed-in.
// Real Google is never contacted: the block path uses the forced-preflight
// seam, and the signed-in path injects a session file via google-auth's
// plaintext read fallback (no safeStorage / Google round-trip).

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-authgate-"));
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

// google-auth's readSession() tries safeStorage.decryptString first, then falls
// back to plaintext — so a plaintext file is a launch-independent seam.
async function seedGoogleSession(userDataDir: string): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, "google-session.bin"),
    JSON.stringify({
      accessToken: "seed-access",
      refreshToken: "seed-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      sub: "seed-sub-123",
      email: "seed@example.com",
      idToken: "seed-id-token",
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

async function startSession(app: ElectronApplication): Promise<{ ok: boolean; error?: string }> {
  return (await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { startSession: () => Promise<{ ok: boolean; error?: string }> };
    }).__prompty_e2e;
    return h.startSession();
  })) as { ok: boolean; error?: string };
}

async function authStatus(
  app: ElectronApplication,
): Promise<{ signedIn: boolean; userId?: string; email?: string }> {
  return (await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { authStatus: () => Promise<{ signedIn: boolean; userId?: string; email?: string }> };
    }).__prompty_e2e;
    return h.authStatus();
  })) as { signedIn: boolean; userId?: string; email?: string };
}

function overlayVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isVisible() && w.webContents.getURL().includes("overlay"),
    ),
  );
}

test("signed-out blocks call start with code 'auth' and opens no overlay", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  // Force the auth preflight failure (the forced check runs before the E2E/mock
  // bypass), simulating a signed-out user trying to start.
  const app = await launchApp(userDataDir, { PROMPTY_E2E_FORCE_PREFLIGHT: "auth" });
  try {
    await waitForReady(app);
    const res = await startSession(app);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("auth");
    // No overlay should appear for a blocked start.
    await new Promise((r) => setTimeout(r, 1000));
    expect(await overlayVisible(app)).toBe(false);
  } finally {
    await app.close();
  }
});

test("a seeded Google session is detected as signed-in", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  await seedGoogleSession(userDataDir);
  const app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    const status = await authStatus(app);
    expect(status.signedIn).toBe(true);
    expect(status.email).toBe("seed@example.com");
    expect(status.userId).toBe("seed-sub-123");
  } finally {
    await app.close();
  }
});
