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
      onboardingCompleted: true,
      loginItemPrompted: true,
      lastTab: "in-call",
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

test("Stage 5: quitting mid-call writes a clean log (before-quit), not a recovered one", async () => {
  const userDataDir = await freshUserDataDir();
  const callLogDir = await freshCallLogDir();
  await seedSettings(userDataDir);

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
