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

// Regression: a call carrying a LEGACY-schema summary ({goalRecap, items}) — a
// truthy object with no recap/insights/questionsNotAsked/stat — must not crash the
// post-call card. Before the guard in CallCard, `summary.insights.length` threw
// and React unmounted the whole renderer (blank window). Now an unrecognised
// summary falls back to the raw-log view. Reproduces the reported path: open a
// well-formed call, open its memory note box, then click the call below it.

function modernCall(slug: string, started: number) {
  return {
    direction: `Call ${slug}`,
    title: `Call ${slug}`,
    transcript: [],
    nudges: [],
    startedAt: started,
    endedAt: started + 600_000,
    summaryPending: false,
    summary: {
      title: `Call ${slug}`,
      recap: `Recap ${slug}.`,
      insights: [{ text: `Insight ${slug}`, assisted: false, via: "" }],
      questionsNotAsked: [{ text: `Q ${slug}` }],
      stat: { surfaced: 3, used: 1 },
    },
  };
}

function legacyCall(slug: string, started: number) {
  return {
    direction: `Call ${slug}`,
    transcript: [],
    nudges: [],
    startedAt: started,
    endedAt: started + 600_000,
    summary: { goalRecap: `Legacy recap ${slug}`, items: [] },
  };
}

test("legacy-summary call: open note then switch to it → raw-log fallback, no crash", async () => {
  const userDataDir = await freshUserDataDir("e2e-legacy-summary");
  const callLogDir = path.join(userDataDir, "calls");
  await fs.mkdir(callLogDir, { recursive: true });
  await seedSettings(userDataDir);
  await fs.writeFile(
    path.join(callLogDir, "2023-11-14T18-00-00-000Z-call-a.json"),
    JSON.stringify(modernCall("A", 1_700_000_400_000)),
    "utf8",
  );
  await fs.writeFile(
    path.join(callLogDir, "2023-11-14T17-00-00-000Z-call-b.json"),
    JSON.stringify(legacyCall("B", 1_700_000_000_000)),
    "utf8",
  );

  const app = await launchApp(userDataDir, { env: { PROMPTY_CALL_LOG_DIR: callLogDir } });
  const errors: string[] = [];
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);
    page.on("pageerror", (e) => errors.push(String(e.stack || e.message)));

    const directionTab = page.getByTestId("tab-direction");
    if (await directionTab.count()) await directionTab.click();
    await page.getByText("Refresh").click();

    const rows = page.locator(".pc-row");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });

    // Open A, open its note box, then click the call below it (B, legacy summary).
    await rows.first().click();
    await page.getByTestId("nudge-note-open").click();
    await expect(page.getByTestId("nudge-note-input")).toBeVisible();
    await rows.nth(1).click();

    // B renders the raw-log fallback rather than blanking the window.
    await expect(page.locator("text=raw log")).toBeVisible({ timeout: 5_000 });
    expect(errors, "no uncaught render error").toEqual([]);
  } finally {
    await app.close();
  }
});
