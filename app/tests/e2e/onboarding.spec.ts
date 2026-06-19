import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { APP_ROOT, freshUserDataDir } from "./_helpers";
import path from "node:path";
import fs from "node:fs/promises";

// Onboarding is the one flow the standard harness can't reach: in PROMPTY_E2E
// mode the app force-completes onboarding and never opens the window (main.ts),
// and the __prompty_e2e bridge only exists in that mode. So this spec launches
// the REAL app WITHOUT PROMPTY_E2E (onboarding actually opens) and drives the
// onboarding renderer directly. Onboarding only touches claude-detection /
// permission-status / celebrate / complete IPC — none of which need the audio,
// agent, or Deepgram mocks, so a clean launch is correct and needs no API key.
//
// Deliberately NOT exercised (can't be driven without flaking the OS):
//   - the mic step's native permission dialog (systemPreferences.askForMediaAccess)
//   - the step-4 global hotkey (registered at the OS level)
// Every IPC path those steps hit is still covered below by invoking it directly.

type Bridge = { prompty: { invoke: (c: string, p?: unknown) => Promise<unknown> } };

async function findWindow(
  app: ElectronApplication,
  fragment: string,
  timeoutMs = 10_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = app.windows().find((pg) => pg.url().includes(fragment));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${fragment} window not found within ${timeoutMs}ms`);
}

test("onboarding: 5-step flow renders, advances, celebrates, and completes", async () => {
  test.setTimeout(60_000);

  const dir = await freshUserDataDir("e2e-onboarding");
  const settingsPath = path.join(dir, "prompty-settings.json");
  await fs.writeFile(
    settingsPath,
    JSON.stringify({ onboardingCompleted: false, hotkey: "Alt+Shift+Space" }),
    "utf8",
  );

  // No PROMPTY_E2E in the env — that flag would skip onboarding entirely.
  const app = await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${dir}`],
    env: { ...process.env },
  });

  const consoleErrors: string[] = [];

  try {
    const ob = await findWindow(app, "onboarding");
    ob.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    ob.on("pageerror", (e) => consoleErrors.push(e.message));

    // ── Step 1: welcome renders ──────────────────────────────────────────────
    await expect(ob.locator("text=Meet Ruby")).toBeVisible({ timeout: 5_000 });

    // ── The gem overlay appears with Ruby's speech bubble (set-ruby-message) ──
    // and shows the listening face (wave suppressed) during onboarding.
    const overlay = await findWindow(app, "overlay");
    await expect(overlay.locator(".gem-ruby-bubble")).toBeVisible({ timeout: 5_000 });
    await expect(overlay.locator('[data-testid="gem"]')).toHaveCount(1);

    // ── Advance step 1 → step 2 (welcome → claude). Exercises check-claude. ──
    await ob.click("button.ob-btn-primary"); // "Get started →"
    await expect(ob.locator("text=Ruby runs on Claude")).toBeVisible({ timeout: 5_000 });

    // ── celebrate: must resolve (regression guard for the hardcoded image path)
    //    and spawn the full-screen confetti window. ────────────────────────────
    const before = app.windows().length;
    await ob.evaluate(async () => {
      await (window as unknown as Bridge).prompty.invoke("onboarding:celebrate", undefined);
    });
    await expect
      .poll(() => app.windows().length, { timeout: 5_000 })
      .toBeGreaterThan(before);

    // ── complete: flips the persisted flag, hides overlay, closes onboarding. ─
    // Fire-and-forget: the complete handler tears down this very window, so
    // awaiting the invoke's round-trip would race the page being destroyed.
    // The settings-file + window-gone polls below are the real assertions.
    await ob
      .evaluate(() => {
        void (window as unknown as Bridge).prompty.invoke("onboarding:complete", undefined);
      })
      .catch(() => {});
    await expect
      .poll(async () => {
        const raw = await fs.readFile(settingsPath, "utf8").catch(() => "{}");
        return JSON.parse(raw).onboardingCompleted === true;
      }, { timeout: 5_000 })
      .toBe(true);
    await expect
      .poll(() => app.windows().some((p) => p.url().includes("onboarding")), { timeout: 5_000 })
      .toBe(false);

    expect(consoleErrors, `console errors during onboarding:\n${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
