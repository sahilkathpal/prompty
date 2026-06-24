import { test, expect } from "@playwright/test";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  showOverlay,
  getOverlayPage,
  emitNudge,
} from "./_helpers";

// Phase 2 of the UX audit (overlay & gem delight). Drives the real built
// overlay and asserts: the faced gem renders on the pill (V5); the nudge tag is
// urgency-driven (V2); high-urgency carries the drain bar + escalated treatment
// while calm notes don't (V1/V12); a note can be dismissed (V3); and the expand
// affordance shows a live note count (V8).

const DWELL_MS = 600;
const HIDE_MS = 1500;
const STALE_MS = 10_000;

function launch(dir: string) {
  return launchApp(dir, {
    env: {
      PROMPTY_OVERLAY_DWELL_MS: String(DWELL_MS),
      PROMPTY_OVERLAY_HIDE_MS: String(HIDE_MS),
      PROMPTY_OVERLAY_STALE_MS: String(STALE_MS),
    },
  });
}

test("the gem: faced pill, urgency-driven tag/bar, dismiss, note count", async () => {
  const dir = await freshUserDataDir("e2e-gem-phase2");
  await seedSettings(dir, { lastTab: "in-call" });

  const app = await launch(dir);
  try {
    await waitForReady(app);
    await showOverlay(app);
    const overlay = await getOverlayPage(app);

    // V5: the signature faced gem (the .pgem svg) is what renders on the pill.
    await expect(overlay.locator(".gem-pill .pgem")).toHaveCount(1);

    // V2/V12: a calm (medium) note tags "Worth asking" and carries NO drain bar.
    await emitNudge(app, "Calm note body", "medium");
    const bloom = overlay.locator('[data-testid="gem-bloom"]');
    await expect(bloom).toHaveCount(1, { timeout: 4000 });
    await expect(bloom.locator(".gem-note-tag")).toHaveText("Worth asking");
    await expect(bloom.locator(".gem-note-bar")).toHaveCount(0);

    // V3: the per-note × dismisses it (queue empties → the note clears).
    await overlay.locator('[data-testid="gem-note-dismiss"]').click();
    await expect(bloom).toHaveCount(0, { timeout: 4000 });

    // V2/V4/V1/V12: a high-urgency note tags "Ask now", takes the escalated
    // .gem-bloom-high treatment, and DOES carry the drain bar.
    await emitNudge(app, "Urgent note body", "high");
    await expect(bloom).toHaveCount(1, { timeout: 4000 });
    await expect(bloom.locator(".gem-note-tag")).toHaveText("Ask now");
    await expect(bloom).toHaveClass(/gem-bloom-high/);
    await expect(bloom.locator(".gem-note-bar")).toHaveCount(1);

    // The note fades after its dwell, leaving the gem at rest. (The old always-on
    // expand-count hint was removed — the panel opens on gem hover instead.)
    await expect(bloom).toHaveCount(0, { timeout: 4000 });
  } finally {
    await app.close();
  }
});
