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
// permission-status / complete IPC — none of which need the audio,
// agent, or Deepgram mocks, so a clean launch is correct and needs no API key.
//
// Deliberately NOT exercised (can't be driven without flaking the OS):
//   - the mic step's native permission dialog (systemPreferences.askForMediaAccess)
//   - the step-4 global hotkey (registered at the OS level)
// Every IPC path those steps hit is still covered below by invoking it directly.

type Bridge = { prompty: { invoke: (c: string, p?: unknown) => Promise<unknown> } };
type ArmResult = { ok: boolean; registered: boolean; conflict: boolean };
type TrayItem = { label?: string; enabled: boolean };

// Read the tray's existence + menu template from the main process. The tray menu
// is native (not DOM), so we reach into the (already-loaded, cached) tray module
// and call its pure template builder rather than driving a real menu.
async function readTray(
  app: ElectronApplication,
): Promise<{ hasTray: boolean; items: TrayItem[] }> {
  return app.evaluate(() => {
    // The tray module exposes a test seam on globalThis (the native menu can't
    // be driven, and the live module instance can't be re-required here).
    const tray = (
      globalThis as unknown as {
        __prompty_tray: {
          hasTray: () => boolean;
          buildTrayMenuTemplate: () => { label?: string; enabled?: boolean }[];
        };
      }
    ).__prompty_tray;
    const items = tray.buildTrayMenuTemplate().map((i) => ({
      label: i.label,
      enabled: i.enabled !== false, // undefined → enabled (Electron default)
    }));
    return { hasTray: tray.hasTray(), items };
  });
}

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

test("onboarding: flow renders, advances, goes back, and completes", async () => {
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

    // ── Step 1: welcome renders — value-first, no "coach", dev button gated ──
    await expect(ob.locator("text=Meet Ruby")).toBeVisible({ timeout: 5_000 });
    await expect(ob.locator(".ob-body").first()).toContainText("whispers the right thing to say");
    await expect(ob.locator("body")).not.toContainText(/coach/i);
    await expect(ob.locator(".ob-dev-restart")).toHaveCount(0); // O15: hidden in prod build

    // ── The gem overlay appears with Ruby's speech bubble (set-ruby-message) ──
    // and shows the listening face (wave suppressed) during onboarding.
    const overlay = await findWindow(app, "overlay");
    await expect(overlay.locator(".gem-ruby-bubble")).toBeVisible({ timeout: 5_000 });
    await expect(overlay.locator('[data-testid="gem"]')).toHaveCount(1);

    // ── Advance welcome → "How Ruby works": the four moments, Live demoed ─────
    await ob.click("button.ob-btn-primary"); // "Get started →"
    await expect(ob.locator("text=How Ruby works")).toBeVisible({ timeout: 5_000 });
    for (const t of ["Prep", "Live", "Recap", "Memory"]) {
      await expect(ob.locator(`.ob-how-title:has-text("${t}")`)).toBeVisible();
    }
    await expect(ob.locator(".ob-how-live")).toHaveCount(1);
    await expect(ob.locator(".ob-progress-label")).toHaveText("Step 2 of 7"); // O8

    // ── Continue → Claude step (value-framed; exercises check-claude). ───────
    await ob.click("button.ob-btn-primary"); // "Continue →"
    await expect(ob.locator("text=Ruby thinks with Claude Code")).toBeVisible({ timeout: 5_000 });

    // ── O3 back nav: the back chevron returns to the How screen, then forward. ─
    await ob.getByTestId("ob-back").click();
    await expect(ob.locator("text=How Ruby works")).toBeVisible({ timeout: 5_000 });
    await ob.click("button.ob-btn-primary"); // "Continue →" again
    await expect(ob.locator("text=Ruby thinks with Claude Code")).toBeVisible({ timeout: 5_000 });

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

// The hotkey step lets the user actually experience the hotkey: pressing it
// blooms a real nudge in the gem (the same dark-glass surface as in-call). The
// OS-level global shortcut can't be driven from a test, but the fallback IPC
// path (onboarding:fire-nudge) goes through the exact same fireOnboardingNudge →
// nudge:received → overlay bloom plumbing, so it's the faithful proxy. We also
// assert arm-hotkey registers the real shortcut and that repeat presses cycle
// the sample question.
test("onboarding: arming the hotkey blooms a real nudge in the gem", async () => {
  test.setTimeout(60_000);

  const dir = await freshUserDataDir("e2e-onboarding-hotkey");
  await fs.writeFile(
    path.join(dir, "prompty-settings.json"),
    JSON.stringify({ onboardingCompleted: false, hotkey: "Alt+Shift+Space" }),
    "utf8",
  );

  const app = await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${dir}`],
    env: { ...process.env },
  });

  try {
    const ob = await findWindow(app, "onboarding");
    await expect(ob.locator("text=Meet Ruby")).toBeVisible({ timeout: 5_000 });
    const overlay = await findWindow(app, "overlay");

    // Arm the real global shortcut + enter onboarding-nudge mode. On a clean CI
    // box Alt+Shift+Space is free, so it registers.
    const arm = (await ob.evaluate(async () =>
      (window as unknown as Bridge).prompty.invoke("onboarding:arm-hotkey", undefined),
    )) as ArmResult;
    expect(arm.ok).toBe(true);
    expect(arm.registered).toBe(true);
    expect(arm.conflict).toBe(false);

    // Simulate the press (the fallback path == the real callback's body).
    await ob.evaluate(async () =>
      (window as unknown as Bridge).prompty.invoke("onboarding:fire-nudge", undefined),
    );

    // The real nudge surface blooms in the gem: dark-glass card, a calm "Ruby"
    // tag (the sample nudges are medium urgency), and one of the sample questions.
    const bloom = overlay.locator('[data-testid="gem-bloom"]');
    await expect(bloom).toBeVisible({ timeout: 5_000 });
    await expect(bloom.locator(".gem-note-tag")).toHaveText("Worth asking");
    const firstText = (await bloom.locator(".gem-note-q").textContent())?.trim() ?? "";
    expect(firstText.length).toBeGreaterThan(0);

    // A second press cycles to a different sample question.
    await ob.evaluate(async () =>
      (window as unknown as Bridge).prompty.invoke("onboarding:fire-nudge", undefined),
    );
    await expect
      .poll(async () => (await bloom.locator(".gem-note-q").textContent())?.trim() ?? "", {
        timeout: 5_000,
      })
      .not.toBe(firstText);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// The menu-bar tray must exist during onboarding (the app is already live then),
// but "Open main window" stays disabled until onboarding completes so the tray
// can't yank the user out of the guided flow. Quit is always available.
test("onboarding: tray is present, with Open main window gated until complete", async () => {
  test.setTimeout(60_000);

  const dir = await freshUserDataDir("e2e-onboarding-tray");
  const settingsPath = path.join(dir, "prompty-settings.json");
  await fs.writeFile(
    settingsPath,
    JSON.stringify({ onboardingCompleted: false, hotkey: "Alt+Shift+Space" }),
    "utf8",
  );

  const app = await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${dir}`],
    env: { ...process.env },
  });

  try {
    const ob = await findWindow(app, "onboarding");
    await expect(ob.locator("text=Meet Ruby")).toBeVisible({ timeout: 5_000 });

    // During onboarding: tray exists; "Open main window" disabled; Quit enabled.
    const during = await readTray(app);
    expect(during.hasTray).toBe(true);
    const openDuring = during.items.find((i) => i.label === "Open main window");
    expect(openDuring?.enabled).toBe(false);
    expect(during.items.find((i) => i.label === "Quit Ruby")?.enabled).toBe(true);

    // Complete onboarding (fire-and-forget: the handler tears down this window).
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

    // After completion: "Open main window" becomes enabled.
    await expect
      .poll(async () => (await readTray(app)).items.find((i) => i.label === "Open main window")?.enabled, {
        timeout: 5_000,
      })
      .toBe(true);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
