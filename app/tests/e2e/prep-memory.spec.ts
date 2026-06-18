import { test, expect, type Page } from "@playwright/test";
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

// Independent verification of Phase 2c, Part B: the prep agent's write_memory
// tool, gated by conversational consent (offer → "yes" → write). Under
// PROMPTY_MOCK_AGENT=1 the mock prep agent OFFERS to remember a voiced nudging
// preference; a following "yes" writes it to memory; a "no" writes nothing. We
// drive the real built app and assert the on-disk memory JSON.

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

async function sendPrep(page: Page, text: string): Promise<void> {
  await page.getByTestId("prep-input").fill(text);
  await page.getByTestId("prep-send").click();
}

test("prep memory: offer→yes writes the item, offer→no writes nothing", async () => {
  const userDataDir = await freshUserDataDir("e2e-prep-memory");
  const memoryFile = path.join(userDataDir, "memory.json");
  await seedSettings(userDataDir);

  const app = await launchApp(userDataDir, {
    env: { PROMPTY_MEMORY_FILE: memoryFile },
  });
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // Enter prep from the home chat bar.
    await page.getByTestId("home-direction").fill("Prep this call");
    await page.getByTestId("home-send").click();
    await expect(page.getByTestId("prep-input")).toBeVisible({ timeout: 15_000 });

    // ===== Criterion 1: a voiced nudging preference is OFFERED, not written =====
    const PREF = "nudge me only when it's genuinely critical";
    await sendPrep(page, PREF);
    await page
      .getByTestId("prep-msg-assistant")
      .filter({ hasText: "remember that for future calls" })
      .first()
      .waitFor({ timeout: 15_000 });
    // Nothing on disk yet — the offer alone never writes.
    expect(await readMemory(memoryFile)).toHaveLength(0);

    // ===== Criterion 2: "yes" writes the preference to memory =====
    await sendPrep(page, "yes");
    const afterYes = await waitForMemory(memoryFile, (it) => it.length === 1);
    console.log("MEMORY after yes:", JSON.stringify(afterYes));
    expect(afterYes).toHaveLength(1);
    expect(afterYes[0].text).toBe(PREF);

    // ===== Criterion 3: a second preference offered then DECLINED writes nothing =
    const PREF2 = "don't interrupt me near the end of a call";
    await sendPrep(page, PREF2);
    await page
      .getByTestId("prep-msg-assistant")
      .filter({ hasText: "remember that for future calls" })
      .last()
      .waitFor({ timeout: 15_000 });
    await sendPrep(page, "no");
    // Give any erroneous write a chance to land, then assert it did NOT.
    const afterNo = await waitForMemory(
      memoryFile,
      (it) => it.length > 1,
      1500,
    );
    console.log("MEMORY after no:", JSON.stringify(afterNo));
    expect(afterNo).toHaveLength(1);
    expect(afterNo.some((x) => x.text === PREF2)).toBe(false);
  } finally {
    await app.close();
  }
});
