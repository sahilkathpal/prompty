import { test, expect, _electron as electron, ElectronApplication } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// S3 verification: the coach session emits session:status events driven by real
// signals — "starting" → "listening" (on audio) → "no-audio" (silence gap) →
// "error" (transport failure) — and none of them end the session.

const APP_ROOT = path.resolve(__dirname, "../..");

interface StatusEvent {
  state: string;
  audioPulse?: boolean;
  reason?: string;
}

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-status-"));
}
async function freshCallLogDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-status-calls-"));
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

async function startSession(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { startSession: () => Promise<unknown> };
    }).__prompty_e2e;
    await h.startSession();
  });
}

async function getStatusLog(app: ElectronApplication): Promise<StatusEvent[]> {
  return (await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { getStatusLog: () => StatusEvent[] };
    }).__prompty_e2e;
    return h.getStatusLog();
  })) as StatusEvent[];
}

async function waitForState(
  app: ElectronApplication,
  state: string,
  ms = 8_000,
): Promise<StatusEvent[]> {
  const deadline = Date.now() + ms;
  let log: StatusEvent[] = [];
  while (Date.now() < deadline) {
    log = await getStatusLog(app);
    if (log.some((e) => e.state === state)) return log;
    await new Promise((r) => setTimeout(r, 150));
  }
  return log;
}

function overlayVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (w) => !w.isDestroyed() && w.isVisible() && w.webContents.getURL().includes("overlay"),
    ),
  );
}

async function waitOverlayVisible(app: ElectronApplication, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await overlayVisible(app)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test("Stage 3: emits 'starting' then 'listening' on audio", async () => {
  const dir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(dir);
  await seedSession(dir);
  const app = await launchApp(dir, { PROMPTY_CALL_LOG_DIR: callLogDir, PROMPTY_NO_AUDIO_MS: "60000" });
  try {
    await waitForReady(app);
    await startSession(app);
    // "starting" is emitted synchronously during session setup.
    const early = await getStatusLog(app);
    expect(early[0]?.state).toBe("starting");

    // Inject an utterance → audio-flow → "listening" with a pulse.
    await app.evaluate(async () => {
      const h = (globalThis as unknown as {
        __prompty_e2e: { injectUtterance: (u: unknown) => boolean };
      }).__prompty_e2e;
      h.injectUtterance({ speaker: "them", text: "hello there", startMs: 0, endMs: 0, isFinal: true });
    });
    const log = await waitForState(app, "listening");
    const listening = log.find((e) => e.state === "listening");
    expect(listening).toBeTruthy();
    expect(listening?.audioPulse).toBe(true);
  } finally {
    await app.close();
  }
});

test("Stage 3: flips to 'no-audio' after the silence threshold", async () => {
  const dir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(dir);
  await seedSession(dir);
  // Short no-audio threshold so we don't wait 10s.
  const app = await launchApp(dir, { PROMPTY_CALL_LOG_DIR: callLogDir, PROMPTY_NO_AUDIO_MS: "1200" });
  try {
    await waitForReady(app);
    await startSession(app);
    // No utterances injected → after the threshold, status flips to no-audio.
    const log = await waitForState(app, "no-audio", 6000);
    expect(log.some((e) => e.state === "no-audio")).toBe(true);
    // Session must still be live (no-audio never ends a session).
    expect(await overlayVisible(app)).toBe(true);
  } finally {
    await app.close();
  }
});

test("Stage 3: forced transport error emits 'error' and does not end the session", async () => {
  const dir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(dir);
  await seedSession(dir);
  const app = await launchApp(dir, { PROMPTY_CALL_LOG_DIR: callLogDir, PROMPTY_NO_AUDIO_MS: "60000" });
  try {
    await waitForReady(app);
    await startSession(app);
    // Confirm the session is up (overlay shown) before forcing the error.
    expect(await waitOverlayVisible(app)).toBe(true);
    await app.evaluate(async () => {
      const h = (globalThis as unknown as {
        __prompty_e2e: { forceDeepgramError: (r?: string) => boolean };
      }).__prompty_e2e;
      h.forceDeepgramError("e2e-forced");
    });
    const log = await waitForState(app, "error");
    const err = log.find((e) => e.state === "error");
    expect(err).toBeTruthy();
    expect(err?.reason).toContain("e2e-forced");
    // Error status must NOT end the session — overlay stays up.
    expect(await overlayVisible(app)).toBe(true);
  } finally {
    await app.close();
  }
});
