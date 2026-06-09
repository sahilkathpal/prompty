import { test, expect, _electron as electron, ElectronApplication } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-stage5-"));
}
async function freshCallLogDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-stage5-calls-"));
}

async function seedSettings(userDataDir: string): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, "prompty-settings.json"),
    JSON.stringify({
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

// A real journal as coach-session writes it: a header line, then utt/nudge lines.
function makeJournal(startedAt: number): string {
  return (
    JSON.stringify({
      t: "header",
      goal: "Recover this call",
      mode: "default",
      checklist: [{ id: "a", text: "ask budget", status: "open" }],
      attendee: { name: "Crash Victim" },
      startedAt,
    }) +
    "\n" +
    JSON.stringify({
      t: "utt",
      u: { speaker: "them", text: "we have eight brokers", startMs: 0, endMs: 900, isFinal: true },
    }) +
    "\n" +
    JSON.stringify({ t: "nudge", n: { id: "n1", kind: "segue", text: "ask team size", createdAt: 5 } }) +
    "\n" +
    // Torn final line, exactly what an interrupted writeSync leaves behind.
    '{"t":"utt","u":{"speaker":"me","tex'
  );
}

test("Stage 5: a crashed call's journal is recovered into a log on next launch", async () => {
  const userDataDir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  // Simulate the aftermath of a crash: a journal exists, no consolidated log.
  const journalDir = path.join(callLogDir, ".journal");
  await fs.mkdir(journalDir, { recursive: true });
  const journalFile = path.join(journalDir, "1000.jsonl");
  await fs.writeFile(journalFile, makeJournal(1000), "utf8");

  const app = await launchApp(userDataDir, { PROMPTY_CALL_LOG_DIR: callLogDir });
  try {
    await waitForReady(app);

    // Recovery runs on app-ready; poll for the recovered log to appear.
    const deadline = Date.now() + 10_000;
    let recoveredFile: string | undefined;
    while (Date.now() < deadline) {
      const files = await fs.readdir(callLogDir).catch(() => []);
      recoveredFile = files.find((f) => f.endsWith("-recovered.json"));
      if (recoveredFile) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(recoveredFile, "a -recovered.json log should be written").toBeTruthy();

    const log = JSON.parse(await fs.readFile(path.join(callLogDir, recoveredFile!), "utf8"));
    expect(log.goal).toBe("Recover this call");
    expect(log.transcript).toHaveLength(1); // torn line skipped
    expect(log.transcript[0].text).toBe("we have eight brokers");
    expect(log.nudges).toHaveLength(1);

    // Journal consumed.
    const journalGone = await fs
      .access(journalFile)
      .then(() => false)
      .catch(() => true);
    expect(journalGone, "journal should be deleted after recovery").toBe(true);
  } finally {
    await app.close();
  }
});

test("Stage 5: quitting mid-call writes a clean log (before-quit), not a recovered one", async () => {
  const userDataDir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir, { PROMPTY_CALL_LOG_DIR: callLogDir });
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
      text: "quitting without ending the session",
      startMs: 0,
      endMs: 0,
      isFinal: true,
    });
  });
  await new Promise((r) => setTimeout(r, 500));

  // Quit without ever calling endSession — before-quit must end the session.
  await app.close();

  const files = await fs.readdir(callLogDir).catch(() => []);
  const logs = files.filter((f) => f.endsWith(".json"));
  expect(logs.length, "quitting mid-call should still write a log").toBe(1);
  expect(logs[0].endsWith("-recovered.json"), "log should be clean, not recovered").toBe(false);

  const log = JSON.parse(await fs.readFile(path.join(callLogDir, logs[0]), "utf8"));
  expect(log.transcript.some((u: { text: string }) => /quitting without ending/.test(u.text))).toBe(true);

  // Journal cleaned up by the clean end().
  const journalLeft = await fs.readdir(path.join(callLogDir, ".journal")).catch(() => []);
  expect(journalLeft.filter((f) => f.endsWith(".jsonl"))).toHaveLength(0);
});
