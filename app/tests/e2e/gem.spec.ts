import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  showOverlay,
  getOverlayPage,
  emitNudge,
  e2e,
} from "./_helpers";

// Phase 3 verification (RUBY_MVP decision #14): the in-call overlay is "the
// gem" — a small ruby anchor that blooms ONE ephemeral note beneath it, paces
// a burst of notes (dwell + queue + high-urgency preempt, ported from the old
// teleprompter), and expands into a quiet scrollback history on click. This
// runs against the BUILT app under real (non-headless) Electron.

const SCREENS = path.join(__dirname, "__screens__");

// Short bloom timings so the test doesn't wait the full multi-second holds.
// dwell = min on-screen hold before a queued note may replace the current one;
// hide = how long a lone note lingers before it fades.
const DWELL_MS = 600;
const HIDE_MS = 1200;
const STALE_MS = 10_000;

test("the gem: idle, bloom, fade, queue, preempt, and expandable history", async () => {
  const dir = await freshUserDataDir("e2e-gem");
  await seedSettings(dir, { lastTab: "in-call" });
  await fs.mkdir(SCREENS, { recursive: true });

  const app = await launchApp(dir, {
    env: {
      PROMPTY_OVERLAY_DWELL_MS: String(DWELL_MS),
      PROMPTY_OVERLAY_HIDE_MS: String(HIDE_MS),
      PROMPTY_OVERLAY_STALE_MS: String(STALE_MS),
    },
  });
  try {
    await waitForReady(app);
    await showOverlay(app);

    const overlay = await getOverlayPage(app);
    const gem = overlay.locator('[data-testid="gem"]');
    await expect(gem).toHaveCount(1);

    // 1) Idle gem — nothing else visible.
    await expect(overlay.locator('[data-testid="gem-bloom"]')).toHaveCount(0);
    await expect(overlay.locator('[data-testid="gem-history"]')).toHaveCount(0);
    await overlay.screenshot({ path: path.join(SCREENS, "gem-idle.png") });

    // 2) A nudge blooms ONE note beneath the gem.
    await emitNudge(app, "What did you try before this?");
    const bloom = overlay.locator('[data-testid="gem-bloom"]');
    // The note carries a kind tag ("Ruby" / "Ask now"); assert on the text body.
    const bloomQ = overlay.locator('[data-testid="gem-bloom"] .gem-note-q');
    await expect(bloomQ).toHaveText("What did you try before this?", {
      timeout: 4000,
    });
    await overlay.screenshot({ path: path.join(SCREENS, "gem-bloom.png") });

    // 3) Past the dwell + hide, the lone note fades on its own (ephemeral).
    await expect(bloom).toHaveCount(0, { timeout: 4000 });

    // 4) Two notes in quick succession: only ONE shows at a time; the second is
    //    queued (not dropped) and surfaces after the first's dwell.
    await emitNudge(app, "FIRST queued note");
    await emitNudge(app, "SECOND queued note");
    // Only one bloom on screen at any instant.
    await expect(bloomQ).toHaveText("FIRST queued note", { timeout: 4000 });
    await expect(bloom).toHaveCount(1);
    // The queued second one is not dropped — it surfaces after the dwell.
    await expect(bloomQ).toHaveText("SECOND queued note", { timeout: 4000 });
    await expect(bloom).toHaveCount(1);

    // 5) A high-urgency note preempts whatever is showing immediately.
    await emitNudge(app, "LOW priority, will wait");
    await expect(bloomQ).toHaveText("LOW priority, will wait", { timeout: 4000 });
    await emitNudge(app, "URGENT preempting note", "high");
    await expect(bloomQ).toHaveText("URGENT preempting note", { timeout: 2000 });

    // Let the bloom settle/fade before exercising the history.
    await expect(bloom).toHaveCount(0, { timeout: 4000 });

    // 6) Click the gem → expand the scrollback history of every note this call,
    //    each with a timestamp.
    await gem.click();
    const history = overlay.locator('[data-testid="gem-history"]');
    await expect(history).toHaveCount(1);
    // All the notes surfaced above are retained, newest first.
    await expect(history).toContainText("URGENT preempting note");
    await expect(history).toContainText("FIRST queued note");
    await expect(history).toContainText("What did you try before this?");
    // Timestamps are rendered alongside each note.
    await expect(
      overlay.locator(".gem-history-time").first(),
    ).not.toHaveText("");
    await overlay.screenshot({ path: path.join(SCREENS, "gem-history.png") });

    // 7) Click the gem again → collapse back to the calm single-gem state.
    await gem.click();
    await expect(history).toHaveCount(0);
  } finally {
    await app.close();
  }
});

// Regression: nudges from before a call (e.g. the onboarding demo, or a prior
// call) must NOT bleed into a new call's history. The overlay window is created
// once and reused for the app's lifetime, so without an explicit reset its
// React state survives across calls. doStartSession sends overlay:reset the
// moment it shows the gem, so the new call starts with a clean history.
test("the gem: starting a call wipes any leftover nudge history", async () => {
  const dir = await freshUserDataDir("e2e-gem-reset");
  await seedSettings(dir, { lastTab: "in-call" });

  const app = await launchApp(dir);
  try {
    await waitForReady(app);
    await showOverlay(app);
    const overlay = await getOverlayPage(app);
    const gem = overlay.locator('[data-testid="gem"]');
    await expect(gem).toHaveCount(1);

    // Leftover nudge from "before" lands in the gem's history.
    await emitNudge(app, "LEFTOVER nudge from before this call");
    await gem.click();
    const history = overlay.locator('[data-testid="gem-history"]');
    await expect(history).toContainText("LEFTOVER nudge from before this call");

    // Start a real call: doStartSession shows the gem and sends overlay:reset.
    await e2e(app, "startSession");

    // The new call begins with empty history — the leftover is gone. Starting
    // also collapses the gem and can race our re-expand, so poll: expand if
    // collapsed, then assert the cleared empty-state shows.
    await expect(async () => {
      if ((await history.count()) === 0) await gem.click();
      // Live empty-state copy (V7) — the call is starting/live after reset.
      await expect(history).toContainText(
        /Nothing worth flagging yet|Notes I surface will collect/,
      );
    }).toPass({ timeout: 6000 });
    await expect(history).not.toContainText("LEFTOVER nudge from before this call");
  } finally {
    await e2e(app, "endSession").catch(() => {});
    await app.close();
  }
});
