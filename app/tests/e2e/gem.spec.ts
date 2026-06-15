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

// Phase 3 verification (RUBY_MVP decision #14): the in-call overlay is "the
// gem" — a small ruby anchor that blooms ONE ephemeral note beneath it, paces
// a burst of notes (dwell + queue + high-urgency preempt, ported from the old
// teleprompter), and expands into a quiet scrollback history on click. This
// runs against the BUILT app under real (non-headless) Electron.

const APP_ROOT = path.resolve(__dirname, "../..");
const SCREENS = path.join(__dirname, "__screens__");

// Short bloom timings so the test doesn't wait the full multi-second holds.
// dwell = min on-screen hold before a queued note may replace the current one;
// hide = how long a lone note lingers before it fades.
const DWELL_MS = 600;
const HIDE_MS = 1200;
const STALE_MS = 10_000;

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-gem-"));
}

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

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      PROMPTY_MOCK_AGENT: "1",
      NODE_ENV: "development",
      PROMPTY_OVERLAY_DWELL_MS: String(DWELL_MS),
      PROMPTY_OVERLAY_HIDE_MS: String(HIDE_MS),
      PROMPTY_OVERLAY_STALE_MS: String(STALE_MS),
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

async function showOverlay(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { showOverlay: () => void };
    }).__prompty_e2e;
    h.showOverlay();
  });
}

async function getOverlayPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const p = app.windows().find((pg) => pg.url().includes("overlay"));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("overlay (gem) page not found");
}

let nudgeSeq = 0;
async function emitNudge(
  app: ElectronApplication,
  text: string,
  urgency: "high" | "medium" = "medium",
): Promise<void> {
  const nudge = {
    id: `e2e-${Date.now()}-${nudgeSeq++}`,
    text,
    urgency,
    createdAt: Date.now(),
  };
  await app.evaluate(async (_electron, n) => {
    const h = (globalThis as unknown as {
      __prompty_e2e: { emitNudge: (n: unknown) => boolean };
    }).__prompty_e2e;
    h.emitNudge(n);
  }, nudge);
}

test("the gem: idle, bloom, fade, queue, preempt, and expandable history", async () => {
  const dir = await freshUserDataDir();
  await seedSettings(dir);
  await fs.mkdir(SCREENS, { recursive: true });

  const app = await launchApp(dir);
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
    await expect(bloom).toHaveText("What did you try before this?", {
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
    await expect(bloom).toHaveText("FIRST queued note", { timeout: 4000 });
    await expect(bloom).toHaveCount(1);
    // The queued second one is not dropped — it surfaces after the dwell.
    await expect(bloom).toHaveText("SECOND queued note", { timeout: 4000 });
    await expect(bloom).toHaveCount(1);

    // 5) A high-urgency note preempts whatever is showing immediately.
    await emitNudge(app, "LOW priority, will wait");
    await expect(bloom).toHaveText("LOW priority, will wait", { timeout: 4000 });
    await emitNudge(app, "URGENT preempting note", "high");
    await expect(bloom).toHaveText("URGENT preempting note", { timeout: 2000 });

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
