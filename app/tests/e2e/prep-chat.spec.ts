import {
  test,
  expect,
  _electron as electron,
  ElectronApplication,
  Page,
} from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// Independent verification of Phase 2b: prep chat split-view + prep agent.
// Under PROMPTY_MOCK_AGENT=1 the prep agent is a deterministic mock: each user
// message M produces an assistant bubble "Updated the working direction to
// focus on: M" and a working-direction rewrite appending a line "Focus: M".
// We drive the real built Electron app and read the on-disk CallLog.

const APP_ROOT = path.resolve(__dirname, "../..");

async function seedSettings(userDataDir: string): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, "prompty-settings.json"),
    JSON.stringify({
      onboardingCompleted: true,
      loginItemPrompted: true,
      hotkey: "Alt+Shift+Space",
      panelPosition: null,
      launchAtLogin: false,
      lastTab: "direction",
    }),
    "utf8",
  );
}

async function launchApp(
  userDataDir: string,
  callLogDir: string,
): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_DEBUG: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      PROMPTY_MOCK_AGENT: "1",
      PROMPTY_CALL_LOG_DIR: callLogDir,
      NODE_ENV: "development",
    },
  });
}

async function waitForReady(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: electronApp }) => {
    if (!electronApp.isReady()) {
      await new Promise<void>((resolve) =>
        electronApp.once("ready", () => resolve()),
      );
    }
  });
}

async function openMainWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const h = (
      globalThis as unknown as {
        __prompty_e2e: { openMainWindow: () => void };
      }
    ).__prompty_e2e;
    h.openMainWindow();
  });
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

// Read the newest *.json CallLog in the dir, polling until `direction` is set.
async function waitForNewestCallLog(
  callLogDir: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    let names: string[] = [];
    try {
      names = (await fs.readdir(callLogDir)).filter((n) => n.endsWith(".json"));
    } catch {
      names = [];
    }
    if (names.length > 0) {
      names.sort();
      const newest = names[names.length - 1];
      try {
        const raw = await fs.readFile(path.join(callLogDir, newest), "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        last = parsed;
        if (typeof parsed.direction === "string") return parsed;
      } catch {
        // file may be mid-write; retry
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (last) return last;
  throw new Error("no CallLog json written within deadline");
}

test("prep chat: split-view, live direction rewrite, done retains, prep→call", async () => {
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "prompty-e2e-prep-chat-"),
  );
  const callLogDir = path.join(userDataDir, "calls");
  await fs.mkdir(callLogDir, { recursive: true });
  await seedSettings(userDataDir);

  const SEED_DIRECTION = `Seed brief ${Date.now()}: explore the buyer's situation.`;
  const PREP_MSG = `pricing objections ${Math.random().toString(36).slice(2)}`;

  const app = await launchApp(userDataDir, callLogDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // Enter prep from the home chat bar (the typed brief seeds the direction).
    await page.getByTestId("home-direction").fill(SEED_DIRECTION);
    await page.getByTestId("home-send").click();

    // ===== Criterion 1: split view — chat log + direction editor side by side ===
    const prepLog = page.getByTestId("prep-log");
    await expect(prepLog).toBeVisible({ timeout: 15_000 });
    const textarea = page.getByTestId("prep-direction");
    await expect(textarea).toBeVisible();
    console.log("CRIT1: prep-log AND prep-direction visible (split view)");

    // ===== Criterion 2: send → user + assistant bubbles =====
    await page.getByTestId("prep-input").fill(PREP_MSG);
    await page.getByTestId("prep-send").click();

    const userBubble = page.getByTestId("prep-msg-user");
    const asstBubble = page.getByTestId("prep-msg-assistant");
    await expect(userBubble.first()).toBeVisible({ timeout: 15_000 });
    // The most recent assistant bubble is the response to PREP_MSG (an earlier
    // bubble may answer the seed message that opened prep).
    await expect(asstBubble.last()).toBeVisible({ timeout: 15_000 });
    const asstText = (await asstBubble.last().textContent()) ?? "";
    console.log("CRIT2 assistant bubble:", JSON.stringify(asstText));
    expect(asstText).toContain(
      `Updated the working direction to focus on: ${PREP_MSG}`,
    );

    // ===== Criterion 3: live direction rewrite into the editor =====
    await expect
      .poll(async () => await textarea.inputValue(), { timeout: 15_000 })
      .toContain(`Focus: ${PREP_MSG}`);
    const afterRewrite = await textarea.inputValue();
    console.log("CRIT3 editor value after live rewrite:", JSON.stringify(afterRewrite));
    expect(afterRewrite).toContain(`Focus: ${PREP_MSG}`);

    // ===== Criterion 4+5: start the call from prep; the rewritten direction is
    // retained and carried into the CallLog. (The redesigned flow begins the call
    // from the prep screen — there is no separate "Done"→home step beforehand,
    // which would reset the direction.) =====
    await page.getByTestId("prep-begin").click();
    // Start listening returns to Home; the live call is the top row — open it
    // to reach the in-progress view's Finish-listening control.
    await expect(page.getByTestId("home-live-row")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("home-live-row").click();
    await expect(page.getByTestId("end-call")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("end-call").click();
    await expect(page.getByTestId("home-direction")).toBeVisible({
      timeout: 30_000,
    });

    const log = await waitForNewestCallLog(callLogDir);
    console.log("CRIT5 CallLog direction:", JSON.stringify(log.direction));
    expect(typeof log.direction).toBe("string");
    expect(log.direction as string).toContain(`Focus: ${PREP_MSG}`);
  } finally {
    await app.close();
  }
});
