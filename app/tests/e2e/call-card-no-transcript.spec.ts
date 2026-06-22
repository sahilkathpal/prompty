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

// Regression: a call ended before anyone spoke has an empty transcript and no
// summary (summaryPending:false). The post-call summary tab must NOT dump the
// raw JSON log — it should show a clean "Nothing was captured on this call."
// empty state. Before the fix, the !summary branch fell through to
// <pre>{call.raw}</pre> for every un-summarized call, leaking the raw log.

function noTranscriptCall(slug: string, started: number) {
  return {
    direction: `Call ${slug}`,
    title: `Call ${slug}`,
    transcript: [],
    nudges: [],
    components: [],
    startedAt: started,
    endedAt: started + 45_000,
    summaryPending: false,
    summary: undefined,
  };
}

test("no-transcript call: summary tab shows empty state, never raw JSON", async () => {
  const userDataDir = await freshUserDataDir("e2e-no-transcript");
  const callLogDir = path.join(userDataDir, "calls");
  await fs.mkdir(callLogDir, { recursive: true });
  await seedSettings(userDataDir);
  await fs.writeFile(
    path.join(callLogDir, "2023-11-14T18-00-00-000Z-call-a.json"),
    JSON.stringify(noTranscriptCall("A", 1_700_000_400_000)),
    "utf8",
  );

  const app = await launchApp(userDataDir, { env: { PROMPTY_CALL_LOG_DIR: callLogDir } });
  const errors: string[] = [];
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);
    page.on("pageerror", (e) => errors.push(String(e.stack || e.message)));

    const rows = page.getByTestId("call-row");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });

    // Open the call — the summary tab is the default view.
    await rows.first().click();

    // Clean empty state is shown…
    await expect(page.getByTestId("call-no-transcript")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("call-no-transcript")).toHaveText(
      "No conversation was captured — the call ended before there was anything to transcribe.",
    );

    // …and the raw JSON log is never rendered.
    await expect(page.locator("text=raw log")).toHaveCount(0);
    await expect(page.locator("pre.pcs-raw")).toHaveCount(0);
    await expect(page.locator("text=summaryPending")).toHaveCount(0);

    expect(errors, "no uncaught render error").toEqual([]);
  } finally {
    await app.close();
  }
});
