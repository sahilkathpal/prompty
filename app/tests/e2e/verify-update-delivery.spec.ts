// Regression spec for durable update delivery. Exercises the surfaces that make
// a staged update discoverable, and the safety gate on the default prompt:
//   1. A staged update reveals the tray "Restart to update" item (menu-bar badge
//      path) AND fires a discoverable "Ruby update ready" notification, and
//      captures update_downloaded.
//   2. The "update ready" prompt is SUPPRESSED while a call is live (it'd be
//      noise mid-call), but the tray item still appears so the signal isn't lost.
//   3. The opt-in "Install updates automatically" Settings toggle persists to
//      disk and survives a relaunch. (Off by default — silent auto-apply is
//      opt-in; the pure gate that governs it is unit-tested in updater-policy.)
//
// The updater is inert under E2E (no real feed), so a staged update is driven via
// the PROMPTY_E2E-only __prompty_e2e.simulateUpdateDownloaded seam.
import { test, expect, _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-verify-update-"));
}

async function launch(userDataDir: string, env: Record<string, string> = {}): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_AGENT: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      NODE_ENV: "development",
      ...env,
    },
  });
}

async function waitForReady(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: e }) => {
    if (!e.isReady()) await new Promise<void>((r) => e.once("ready", () => r()));
  });
}

async function trayLabels(app: ElectronApplication): Promise<string[]> {
  return (await app.evaluate(async () => {
    const t = (globalThis as unknown as { __prompty_tray?: { buildTrayMenuTemplate: () => { label?: string }[] } }).__prompty_tray;
    return (t?.buildTrayMenuTemplate() ?? []).map((i) => i.label ?? "");
  })) as string[];
}

async function trayItem(app: ElectronApplication, label: string): Promise<{ label: string; enabled: boolean } | null> {
  // ElectronApplication.evaluate calls the fn with (electronModule, arg) — the
  // passed arg is the SECOND param, not the first.
  return (await app.evaluate(async (_electron, want) => {
    const t = (globalThis as unknown as { __prompty_tray?: { buildTrayMenuTemplate: () => { label?: string; enabled?: boolean }[] } }).__prompty_tray;
    const it = (t?.buildTrayMenuTemplate() ?? []).find((i) => i.label === want);
    return it ? { label: it.label ?? "", enabled: it.enabled !== false } : null;
  }, label)) as { label: string; enabled: boolean } | null;
}

async function notificationTitles(app: ElectronApplication): Promise<string[]> {
  return (await app.evaluate(async () => {
    const n = (globalThis as unknown as { __prompty_e2e: { getE2ENotifications: () => { title: string }[] } }).__prompty_e2e.getE2ENotifications();
    return n.map((x) => x.title);
  })) as string[];
}

async function simulateUpdate(app: ElectronApplication, version: string): Promise<void> {
  await app.evaluate(async (_electron, v) => {
    (globalThis as unknown as { __prompty_e2e: { simulateUpdateDownloaded: (ver?: string) => void } }).__prompty_e2e.simulateUpdateDownloaded(v);
  }, version);
}

async function analyticsEvents(app: ElectronApplication): Promise<string[]> {
  const evs = (await app.evaluate(async () =>
    (globalThis as unknown as { __prompty_e2e: { getAnalyticsEvents: () => { event: string }[] } }).__prompty_e2e.getAnalyticsEvents(),
  )) as { event: string }[];
  return evs.map((e) => e.event);
}

async function readSettings(app: ElectronApplication): Promise<Record<string, unknown>> {
  return (await app.evaluate(async () =>
    (globalThis as unknown as { __prompty_e2e: { getSettings: () => Record<string, unknown> } }).__prompty_e2e.getSettings(),
  )) as Record<string, unknown>;
}

async function openSettings(app: ElectronApplication): Promise<Page> {
  await app.evaluate(async () => {
    (globalThis as unknown as { __prompty_e2e: { openMainWindow: (t?: string) => void } }).__prompty_e2e.openMainWindow("settings");
  });
  for (let i = 0; i < 100; i++) {
    for (const w of app.windows()) if (w.url().includes("main-window")) return w;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("main window never appeared");
}

// ── 1. A staged update surfaces the tray item + a discoverable notification. ────
test("staged update reveals the tray item and fires an 'update ready' notification", async () => {
  const app = await launch(await freshUserDataDir());
  try {
    await waitForReady(app);
    // Before: no update staged → no "Restart to update", no notification.
    expect(await trayLabels(app)).not.toContain("Restart to update");
    expect(await notificationTitles(app)).not.toContain("Ruby update ready");

    await simulateUpdate(app, "9.9.9");

    expect(await trayLabels(app)).toContain("Restart to update");
    expect(await notificationTitles(app)).toContain("Ruby update ready");
    expect(await analyticsEvents(app)).toContain("update_downloaded");
  } finally {
    await app.close();
  }
});

// ── 2. Mid-call: the prompt is suppressed, but the tray item still appears. ─────
test("a staged update mid-call suppresses the prompt but still shows the tray item", async () => {
  const app = await launch(await freshUserDataDir());
  try {
    await waitForReady(app);
    // Start a call so a session is active.
    await app.evaluate(async () => {
      await (globalThis as unknown as { __prompty_e2e: { startSession: () => Promise<unknown> } }).__prompty_e2e.startSession();
    });

    await simulateUpdate(app, "9.9.9");

    // No "update ready" prompt while a call is live — it would be noise.
    expect(await notificationTitles(app)).not.toContain("Ruby update ready");
    // The tray item is present so the signal isn't lost — but DISABLED mid-call so
    // an explicit click can't restart out from under the live call.
    const midCall = await trayItem(app, "Restart to update");
    expect(midCall, "Restart to update item present mid-call").toBeTruthy();
    expect(midCall?.enabled, "Restart to update disabled mid-call").toBe(false);

    await app.evaluate(async () => {
      await (globalThis as unknown as { __prompty_e2e: { endSession: () => Promise<unknown> } }).__prompty_e2e.endSession();
    });
    // Once the call ends, the item re-enables.
    await expect.poll(async () => (await trayItem(app, "Restart to update"))?.enabled).toBe(true);
  } finally {
    await app.close();
  }
});

// ── 3. The opt-in auto-install toggle persists and survives a relaunch. ─────────
test("the 'install updates automatically' toggle persists across relaunch, off by default", async () => {
  const userDataDir = await freshUserDataDir();
  let app = await launch(userDataDir);
  try {
    await waitForReady(app);
    // Off by default — silent auto-apply is opt-in.
    expect((await readSettings(app)).autoInstallUpdates).toBe(false);

    const page = await openSettings(app);
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("set-auto-update-toggle").click();

    await expect.poll(async () => (await readSettings(app)).autoInstallUpdates).toBe(true);
  } finally {
    await app.close();
  }

  // Relaunch the SAME profile: the opt-in must have persisted to disk.
  app = await launch(userDataDir);
  try {
    await waitForReady(app);
    expect((await readSettings(app)).autoInstallUpdates).toBe(true);
  } finally {
    await app.close();
  }
});
