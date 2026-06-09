import { test, expect, _electron as electron, ElectronApplication } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// S1 verification: the legacy inverted `focusMode` flag migrates to `headsUpBar`
// with flipped polarity (focusMode=false ⇒ headsUpBar=true), the legacy key is
// dropped, and a settings file with neither key defaults to headsUpBar=true.

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-migrate-"));
}

async function seedSettingsRaw(
  userDataDir: string,
  raw: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  const file = path.join(userDataDir, "prompty-settings.json");
  await fs.writeFile(file, JSON.stringify(raw, null, 2), "utf8");
}

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
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

async function readSettings(app: ElectronApplication): Promise<Record<string, unknown>> {
  await waitForReady(app);
  return (await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e?: { getSettings: () => Record<string, unknown> };
    }).__prompty_e2e;
    if (!h) throw new Error("__prompty_e2e bridge not yet registered");
    return h.getSettings();
  })) as Record<string, unknown>;
}

const BASE = {
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

test("legacy focusMode=false migrates to headsUpBar=true and drops focusMode", async () => {
  const dir = await freshUserDataDir();
  // Old shape: includes the now-removed `compact` and inverted `focusMode`.
  await seedSettingsRaw(dir, { ...BASE, compact: false, focusMode: false });
  const app = await launchApp(dir);
  try {
    const s = await readSettings(app);
    expect(s.headsUpBar).toBe(true);
    expect("focusMode" in s).toBe(false);
    expect("compact" in s).toBe(false);
    // Unrelated settings preserved.
    expect(s.signedInEmail).toBe("alice@example.com");
  } finally {
    await app.close();
  }
});

test("legacy focusMode=true migrates to headsUpBar=false", async () => {
  const dir = await freshUserDataDir();
  await seedSettingsRaw(dir, { ...BASE, compact: false, focusMode: true });
  const app = await launchApp(dir);
  try {
    const s = await readSettings(app);
    expect(s.headsUpBar).toBe(false);
    expect("focusMode" in s).toBe(false);
  } finally {
    await app.close();
  }
});

test("settings with neither focusMode nor headsUpBar default to headsUpBar=true", async () => {
  const dir = await freshUserDataDir();
  await seedSettingsRaw(dir, { ...BASE });
  const app = await launchApp(dir);
  try {
    const s = await readSettings(app);
    expect(s.headsUpBar).toBe(true);
  } finally {
    await app.close();
  }
});
