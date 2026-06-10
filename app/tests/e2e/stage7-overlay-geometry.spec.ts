import { test, expect, _electron as electron, ElectronApplication } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// Feedback round 2 — the overlay must be glanceable (roomier default) and
// resizable, with the chosen size persisted across sessions.

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-geom-"));
}
async function freshCallLogDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-geom-calls-"));
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

async function launchApp(userDataDir: string, callLogDir: string): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      PROMPTY_MOCK_AGENT: "1",
      PROMPTY_NO_AUDIO_MS: "60000",
      PROMPTY_CALL_LOG_DIR: callLogDir,
      NODE_ENV: "development",
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

interface OverlayGeom {
  width: number;
  height: number;
  resizable: boolean;
  minWidth: number;
  minHeight: number;
}

async function waitOverlayGeom(app: ElectronApplication, ms = 10_000): Promise<OverlayGeom> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const g = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find(
        (win) => !win.isDestroyed() && win.webContents.getURL().includes("overlay"),
      );
      if (!w) return null;
      const [width, height] = w.getSize();
      const [minWidth, minHeight] = w.getMinimumSize();
      return { width, height, resizable: w.isResizable(), minWidth, minHeight };
    });
    if (g) return g as OverlayGeom;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("overlay window not found");
}

async function getSettings(app: ElectronApplication): Promise<Record<string, unknown>> {
  return (await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { getSettings: () => Record<string, unknown> };
    }).__prompty_e2e;
    return h.getSettings();
  })) as Record<string, unknown>;
}

test("overlay opens at a roomy default size and is resizable", async () => {
  const dir = await freshUserDataDir();
  const calls = await freshCallLogDir();
  await seedSettings(dir);
  await seedSession(dir);
  const app = await launchApp(dir, calls);
  try {
    await waitForReady(app);
    await startSession(app);
    const g = await waitOverlayGeom(app);
    expect(g.resizable).toBe(true);
    // Bigger than the cramped 240×420 it used to be.
    expect(g.width).toBeGreaterThanOrEqual(300);
    expect(g.height).toBeGreaterThanOrEqual(520);
    // Minimum bounds keep it usable when shrunk.
    expect(g.minWidth).toBeGreaterThanOrEqual(200);
    expect(g.minHeight).toBeGreaterThanOrEqual(300);
  } finally {
    await app.close();
  }
});

test("a resized overlay persists its size across restarts", async () => {
  const dir = await freshUserDataDir();
  const calls = await freshCallLogDir();
  await seedSettings(dir);
  await seedSession(dir);

  // First run: resize the overlay, confirm the new size is persisted.
  const app1 = await launchApp(dir, calls);
  try {
    await waitForReady(app1);
    await startSession(app1);
    await waitOverlayGeom(app1);
    await app1.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find(
        (win) => !win.isDestroyed() && win.webContents.getURL().includes("overlay"),
      );
      w?.setSize(400, 640);
    });
    // Let the resize event fire and persist.
    await new Promise((r) => setTimeout(r, 400));
    const s = await getSettings(app1);
    expect(s.panelSize).toEqual({ width: 400, height: 640 });
  } finally {
    await app1.close();
  }

  // Second run with the SAME user data dir: overlay restores the saved size.
  const app2 = await launchApp(dir, calls);
  try {
    await waitForReady(app2);
    await startSession(app2);
    const g = await waitOverlayGeom(app2);
    expect(g.width).toBe(400);
    expect(g.height).toBe(640);
  } finally {
    await app2.close();
  }
});
