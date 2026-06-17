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
import { prepArmComponents } from "./_helpers";

// Independent verification of Phase 3a: composable components in prep.
// Under PROMPTY_MOCK_AGENT=1 the prep agent is a deterministic mock that mirrors
// the suggest-then-create gate: a substantive message M makes Ruby OFFER a goal
// + checklist (no cards yet); confirming with "yes" then creates a goal card
// "Goal: M" and a checklist titled "Cover" with two items "Cover M" and "Agree
// next steps". These render as EDITABLE cards. We drive the real built app.

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

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_DEBUG: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      PROMPTY_MOCK_AGENT: "1",
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

// Read the input value inside the nth checklist-item <li>.
async function itemValue(page: Page, i: number): Promise<string> {
  return await page
    .getByTestId("checklist-item")
    .nth(i)
    .getByRole("textbox")
    .inputValue();
}

test("prep components: goal + checklist render, edit, add, delete", async () => {
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "prompty-e2e-prep-components-"),
  );
  await seedSettings(userDataDir);

  const MSG = `discovery scope ${Math.random().toString(36).slice(2, 8)}`;

  const app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    const directionTab = page.getByTestId("tab-direction");
    if (await directionTab.count()) await directionTab.click();

    // Open prep split view.
    const prepOpen = page.getByTestId("prep-open");
    await expect(prepOpen).toBeVisible();
    await prepOpen.click();

    // ===== Criterion 1: offer→confirm → components panel with goal+checklist =====
    await prepArmComponents(page, MSG);

    const panel = page.getByTestId("prep-components");
    await expect(panel).toBeVisible({ timeout: 15_000 });
    const goalCard = page.getByTestId("component-goal");
    const checklistCard = page.getByTestId("component-checklist");
    await expect(goalCard).toBeVisible({ timeout: 15_000 });
    await expect(checklistCard).toBeVisible({ timeout: 15_000 });
    console.log(
      "CRIT1: prep-components panel visible with goal + checklist cards",
    );

    // ===== Criterion 2: goal value + two checklist items with expected text =====
    const goalInput = page.getByTestId("goal-input");
    await expect
      .poll(async () => await goalInput.inputValue(), { timeout: 15_000 })
      .toBe(`Goal: ${MSG}`);
    const goalVal = await goalInput.inputValue();
    console.log("CRIT2 goal value:", JSON.stringify(goalVal));
    expect(goalVal).toBe(`Goal: ${MSG}`);

    const items = page.getByTestId("checklist-item");
    await expect(items).toHaveCount(2, { timeout: 15_000 });
    const item0 = await itemValue(page, 0);
    const item1 = await itemValue(page, 1);
    console.log("CRIT2 item[0]:", JSON.stringify(item0));
    console.log("CRIT2 item[1]:", JSON.stringify(item1));
    expect(item0).toBe(`Cover ${MSG}`);
    expect(item1).toBe("Agree next steps");

    // ===== Criterion 3: EDIT GOAL — controlled, editable input =====
    const NEW_GOAL = `Goal: REWRITTEN ${MSG}`;
    await goalInput.fill(NEW_GOAL);
    const goalAfter = await goalInput.inputValue();
    console.log("CRIT3 goal after edit:", JSON.stringify(goalAfter));
    expect(goalAfter).toBe(NEW_GOAL);

    // ===== Criterion 4: ADD ITEM — count 2 → 3 =====
    await page.getByTestId("checklist-add").click();
    await expect(page.getByTestId("checklist-item")).toHaveCount(3, {
      timeout: 10_000,
    });
    const countAfterAdd = await page.getByTestId("checklist-item").count();
    console.log("CRIT4 item count after add:", countAfterAdd);
    expect(countAfterAdd).toBe(3);

    // ===== Criterion 5: EDIT ITEM — type into the new (3rd) item =====
    const NEW_ITEM = "Confirm budget owner";
    await page
      .getByTestId("checklist-item")
      .nth(2)
      .getByRole("textbox")
      .fill(NEW_ITEM);
    const item2 = await itemValue(page, 2);
    console.log("CRIT5 item[2] after edit:", JSON.stringify(item2));
    expect(item2).toBe(NEW_ITEM);

    // ===== Criterion 6: DELETE ITEM — count decreases by 1 (3 → 2) =====
    await page
      .getByTestId("checklist-item")
      .nth(2)
      .getByTestId("checklist-item-delete")
      .click();
    await expect(page.getByTestId("checklist-item")).toHaveCount(2, {
      timeout: 10_000,
    });
    const countAfterDelete = await page.getByTestId("checklist-item").count();
    console.log("CRIT6 item count after delete:", countAfterDelete);
    expect(countAfterDelete).toBe(2);
  } finally {
    await app.close();
  }
});
