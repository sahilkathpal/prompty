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

// Independent verification of Phase 3c: the in-call agent's mark_covered(itemId)
// tool. When a checklist item is marked covered, its `done` flag is persisted
// into the CallLog JSON, and the Past Calls card renders a coverage line
// "Checklist · covered X/Y" with covered items ticked ✓.
//
// Under PROMPTY_MOCK_AGENT=1 the mock prep agent, on message M, arms a checklist
// with items "Cover M" / "Agree next steps". The mock in-call agent, on its
// FIRST consider() (first final utterance), marks the FIRST item covered. So a
// call that received >=1 utterance ends with items[0].done=true,
// items[1].done=false → covered 1/2.
//
// We drive the real built Electron app: prep+arm, start, inject one final
// utterance, end, then (1) read the newest CallLog JSON's components, and
// (2) open the call in Past Calls and read call-checklist-stat.

const APP_ROOT = path.resolve(__dirname, "../..");

type PrepComp = { type: string; items?: Array<{ text: string; done?: boolean }> };
type CallLog = { components?: PrepComp[] };

async function seedSettings(userDataDir: string): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, "prompty-settings.json"),
    JSON.stringify({
      onboardingCompleted: true,
      loginItemPrompted: true,
      debugMode: true,
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
      globalThis as unknown as { __prompty_e2e: { openMainWindow: () => void } }
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

// Poll the call-log dir for the newest *.json and parse it.
async function readNewestCallLog(
  callLogDir: string,
  timeoutMs = 20_000,
): Promise<{ file: string; log: CallLog }> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no *.json found in call log dir";
  while (Date.now() < deadline) {
    try {
      const files = (await fs.readdir(callLogDir))
        .filter((f) => f.endsWith(".json"))
        .sort();
      if (files.length) {
        const newest = files[files.length - 1];
        const raw = await fs.readFile(path.join(callLogDir, newest), "utf8");
        const log = JSON.parse(raw) as CallLog;
        if (Array.isArray(log.components)) return { file: newest, log };
        lastErr = `newest file ${newest} has no components array yet`;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`readNewestCallLog timed out: ${lastErr}`);
}

test("in-call check-off persists done state and renders post-call coverage", async () => {
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "prompty-e2e-checklist-checkoff-"),
  );
  const callLogDir = path.join(userDataDir, "calls");
  await fs.mkdir(callLogDir, { recursive: true });
  await seedSettings(userDataDir);

  const M = `rollout scope ${Math.random().toString(36).slice(2, 8)}`;

  const app = await launchApp(userDataDir, callLogDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    const directionTab = page.getByTestId("tab-direction");
    if (await directionTab.count()) await directionTab.click();

    // ===== Prep: send message M, wait for the armed checklist =====
    const prepOpen = page.getByTestId("prep-open");
    await expect(prepOpen).toBeVisible();
    await prepOpen.click();
    await page.getByTestId("prep-input").fill(M);
    await page.getByTestId("prep-send").click();
    await expect(page.getByTestId("component-checklist")).toBeVisible({
      timeout: 15_000,
    });
    // Close prep — components stay armed; the mock direction is now in the editor.
    await page.getByTestId("prep-done").click();

    // ===== Start the call =====
    await page.getByTestId("playground-start").click();
    await expect(page.getByTestId("playground-end")).toBeVisible({
      timeout: 20_000,
    });

    // ===== Inject one final utterance → triggers mock consider (marks item 0) ==
    await app.evaluate(async () =>
      (
        globalThis as unknown as {
          __prompty_e2e: { injectUtterance: (u: unknown) => void };
        }
      ).__prompty_e2e.injectUtterance({
        speaker: "them",
        text: "Let's talk about the rollout.",
        startMs: 0,
        endMs: 0,
        isFinal: true,
      }),
    );
    // Wait on the real condition rather than a fixed sleep: the mock consider()
    // calls onItemCovered() and THEN onNudge() in the same body, so once the
    // session has recorded a nudge the check-off has already landed. Polling
    // session:state makes this deterministic under any machine load.
    await page.waitForFunction(
      async () => {
        const s = await (
          window as unknown as {
            prompty: { invoke: (c: string, p?: unknown) => Promise<{ nudges?: unknown[] }> };
          }
        ).prompty.invoke("session:state");
        return (s?.nudges?.length ?? 0) >= 1;
      },
      undefined,
      { timeout: 15_000 },
    );

    // ===== End the call =====
    await page.getByTestId("playground-end").click();
    await expect(page.getByTestId("playground-start")).toBeVisible({
      timeout: 30_000,
    });

    // ===== Criterion 1: PERSISTED DONE STATE in the CallLog JSON =====
    const { file, log } = await readNewestCallLog(callLogDir);
    const checklist = (log.components ?? []).find((c) => c.type === "checklist");
    const items = checklist?.items ?? [];
    console.log("CALL LOG FILE:", file);
    console.log(
      "CHECKLIST ITEMS:",
      JSON.stringify(items.map((it) => ({ text: it.text, done: it.done }))),
    );
    expect(checklist, "components contains a checklist").toBeTruthy();
    expect(items.length).toBe(2);
    expect(items[0]!.done, "items[0].done").toBe(true);
    expect(items[1]!.done, "items[1].done").toBe(false);

    // ===== Criterion 2: POST-CALL CARD coverage stat =====
    // Past Calls list is on the Direction tab; refresh + open the newest row.
    if (await directionTab.count()) await directionTab.click();
    await page.getByText("Refresh").click();
    const firstRow = page.locator(".pc-row").first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();

    const stat = page.getByTestId("call-checklist-stat");
    await expect(stat).toBeVisible({ timeout: 10_000 });
    const statText = (await stat.textContent())?.trim();
    console.log("CHECKLIST STAT TEXT:", statText);
    await expect(stat).toContainText("covered 1/2");

    // The covered item renders with a ✓.
    const checklistCard = page.getByTestId("call-checklist");
    await expect(checklistCard).toContainText("✓");
    console.log("CHECKLIST CARD TEXT:", (await checklistCard.textContent())?.trim());
  } finally {
    await app.close();
  }
});
