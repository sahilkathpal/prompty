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

// Tier 2 decoupled summary: a just-ended call is saved immediately with
// `summaryPending: true`, before the background summary pass lands. The Past
// Calls list must show a "Summarizing…" hint on the row, and the opened card a
// placeholder — not the raw-JSON fallback used for genuinely summary-less logs.

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-summarizing-"));
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

async function seedPendingCall(callLogDir: string): Promise<void> {
  await fs.mkdir(callLogDir, { recursive: true });
  const now = Date.now();
  await fs.writeFile(
    path.join(callLogDir, "2026-01-01T00-00-00-000Z-discovery-call-with-acme.json"),
    JSON.stringify({
      direction: "Discovery call with Acme",
      transcript: [{ speaker: "me", text: "hello", isFinal: true, ts: now }],
      nudges: [],
      startedAt: now - 60_000,
      endedAt: now,
      summaryPending: true,
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

async function openMainWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { openMainWindow: () => void };
    }).__prompty_e2e;
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

test("a summary-pending call shows the 'Summarizing…' hint + placeholder card", async () => {
  const userDataDir = await freshUserDataDir();
  const callLogDir = path.join(userDataDir, "calls");
  await seedSettings(userDataDir);
  await seedPendingCall(callLogDir);
  const app = await launchApp(userDataDir, callLogDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // The row renders with the derived title and a "Summarizing…" meta hint.
    const row = page.getByText("Discovery call with Acme");
    await expect(row).toBeVisible();
    await expect(page.getByText("Summarizing…")).toBeVisible();

    // Opening it shows the placeholder card, not the raw-JSON fallback.
    await row.click();
    await expect(page.getByTestId("call-summarizing")).toBeVisible();
    await expect(page.getByTestId("call-summarizing")).toContainText("Summarizing this call");
    await expect(page.getByTestId("call-card")).toHaveCount(0);

    // The Transcript tab is usable even while the summary is still generating:
    // it renders the captured transcript and replaces the "Summarizing…" state
    // (the transcript must not bleed into the Summary tab).
    await page.getByTestId("post-call-tab-transcript").click();
    const transcript = page.getByTestId("call-transcript");
    await expect(transcript).toBeVisible();
    await expect(transcript.locator("text=hello")).toBeVisible();
    await expect(page.getByTestId("call-summarizing")).toHaveCount(0);

    // Back to Summary restores the summarizing placeholder.
    await page.getByTestId("post-call-tab-summary").click();
    await expect(page.getByTestId("call-summarizing")).toBeVisible();
    await expect(page.getByTestId("call-transcript")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
