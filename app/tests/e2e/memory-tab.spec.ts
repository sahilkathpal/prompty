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

// Independent verification of the "Memory" tab (Phase 1a): a flat list of
// natural-language personalisation items, CRUD + persisted to a JSON file.
// We drive the real built Electron app and assert both the UI and on-disk JSON.

const APP_ROOT = path.resolve(__dirname, "../..");

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

async function launchApp(
  userDataDir: string,
  memoryFile: string,
): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      PROMPTY_MOCK_AGENT: "1",
      PROMPTY_MEMORY_FILE: memoryFile,
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

async function readMemoryFile(
  memoryFile: string,
): Promise<Array<{ id: string; text: string; source?: string }>> {
  try {
    const raw = await fs.readFile(memoryFile, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Poll the on-disk file until a predicate holds (writes are async vs. UI).
async function waitForDisk(
  memoryFile: string,
  pred: (items: Array<{ id: string; text: string }>) => boolean,
  timeoutMs = 5000,
): Promise<Array<{ id: string; text: string }>> {
  const deadline = Date.now() + timeoutMs;
  let last: Array<{ id: string; text: string }> = [];
  while (Date.now() < deadline) {
    last = (await readMemoryFile(memoryFile)) as Array<{
      id: string;
      text: string;
    }>;
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

test("Memory tab: full CRUD + persistence + relaunch", async () => {
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "prompty-e2e-memory-"),
  );
  const memoryFile = path.join(userDataDir, "memory.json");
  await seedSettings(userDataDir);

  let app = await launchApp(userDataDir, memoryFile);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // --- Criterion 1: Memory icon in the header, clicking opens the screen.
    const memTab = page.getByTestId("nav-memory");
    await expect(memTab).toBeVisible();
    await memTab.click();
    await expect(page.getByTestId("memory-input")).toBeVisible();
    await expect(page.getByTestId("memory-add")).toBeVisible();

    // --- Criterion 2: empty state shown with no data.
    await expect(page.getByTestId("memory-empty")).toBeVisible();
    await expect(page.getByTestId("memory-list")).toHaveCount(0);

    // --- Criterion 3: type + Add creates an item that appears in the list.
    const TEXT_A = "Nudge me rarely — only when it really matters.";
    await page.getByTestId("memory-input").fill(TEXT_A);
    await page.getByTestId("memory-add").click();

    await expect(page.getByTestId("memory-empty")).toHaveCount(0);
    const items = page.getByTestId("memory-item");
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText(TEXT_A);

    // --- Criterion 4: persisted to the memory JSON file on disk.
    const afterAdd = await waitForDisk(
      memoryFile,
      (it) => it.length === 1 && it[0].text === TEXT_A,
    );
    expect(afterAdd).toHaveLength(1);
    expect(afterAdd[0].text).toBe(TEXT_A);
    expect(typeof afterAdd[0].id).toBe("string");
    const idA = afterAdd[0].id;
    console.log("DISK after add:", JSON.stringify(afterAdd));

    // Add a second item (used later for relaunch persistence).
    const TEXT_B = "Always watch for pricing objections.";
    await page.getByTestId("memory-input").fill(TEXT_B);
    await page.getByTestId("memory-add").click();
    await expect(page.getByTestId("memory-item")).toHaveCount(2);
    await waitForDisk(memoryFile, (it) => it.length === 2);

    // --- Criterion 5: edit an item (pencil → change text → Enter) updates
    //     UI and disk.
    const TEXT_A_EDITED = "Nudge me only on real blockers.";
    const firstItem = page.getByTestId("memory-item").first();
    await firstItem.getByRole("button", { name: "Edit memory" }).click();
    const editInput = firstItem.getByRole("textbox");
    await expect(editInput).toBeVisible();
    await editInput.fill(TEXT_A_EDITED);
    await editInput.press("Enter");

    await expect(
      page.getByTestId("memory-item").first(),
    ).toContainText(TEXT_A_EDITED);
    const afterEdit = await waitForDisk(
      memoryFile,
      (it) => it.some((x) => x.id === idA && x.text === TEXT_A_EDITED),
    );
    const edited = afterEdit.find((x) => x.id === idA);
    expect(edited?.text).toBe(TEXT_A_EDITED);
    console.log("DISK after edit:", JSON.stringify(afterEdit));

    // --- Criterion 6: delete an item (✕) removes it from UI and disk.
    await page
      .getByTestId("memory-item")
      .filter({ hasText: TEXT_A_EDITED })
      .getByTestId("memory-delete")
      .click();

    await expect(page.getByTestId("memory-item")).toHaveCount(1);
    await expect(
      page.getByTestId("memory-item").first(),
    ).toContainText(TEXT_B);
    const afterDelete = await waitForDisk(
      memoryFile,
      (it) => it.length === 1 && !it.some((x) => x.id === idA),
    );
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete.some((x) => x.id === idA)).toBe(false);
    expect(afterDelete[0].text).toBe(TEXT_B);
    console.log("DISK after delete:", JSON.stringify(afterDelete));
  } finally {
    await app.close();
  }

  // --- Criterion 7: persistence across relaunch (same userDataDir + file).
  app = await launchApp(userDataDir, memoryFile);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    await page.getByTestId("nav-memory").click();
    await expect(page.getByTestId("memory-item")).toHaveCount(1);
    await expect(
      page.getByTestId("memory-item").first(),
    ).toContainText("Always watch for pricing objections.");
    await expect(page.getByTestId("memory-empty")).toHaveCount(0);

    const onDisk = await readMemoryFile(memoryFile);
    console.log("DISK after relaunch:", JSON.stringify(onDisk));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].text).toBe("Always watch for pricing objections.");
  } finally {
    await app.close();
  }
});
