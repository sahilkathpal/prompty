import { test, expect } from "@playwright/test";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  e2e,
  injectUtterance,
  showOverlay,
  getOverlayPage,
} from "./_helpers";

// The "@real" lane: drives the app with the REAL in-call agent (no
// PROMPTY_MOCK_AGENT) so the actual Claude nudge pipeline is exercised
// end-to-end — IPC → openAgent/answerNow → overlay bloom. Audio + Deepgram stay
// mocked (we inject a transcript directly), so no DEEPGRAM_API_KEY is needed,
// but it DOES consume Claude quota and requires the `claude` CLI installed.
//
// Excluded from the default suite by the @real tag (playwright `--grep-invert
// @real`); run it on demand with `npm run e2e:real`.

test("@real the real agent surfaces a nudge on a hotkey press", async () => {
  test.setTimeout(120_000); // a real model turn can take many seconds

  const dir = await freshUserDataDir("e2e-real");
  await seedSettings(dir);
  // Override the base env: drop the agent mock so openAgent (real Claude) runs.
  // Isolate the call log to the temp dir so the on-quit write never lands in
  // the user's real ~/.prompty/calls.
  const app = await launchApp(dir, {
    env: { PROMPTY_MOCK_AGENT: "", PROMPTY_CALL_LOG_DIR: `${dir}/calls` },
  });
  try {
    await waitForReady(app);

    const res = (await e2e(app, "startSession")) as { ok: boolean; error?: string };
    expect(res.ok, `startSession failed: ${res.error ?? ""}`).toBe(true);

    await showOverlay(app);
    const overlay = await getOverlayPage(app);
    await expect(overlay.locator('[data-testid="gem"]')).toHaveCount(1);

    // Give the agent some live context, then force an answer via the hotkey
    // path — answerNow() is told to emit even when it would otherwise stay quiet.
    await injectUtterance(app, "We finished the Kafka rollout last quarter, about eight months.");
    await injectUtterance(app, "Reconciliation was taking hours at peak before that.", "them");
    await overlay.evaluate(async () => {
      await (
        window as unknown as { prompty: { invoke: (c: string, p?: unknown) => Promise<unknown> } }
      ).prompty.invoke("nudge:request", { source: "hotkey" });
    });

    // A real, non-empty nudge blooms beneath the gem.
    const bloomQ = overlay.locator('[data-testid="gem-bloom"] .gem-note-q');
    await expect(bloomQ).toBeVisible({ timeout: 90_000 });
    const text = (await bloomQ.textContent())?.trim() ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(30);
  } finally {
    await app.close();
  }
});
