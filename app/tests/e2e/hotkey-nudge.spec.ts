import { test, expect } from "@playwright/test";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  e2e,
  showOverlay,
  getOverlayPage,
} from "./_helpers";

// The hotkey path: pressing the global hotkey (or the panel "ask" button) fires
// the `nudge:request` IPC, which calls the active session's requestNudge(). The
// rest of the suite drives nudges straight to the overlay via emitNudge; this
// spec exercises the REQUEST→agent→overlay wiring end-to-end. Under
// PROMPTY_MOCK_AGENT the mock agent answers a hotkey consider() with a nudge
// tagged "trigger=hotkey", so we can assert the requested note actually blooms.

test("a hotkey nudge request surfaces a fresh note on the overlay", async () => {
  const dir = await freshUserDataDir("e2e-hotkey");
  await seedSettings(dir);
  // Isolate the call log so the on-quit write stays out of ~/.prompty/calls.
  const app = await launchApp(dir, { env: { PROMPTY_CALL_LOG_DIR: `${dir}/calls` } });
  try {
    await waitForReady(app);

    // Start a (mocked) live session and reveal the gem.
    await e2e(app, "startSession");
    await showOverlay(app);
    const overlay = await getOverlayPage(app);
    await expect(overlay.locator('[data-testid="gem"]')).toHaveCount(1);

    // Fire the same IPC the hotkey / panel button drives.
    await overlay.evaluate(async () => {
      await (
        window as unknown as {
          prompty: { invoke: (c: string, p?: unknown) => Promise<unknown> };
        }
      ).prompty.invoke("nudge:request", { source: "hotkey" });
    });

    // The mock agent's hotkey answer blooms beneath the gem.
    const bloomQ = overlay.locator('[data-testid="gem-bloom"] .gem-note-q');
    await expect(bloomQ).toContainText("trigger=hotkey", { timeout: 6000 });
  } finally {
    await app.close();
  }
});
