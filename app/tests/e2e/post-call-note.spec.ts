import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  openMainWindow,
  getMainPage,
} from "./_helpers";

// Independent verification of Phase 2c, Part A: the quiet "note how Ruby nudged"
// affordance on the post-call card. It writes a user-authored item to memory via
// the existing memory:add IPC, with no draft and no reflexive prompt.
//
// E2E runs skip the live summary pass (PROMPTY_E2E=1), so we seed a call-log JSON
// that already has a summary — the affordance lives in the summary branch of the
// card, anchored under the stat line. We drive the real built app and assert both
// the UI confirmation and the on-disk memory JSON.

type MemItem = { id: string; text: string };

async function readMemory(file: string): Promise<MemItem[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function waitForMemory(
  file: string,
  pred: (items: MemItem[]) => boolean,
  timeoutMs = 5000,
): Promise<MemItem[]> {
  const deadline = Date.now() + timeoutMs;
  let last: MemItem[] = [];
  while (Date.now() < deadline) {
    last = await readMemory(file);
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

test("post-call note: save how Ruby nudged → memory item", async () => {
  const userDataDir = await freshUserDataDir("e2e-post-call-note");
  const callLogDir = path.join(userDataDir, "calls");
  const memoryFile = path.join(userDataDir, "memory.json");
  await fs.mkdir(callLogDir, { recursive: true });
  await seedSettings(userDataDir);

  // Seed a finished call with a summary so the card renders the stat line + note.
  const startedAt = 1_700_000_000_000;
  const endedAt = startedAt + 18 * 60_000;
  const fixture = {
    direction: "Discovery call with Arjun about agent code review.",
    title: "Arjun — agent code review",
    transcript: [],
    nudges: [],
    startedAt,
    endedAt,
    summaryPending: false,
    summary: {
      title: "Arjun — agent code review",
      recap: "Walked through how Arjun's team reviews agent-generated PRs.",
      insights: [
        { text: "They gate merges on a human approving the agent's plan.", assisted: false, via: "" },
      ],
      questionsNotAsked: [{ text: "What breaks most often in review?" }],
      stat: { surfaced: 4, used: 1 },
    },
  };
  await fs.writeFile(
    path.join(callLogDir, "2023-11-14T18-00-00-000Z-arjun-agent-code-review.json"),
    JSON.stringify(fixture, null, 2),
    "utf8",
  );

  const app = await launchApp(userDataDir, {
    env: { PROMPTY_CALL_LOG_DIR: callLogDir, PROMPTY_MEMORY_FILE: memoryFile },
  });
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // The home screen auto-loads the past-call list; open the seeded row.
    const firstRow = page.getByTestId("call-row").first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await firstRow.click();

    // ===== Criterion 1: card renders with the stat line and the collapsed note =
    await expect(page.getByTestId("call-stat")).toBeVisible({ timeout: 10_000 });
    const open = page.getByTestId("nudge-note-open");
    await expect(open).toBeVisible();
    // No input or "saved" state until the user opens it — never reflexive.
    await expect(page.getByTestId("nudge-note-input")).toHaveCount(0);
    await expect(page.getByTestId("nudge-note-saved")).toHaveCount(0);

    // ===== Criterion 2: open → type → save =====
    await open.click();
    const input = page.getByTestId("nudge-note-input");
    await expect(input).toBeVisible();
    const NOTE = "Don't surface follow-up questions during the close.";
    await input.fill(NOTE);
    await page.getByTestId("nudge-note-save").click();

    // ===== Criterion 3: UI confirms and collapses =====
    await expect(page.getByTestId("nudge-note-saved")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("nudge-note-open")).toHaveCount(0);

    // ===== Criterion 4: written to memory =====
    const items = await waitForMemory(memoryFile, (it) => it.some((x) => x.text === NOTE));
    console.log("MEMORY after save:", JSON.stringify(items));
    const saved = items.find((x) => x.text === NOTE);
    expect(saved, "note persisted to memory").toBeTruthy();

    // ===== Criterion 5: it shows up on the Memory screen =====
    // Back to home, then into Memory via the header icon.
    await page.getByTestId("post-call-back").click();
    await page.getByTestId("nav-memory").click();
    await expect(
      page.getByTestId("memory-item").filter({ hasText: NOTE }),
    ).toHaveCount(1, { timeout: 10_000 });
  } finally {
    await app.close();
  }
});
