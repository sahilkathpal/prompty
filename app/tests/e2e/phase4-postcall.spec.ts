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

// Phase 4 of the UX audit: post-call rework. We seed a modern call log (assisted
// insights + a checklist) on disk and drive the real built app to assert the
// softened coverage count (PC1), Ruby's attribution line (PC2/X3), the via
// clause, tab a11y (PC3), the copy aria-label (PC4), and the note View/Undo (PC10).

function modernCall(started: number) {
  return {
    direction: "Discovery with Acme",
    title: "Acme discovery",
    attendee: { name: "Dana Lee", company: "Acme" },
    transcript: [
      { speaker: "them", text: "Hi, thanks for hopping on.", startMs: 0, isFinal: true },
      { speaker: "me", text: "Of course — let's dig in.", startMs: 6000, isFinal: true },
    ],
    nudges: [],
    startedAt: started,
    endedAt: started + 600_000,
    summaryPending: false,
    components: [
      {
        type: "checklist",
        id: "c1",
        title: "Cover",
        items: [
          { id: "i1", text: "Budget", done: true },
          { id: "i2", text: "Timeline", done: false },
          { id: "i3", text: "Decision owner", done: false },
        ],
      },
    ],
    summary: {
      title: "Acme discovery",
      recap: "A solid discovery call — clear budget, fuzzy timeline.",
      insights: [
        { takeaway: "Budget is already approved", assisted: true },
        { takeaway: "Timeline is loosely Q3", assisted: false },
        { takeaway: "Dana is the decision maker", assisted: true },
      ],
    },
  };
}

test("post-call rework: softened coverage, attribution, tab a11y, copy aria, note undo", async () => {
  const userDataDir = await freshUserDataDir("e2e-phase4");
  const callLogDir = path.join(userDataDir, "calls");
  const memoryFile = path.join(userDataDir, "memory.json");
  await fs.mkdir(callLogDir, { recursive: true });
  await seedSettings(userDataDir);
  await fs.writeFile(
    path.join(callLogDir, "2024-05-01T10-00-00-000Z-acme.json"),
    JSON.stringify(modernCall(1_714_557_600_000)),
    "utf8",
  );

  const app = await launchApp(userDataDir, {
    env: { PROMPTY_CALL_LOG_DIR: callLogDir, PROMPTY_MEMORY_FILE: memoryFile },
  });
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    await page.getByTestId("call-row").first().click();

    // PC8 (Phase 1) recap label + PC2/X3 attribution.
    await expect(page.getByTestId("call-card")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".pcs-recap-label")).toHaveText("The gist");
    await expect(page.getByTestId("call-insight-attribution")).toHaveText(
      "Ruby helped surface 2 of these.",
    );
    // Fuller via clause on assisted insights (no per-insight `via` set).
    await expect(page.locator(".pcs-insight-via").first()).toContainText(
      "Surfaced after a Ruby nudge",
    );

    // PC1: prep (collapsed at the top of the recap) carries a calm descriptive
    // count, not "X of Y".
    const stat = page.getByTestId("call-prep-summary");
    await expect(stat).toContainText("3 to cover");
    await expect(stat).not.toContainText(" of ");

    // PC3: tab a11y semantics.
    const summaryTab = page.getByTestId("post-call-tab-summary");
    await expect(summaryTab).toHaveAttribute("role", "tab");
    await expect(summaryTab).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[role="tablist"]')).toBeVisible();

    // PC4: copy-transcript carries an aria-label (on the Transcript tab).
    await page.getByTestId("post-call-tab-transcript").click();
    await expect(page.getByTestId("post-call-tab-transcript")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("post-call-copy-transcript")).toHaveAttribute(
      "aria-label",
      "Copy the transcript to the clipboard",
    );

    // PC10: save a note → quiet View/Undo; Undo returns to the add state.
    await page.getByTestId("post-call-tab-summary").click();
    await page.getByTestId("nudge-note-open").click();
    await page.getByTestId("nudge-note-input").fill("Hold pricing nudges until they raise budget.");
    await page.getByTestId("nudge-note-save").click();
    await expect(page.getByTestId("nudge-note-saved")).toBeVisible();
    await expect(page.getByTestId("nudge-note-view")).toBeVisible();
    await page.getByTestId("nudge-note-undo").click();
    // Back to the un-saved "Add note" affordance.
    await expect(page.getByTestId("nudge-note-open")).toBeVisible();
    await expect(page.getByTestId("nudge-note-saved")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// X19: the click-to-edit title renames the call (Enter commits + persists,
// Escape reverts).
test("post-call: rename title persists on Enter and reverts on Escape", async () => {
  const userDataDir = await freshUserDataDir("e2e-rename");
  const callLogDir = path.join(userDataDir, "calls");
  const memoryFile = path.join(userDataDir, "memory.json");
  await fs.mkdir(callLogDir, { recursive: true });
  await seedSettings(userDataDir);
  const callFile = path.join(callLogDir, "2024-05-01T10-00-00-000Z-acme.json");
  await fs.writeFile(callFile, JSON.stringify(modernCall(1_714_557_600_000)), "utf8");

  const app = await launchApp(userDataDir, {
    env: { PROMPTY_CALL_LOG_DIR: callLogDir, PROMPTY_MEMORY_FILE: memoryFile },
  });
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    await page.getByTestId("call-row").first().click();
    const title = page.getByTestId("call-title");
    await expect(title).toContainText("Acme discovery");

    // Enter commits the new title and updates the hero.
    await title.click();
    const input = page.getByTestId("call-title-input");
    await expect(input).toBeVisible();
    await input.fill("Renamed via test");
    await input.press("Enter");
    await expect(page.getByTestId("call-title")).toContainText("Renamed via test");

    // It persisted to the call log on disk.
    await expect
      .poll(async () => JSON.parse(await fs.readFile(callFile, "utf8")).title)
      .toBe("Renamed via test");

    // Escape discards an in-progress edit, leaving the committed title.
    await page.getByTestId("call-title").click();
    const input2 = page.getByTestId("call-title-input");
    await input2.fill("Should not stick");
    await input2.press("Escape");
    await expect(page.getByTestId("call-title")).toContainText("Renamed via test");
  } finally {
    await app.close();
  }
});
