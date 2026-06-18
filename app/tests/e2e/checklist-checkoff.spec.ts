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
  readNewestCallLog,
  prepArmComponents,
} from "./_helpers";

// Independent verification of Phase 3c: the in-call agent's mark_covered(itemId)
// tool. When a checklist item is marked covered, its `done` flag is persisted
// into the CallLog JSON, and the Past Calls card renders a coverage line
// "Checklist · covered X/Y" with covered items ticked ✓.
//
// Under PROMPTY_MOCK_AGENT=1 the mock prep agent offers a checklist for message
// M, then on a "yes" (prepArmComponents) arms items "Cover M" / "Agree next
// steps". The mock in-call agent, on its
// FIRST consider() (first final utterance), marks the FIRST item covered. So a
// call that received >=1 utterance ends with items[0].done=true,
// items[1].done=false → covered 1/2.
//
// We drive the real built Electron app: prep+arm, start, inject one final
// utterance, end, then (1) read the newest CallLog JSON's components, and
// (2) open the call in Past Calls and read call-checklist-stat.

type PrepComp = { type: string; items?: Array<{ text: string; done?: boolean }> };
type CallLog = { components?: PrepComp[] };

test("in-call check-off persists done state and renders post-call coverage", async () => {
  const userDataDir = await freshUserDataDir("e2e-checklist-checkoff");
  const callLogDir = path.join(userDataDir, "calls");
  await fs.mkdir(callLogDir, { recursive: true });
  await seedSettings(userDataDir);

  const M = `rollout scope ${Math.random().toString(36).slice(2, 8)}`;

  const app = await launchApp(userDataDir, {
    env: { PROMPTY_DEBUG: "1", PROMPTY_CALL_LOG_DIR: callLogDir },
  });
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // ===== Prep: open from the home bar, offer→confirm M, wait for checklist ====
    await page.getByTestId("home-direction").fill("Prep this call");
    await page.getByTestId("home-send").click();
    await expect(page.getByTestId("prep-direction")).toBeVisible({ timeout: 15_000 });
    await prepArmComponents(page, M);
    await expect(page.getByTestId("component-checklist")).toBeVisible({
      timeout: 15_000,
    });

    // ===== Start the call directly from prep (the armed components stay armed;
    // closing prep back to home would clear them in the redesigned flow) =====
    await page.getByTestId("prep-begin").click();
    await expect(page.getByTestId("end-call")).toBeVisible({
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
    await page.getByTestId("end-call").click();
    await expect(page.getByTestId("home-direction")).toBeVisible({
      timeout: 30_000,
    });

    // ===== Criterion 1: PERSISTED DONE STATE in the CallLog JSON =====
    const { file, log } = await readNewestCallLog<CallLog>(callLogDir, {
      require: (l) => Array.isArray(l.components),
    });
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
    // The home screen auto-loads the past-call list; open the newest row.
    const firstRow = page.getByTestId("call-row").first();
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
