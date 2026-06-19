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

// Gap 1: the post-call card exposes the full transcript behind a floating
// Summary / Transcript tab pill. The transcript is persisted on the call log;
// this asserts the Summary tab is the default (transcript hidden), the Transcript
// tab renders the utterances as a speaker-labelled chat view, the copy affordance
// appears only on that tab, and interim (isFinal:false) lines are dropped so
// revised utterances don't duplicate.

function callWithTranscript(slug: string, started: number) {
  return {
    direction: `Call ${slug}`,
    title: `Call ${slug}`,
    transcript: [
      { speaker: "them", text: "So how are you finding the new flow?", startMs: 0, endMs: 3000, isFinal: true },
      { speaker: "me", text: "Honestly it's been smoother than last quarter.", startMs: 3200, endMs: 6000, isFinal: true },
      // Interim result — must be filtered out of the rendered transcript.
      { speaker: "them", text: "ZZINTERIM partial fragment", startMs: 6500, endMs: 7000, isFinal: false },
      { speaker: "them", text: "And what about the pricing change?", startMs: 6500, endMs: 9000, isFinal: true },
    ],
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

test("post-call card: Summary/Transcript tabs — transcript hidden by default, renders on its tab, labels speakers, drops interim lines", async () => {
  const userDataDir = await freshUserDataDir("e2e-call-transcript");
  const callLogDir = path.join(userDataDir, "calls");
  await fs.mkdir(callLogDir, { recursive: true });
  await seedSettings(userDataDir);
  await fs.writeFile(
    path.join(callLogDir, "2023-11-14T18-00-00-000Z-call-a.json"),
    JSON.stringify(callWithTranscript("A", 1_700_000_400_000)),
    "utf8",
  );

  const app = await launchApp(userDataDir, { env: { PROMPTY_CALL_LOG_DIR: callLogDir } });
  const errors: string[] = [];
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);
    page.on("pageerror", (e) => errors.push(String(e.stack || e.message)));

    // The home screen auto-loads the past-call list on mount (no Refresh button
    // in the redesigned UI). Click the call row to open the post-call screen.
    const rows = page.getByTestId("call-row");
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });
    await rows.first().click();

    // The pill is present; Summary is the default tab. Summary content shows and
    // the transcript is not rendered yet.
    const summaryTab = page.getByTestId("post-call-tab-summary");
    const transcriptTab = page.getByTestId("post-call-tab-transcript");
    await expect(summaryTab).toBeVisible();
    await expect(transcriptTab).toBeVisible();
    await expect(page.getByTestId("call-stat")).toBeVisible();
    await expect(page.getByTestId("call-transcript")).toHaveCount(0);
    await expect(page.locator("text=smoother than last quarter")).toHaveCount(0);
    // Copy affordance is scoped to the transcript tab.
    await expect(page.getByTestId("post-call-copy-transcript")).toHaveCount(0);

    // Switch to the Transcript tab — utterances render with speaker labels; the
    // interim (isFinal:false) line is dropped; the summary content is hidden.
    await transcriptTab.click();
    const body = page.getByTestId("call-transcript");
    await expect(body).toBeVisible();
    await expect(body.locator("text=smoother than last quarter")).toBeVisible();
    await expect(body.locator("text=And what about the pricing change?")).toBeVisible();
    await expect(body.getByText("You", { exact: true }).first()).toBeVisible();
    await expect(body.getByText("Them", { exact: true }).first()).toBeVisible();
    await expect(page.locator("text=ZZINTERIM")).toHaveCount(0);
    await expect(page.getByTestId("post-call-copy-transcript")).toBeVisible();
    await expect(page.getByTestId("call-stat")).toHaveCount(0);

    // Back to Summary — transcript hidden again, summary restored.
    await summaryTab.click();
    await expect(page.getByTestId("call-transcript")).toHaveCount(0);
    await expect(page.getByTestId("call-stat")).toBeVisible();

    expect(errors, "no uncaught render error").toEqual([]);
  } finally {
    await app.close();
  }
});
