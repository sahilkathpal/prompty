import { test, expect, _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

const APP_ROOT = path.resolve(__dirname, "../..");

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-stage4-"));
}

async function seedSettings(userDataDir: string): Promise<void> {
  const file = path.join(userDataDir, "prompty-settings.json");
  await fs.mkdir(userDataDir, { recursive: true });
  const settings = {
    compact: false,
    panelPosition: null,
    launchAtLogin: false,
    hotkey: "Alt+Shift+Space",
    signedIn: true,
    onboardingCompleted: true,
    loginItemPrompted: true,
    signedInUserId: "google-sub-abc",
    signedInEmail: "alice@example.com",
    lastTab: "prep",
  };
  await fs.writeFile(file, JSON.stringify(settings, null, 2), "utf8");
}

async function seedSession(userDataDir: string): Promise<void> {
  const file = path.join(userDataDir, "google-session.bin");
  await fs.writeFile(
    file,
    JSON.stringify({
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: Date.now() + 3_600_000,
      sub: "google-sub-abc",
      email: "alice@example.com",
      idToken: "fake-id-token",
    }),
    "utf8",
  );
}

async function launchApp(
  userDataDir: string,
  extraEnv: Record<string, string> = {},
): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      PROMPTY_MOCK_AGENT: "1",
      PROMPTY_MOCK_PREP: "1",
      PROMPTY_PENDING_PREP_DIR: userDataDir,
      NODE_ENV: "development",
      ...extraEnv,
    },
  });
}

async function waitForReady(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: electronApp }) => {
    if (!electronApp.isReady()) {
      await new Promise<void>((resolve) => electronApp.once("ready", () => resolve()));
    }
  });
}

async function getMainPage(app: ElectronApplication, tab = "prep"): Promise<Page> {
  await app.evaluate(async (_ctx, t) => {
    const handles = (globalThis as unknown as {
      __prompty_e2e: { openMainWindow: (tab: string) => void };
    }).__prompty_e2e;
    handles.openMainWindow(t);
  }, tab);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pages = app.windows();
    const candidate = pages.find((p) => p.url().includes("main-window"));
    if (candidate) {
      await candidate.waitForSelector('[data-testid="main-window-root"]', { timeout: 10_000 });
      return candidate;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("main window not found");
}

async function getPrepPage(app: ElectronApplication): Promise<Page> {
  // Prep UI now lives inside the main window's Prep tab.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pages = app.windows();
    const candidate = pages.find((p) => p.url().includes("main-window"));
    if (candidate) {
      try {
        await candidate.waitForSelector('[data-testid="prep-root"]', {
          timeout: 1_000,
        });
        return candidate;
      } catch {
        // not yet rendered — keep polling
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("prep UI not found in main window");
}

function prepWindowExists(app: ElectronApplication): Promise<boolean> {
  // Returns true while the prep UI is rendered in any window (now the main
  // window's Prep tab). After Save/Discard the prep-root element disappears.
  return app.evaluate(async ({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      if (!w.webContents.getURL().includes("main-window")) continue;
      const has = await w.webContents.executeJavaScript(
        '!!document.querySelector(\'[data-testid="prep-root"]\')',
      );
      if (has) return true;
    }
    return false;
  });
}

function overlayVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => {
    return BrowserWindow.getAllWindows().some(
      (w) =>
        !w.isDestroyed() &&
        w.isVisible() &&
        w.webContents.getURL().includes("overlay"),
    );
  });
}

test("Stage 4: Open prep window from Prep tab (ad-hoc)", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    const page = await getMainPage(app, "prep");
    await page.click('[data-testid="home-adhoc-button"]');
    const prep = await getPrepPage(app);
    await prep.waitForSelector('[data-testid="prep-adhoc-title"]', { timeout: 5_000 });
    expect(await prep.textContent('[data-testid="prep-adhoc-title"]')).toContain(
      "Ad-hoc call prep",
    );
  } finally {
    await app.close();
  }
});

test("Stage 4: Conversation produces goal + checklist", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    const page = await getMainPage(app, "prep");
    await page.click('[data-testid="home-adhoc-button"]');
    const prep = await getPrepPage(app);

    // Turn 1.
    await prep.fill('[data-testid="prep-input"]', "Discovery call about Kafka.");
    await prep.click('[data-testid="prep-send"]');
    // Wait for assistant streaming to finish.
    await prep.waitForFunction(
      () => {
        const el = document.querySelectorAll('[data-testid="prep-msg-assistant"]');
        return el.length >= 1;
      },
      { timeout: 10_000 },
    );

    // Turn 2 (mock factory sets goal + 3 checklist items here).
    await prep.fill(
      '[data-testid="prep-input"]',
      "Goal: validate budget and timeline.",
    );
    await prep.click('[data-testid="prep-send"]');

    await prep.waitForFunction(
      () => {
        const goalCard = document.querySelector('[data-testid="prep-goal-card"]');
        const checklistCard = document.querySelector(
          '[data-testid="prep-checklist-card"]',
        );
        return (
          !!goalCard &&
          /Mock goal/.test(goalCard.textContent ?? "") &&
          !!checklistCard &&
          (checklistCard.textContent?.match(/·/g)?.length ?? 0) >= 3
        );
      },
      { timeout: 15_000 },
    );

    // Chip row visible with all four mode chips.
    await prep.waitForSelector('[data-testid="prep-mode-row"]');
    for (const m of ["default", "discovery", "user-interview", "hiring"]) {
      await prep.waitForSelector(`[data-testid="prep-mode-chip-${m}"]`);
    }
  } finally {
    await app.close();
  }
});

test("Stage 4: Mode chip click updates state", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    const page = await getMainPage(app, "prep");
    await page.click('[data-testid="home-adhoc-button"]');
    const prep = await getPrepPage(app);

    // Wait for chip row to render.
    await prep.waitForSelector('[data-testid="prep-mode-row"]');

    for (const m of ["discovery", "user-interview", "hiring", "default"]) {
      await prep.click(`[data-testid="prep-mode-chip-${m}"]`);
      await prep.waitForFunction(
        (mode) => {
          const el = document.querySelector(
            `[data-testid="prep-mode-chip-${mode}"]`,
          );
          return !!el && el.getAttribute("data-active") === "true";
        },
        m,
        { timeout: 5_000 },
      );
      // Verify others are not active.
      const activeChips = await prep.$$eval(
        '[data-testid^="prep-mode-chip-"][data-active="true"]',
        (els) => els.map((e) => e.getAttribute("data-testid")),
      );
      expect(activeChips).toEqual([`prep-mode-chip-${m}`]);
    }
  } finally {
    await app.close();
  }
});

test("Stage 4: Save & start coaching closes prep window, opens overlay, clears pending", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const callLogDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-stage4-calls-"));

  const app = await launchApp(userDataDir, { PROMPTY_CALL_LOG_DIR: callLogDir });
  try {
    await waitForReady(app);
    const page = await getMainPage(app, "prep");
    await page.click('[data-testid="home-adhoc-button"]');
    const prep = await getPrepPage(app);

    await prep.fill('[data-testid="prep-input"]', "Discovery call.");
    await prep.click('[data-testid="prep-send"]');
    await prep.waitForSelector('[data-testid="prep-msg-assistant"]', { timeout: 10_000 });
    await prep.fill('[data-testid="prep-input"]', "Goal: validate budget.");
    await prep.click('[data-testid="prep-send"]');
    await prep.waitForFunction(
      () => {
        const btn = document.querySelector(
          '[data-testid="prep-save-start"]',
        ) as HTMLButtonElement | null;
        return !!btn && !btn.disabled;
      },
      { timeout: 15_000 },
    );

    await prep.click('[data-testid="prep-save-start"]');

    // Prep window should close.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const exists = await prepWindowExists(app);
      if (!exists) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(await prepWindowExists(app)).toBe(false);

    // Overlay should become visible.
    const od = Date.now() + 10_000;
    let vis = false;
    while (Date.now() < od) {
      vis = await overlayVisible(app);
      if (vis) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(vis).toBe(true);

    // Pending prep should be cleared.
    const pending = await app.evaluate(() =>
      (globalThis as unknown as {
        __prompty_e2e: { getPendingPrep: () => unknown };
      }).__prompty_e2e.getPendingPrep(),
    );
    expect(pending).toBeNull();
  } finally {
    await app.close();
  }
});

test("Stage 4: Save & close persists pending prep, main window shows card", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    const page = await getMainPage(app, "prep");
    await page.click('[data-testid="home-adhoc-button"]');
    const prep = await getPrepPage(app);

    await prep.fill('[data-testid="prep-input"]', "Discovery.");
    await prep.click('[data-testid="prep-send"]');
    await prep.waitForSelector('[data-testid="prep-msg-assistant"]', { timeout: 10_000 });
    await prep.fill('[data-testid="prep-input"]', "Goal here.");
    await prep.click('[data-testid="prep-send"]');
    await prep.waitForFunction(
      () => {
        const btn = document.querySelector(
          '[data-testid="prep-save-close"]',
        ) as HTMLButtonElement | null;
        return !!btn && !btn.disabled;
      },
      { timeout: 15_000 },
    );
    await prep.click('[data-testid="prep-save-close"]');

    // Prep window closes.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!(await prepWindowExists(app))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(await prepWindowExists(app)).toBe(false);

    // Main window: pending prep card appears with Start/Resume/Discard.
    await page.waitForSelector('[data-testid="pending-prep-card"]', { timeout: 10_000 });
    await page.waitForSelector('[data-testid="pending-prep-start"]');
    await page.waitForSelector('[data-testid="pending-prep-resume"]');
    await page.waitForSelector('[data-testid="pending-prep-discard"]');
  } finally {
    await app.close();
  }
});

test("Stage 4: Resume prep restores the original chat thread", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    const page = await getMainPage(app, "prep");
    await page.click('[data-testid="home-adhoc-button"]');
    const prep = await getPrepPage(app);

    // Build a thread with a recognisable user message.
    await prep.fill(
      '[data-testid="prep-input"]',
      "Talking with Linear about Kafka migration.",
    );
    await prep.click('[data-testid="prep-send"]');
    await prep.waitForSelector('[data-testid="prep-msg-assistant"]', {
      timeout: 10_000,
    });
    await prep.fill('[data-testid="prep-input"]', "Goal: validate budget.");
    await prep.click('[data-testid="prep-send"]');
    await prep.waitForFunction(
      () => {
        const btn = document.querySelector(
          '[data-testid="prep-save-close"]',
        ) as HTMLButtonElement | null;
        return !!btn && !btn.disabled;
      },
      { timeout: 15_000 },
    );
    await prep.click('[data-testid="prep-save-close"]');

    // Pending-prep card appears, prep UI is gone.
    await page.waitForSelector('[data-testid="pending-prep-card"]', {
      timeout: 10_000,
    });
    await page.waitForSelector('[data-testid="pending-prep-resume"]');

    // Resume the prep.
    await page.click('[data-testid="pending-prep-resume"]');
    const resumed = await getPrepPage(app);

    // The original user message should be visible in the resumed thread.
    await resumed.waitForFunction(
      () => {
        const userMsgs = Array.from(
          document.querySelectorAll('[data-testid="prep-msg-user"]'),
        ).map((el) => el.textContent ?? "");
        return userMsgs.some((t) => /Kafka migration/.test(t));
      },
      { timeout: 10_000 },
    );

    // Goal + checklist must also have been re-hydrated.
    const goalText = await resumed.textContent('[data-testid="prep-goal-card"]');
    expect(goalText).toMatch(/Mock goal/);
  } finally {
    await app.close();
  }
});

test("Stage 4: Notification click opens prep window pre-populated with event", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir, { PROMPTY_E2E_FAKE_EVENT: "1" });
  try {
    await waitForReady(app);

    // Force an arm so an event is current.
    await app.evaluate(async () => {
      const handles = (globalThis as unknown as {
        __prompty_e2e: { pollCalendarArm: () => Promise<void> };
      }).__prompty_e2e;
      await handles.pollCalendarArm();
    });

    // Simulate notification click.
    await app.evaluate(async () => {
      const handles = (globalThis as unknown as {
        __prompty_e2e: { fireNotificationClick: (id?: string) => Promise<unknown> };
      }).__prompty_e2e;
      await handles.fireNotificationClick();
    });

    const prep = await getPrepPage(app);
    const headerText = await prep.textContent('[data-testid="prep-header"]');
    expect(headerText).toContain("Discovery call with Alex Chen");
  } finally {
    await app.close();
  }
});

test("Stage 4: Direct rail editing — set goal, add and remove checklist item", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  await seedSession(userDataDir);

  const app = await launchApp(userDataDir);
  try {
    await waitForReady(app);
    const page = await getMainPage(app, "prep");
    await page.click('[data-testid="home-adhoc-button"]');
    const prep = await getPrepPage(app);

    // Goal starts empty → click to edit, type, commit with Enter.
    await prep.click('[data-testid="prep-goal-empty"]');
    await prep.fill('[data-testid="prep-goal-input"]', "Close the pilot");
    await prep.press('[data-testid="prep-goal-input"]', "Enter");
    await prep.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="prep-goal-text"]');
        return !!el && /Close the pilot/.test(el.textContent ?? "");
      },
      undefined,
      { timeout: 5_000 },
    );

    // A "You set goal" trace line appears in the thread (distinct from model edits).
    await prep.waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll('[data-testid="prep-msg-tool"]'),
        ).some((n) => /You set goal: Close the pilot/.test(n.textContent ?? "")),
      undefined,
      { timeout: 5_000 },
    );

    // Add a checklist item via the rail.
    await prep.click('[data-testid="prep-check-add"]');
    await prep.fill('[data-testid="prep-check-add-input"]', "Budget owner");
    await prep.press('[data-testid="prep-check-add-input"]', "Enter");
    await prep.waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll('[data-testid="prep-check-text"]'),
        ).some((n) => /Budget owner/.test(n.textContent ?? "")),
      undefined,
      { timeout: 5_000 },
    );

    // Remove it — the × is hover-revealed (opacity 0), so click it via JS.
    const clicked = await prep.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll('[data-testid="prep-check-row"]'),
      );
      const row = rows.find((r) => /Budget owner/.test(r.textContent ?? ""));
      const btn = row?.querySelector(
        '[data-testid="prep-check-remove"]',
      ) as HTMLButtonElement | null;
      if (!btn) return false;
      btn.click();
      return true;
    });
    expect(clicked).toBe(true);
    await prep.waitForFunction(
      () =>
        !Array.from(
          document.querySelectorAll('[data-testid="prep-check-text"]'),
        ).some((n) => /Budget owner/.test(n.textContent ?? "")),
      undefined,
      { timeout: 5_000 },
    );
  } finally {
    await app.close();
  }
});
