import { test, expect, _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// Feedback round 3 (#7) — the overlay auto-resizes its HEIGHT when the heads-up
// bar is toggled: showing the sticky-note feed grows the window enough to reveal
// it (without shrinking a height the user dragged taller); hiding the feed snaps
// the height back down so there's no wasted space. Width is never touched.

const APP_ROOT = path.resolve(__dirname, "../..");
const HEADSUP = '[data-testid="overlay-headsup-toggle"]';
const FEED = '[data-testid="overlay-nudge-feed"]';

// A very long nudge so the sticky note wraps to many lines — the feed must be
// tall enough that the grown height clears the window's minimum (360px) by a
// wide margin, so the grow is unambiguously observable.
const LONG = (
  "Ask them what specifically broke during the cloud VM setup, how long they " +
  "spent before giving up, what workaround they reached for, and whether the " +
  "same failure has happened on other machines or only this one environment. "
).repeat(4).trim();

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-autoresize-"));
}
async function freshCallLogDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-autoresize-calls-"));
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

async function getOverlayPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const p = app.windows().find((pg) => pg.url().includes("overlay"));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("overlay page not found");
}

let seq = 0;
async function emit(app: ElectronApplication, text: string): Promise<void> {
  const nudge = { id: `n${seq++}`, kind: "info", urgency: "medium", text, createdAt: Date.now() };
  await app.evaluate(async (_electron, n) => {
    (globalThis as unknown as { __prompty_e2e: { emitNudge: (x: unknown) => boolean } }).__prompty_e2e.emitNudge(n);
  }, nudge);
}

interface Size { width: number; height: number }

async function overlaySize(app: ElectronApplication): Promise<Size | null> {
  return (await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.getURL().includes("overlay"),
    );
    if (!w) return null;
    const [width, height] = w.getSize();
    return { width, height };
  })) as Size | null;
}

async function waitOverlaySize(app: ElectronApplication): Promise<Size> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const s = await overlaySize(app);
    if (s) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("overlay window not found");
}

// Simulate a manual drag-resize of the overlay height.
async function manualResizeHeight(app: ElectronApplication, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, h) => {
    const w = BrowserWindow.getAllWindows().find(
      (win) => !win.isDestroyed() && win.webContents.getURL().includes("overlay"),
    );
    if (w) {
      const [width] = w.getSize();
      w.setSize(width, h as number);
    }
  }, height);
}

// Poll until the overlay height moves in the expected direction relative to a
// baseline, or time out and return the last observed size.
async function waitHeight(
  app: ElectronApplication,
  baseline: number,
  dir: "increase" | "decrease",
): Promise<Size> {
  const deadline = Date.now() + 5000;
  let last = await waitOverlaySize(app);
  while (Date.now() < deadline) {
    last = await waitOverlaySize(app);
    if (dir === "increase" && last.height > baseline) return last;
    if (dir === "decrease" && last.height < baseline) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("toggling the feed on grows the height to reveal it, toggling off snaps it down", async () => {
  const dir = await freshUserDataDir();
  const calls = await freshCallLogDir();
  await seedSettings(dir, true); // heads-up ON → feed hidden initially
  await seedSession(dir);
  const app = await launchApp(dir, calls);
  try {
    await waitForReady(app);
    await startSession(app);
    const overlay = await getOverlayPage(app);
    await overlay.waitForSelector('[data-testid="overlay-root"]');

    // Shrink to the floor so the grow is observable, and give the feed a tall note.
    await manualResizeHeight(app, 360);
    await emit(app, LONG);
    await sleep(400);
    const hidden = await waitOverlaySize(app); // feed hidden, ~360

    // Toggle → feed shown → height grows to reveal the sticky note.
    await overlay.click(HEADSUP);
    await overlay.waitForSelector(FEED);
    const shown = await waitHeight(app, hidden.height, "increase");
    expect(shown.height).toBeGreaterThan(hidden.height);
    expect(shown.width).toBe(hidden.width); // width never touched

    // Toggle back → feed hidden → height snaps down (no wasted space).
    await overlay.click(HEADSUP);
    await overlay.waitForSelector(FEED, { state: "detached" });
    const reclosed = await waitHeight(app, shown.height, "decrease");
    expect(reclosed.height).toBeLessThan(shown.height);
    expect(reclosed.width).toBe(shown.width);
  } finally {
    await app.close();
  }
});

test("growing never shrinks a manually-taller height; hiding the feed still snaps down", async () => {
  const dir = await freshUserDataDir();
  const calls = await freshCallLogDir();
  await seedSettings(dir, false); // heads-up OFF → feed shown
  await seedSession(dir);
  const app = await launchApp(dir, calls);
  try {
    await waitForReady(app);
    await startSession(app);
    const overlay = await getOverlayPage(app);
    await overlay.waitForSelector(FEED);

    // Drag it taller than the content needs (no pre-grow, so 640 is purely the
    // manual height we're checking is preserved).
    await manualResizeHeight(app, 640);
    await sleep(300);
    const tall = await waitOverlaySize(app);
    expect(tall.height).toBe(640);

    // A new nudge triggers a grow-fit — it must NOT shrink the manual height.
    await emit(app, "another short prompt");
    await sleep(500);
    const afterNudge = await waitOverlaySize(app);
    expect(afterNudge.height).toBe(640);

    // Hiding the feed snaps the height down below the manual-tall height.
    await overlay.click(HEADSUP);
    await overlay.waitForSelector(FEED, { state: "detached" });
    const snapped = await waitHeight(app, tall.height, "decrease");
    expect(snapped.height).toBeLessThan(tall.height);
  } finally {
    await app.close();
  }
});
