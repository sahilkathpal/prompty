// Regression spec for the proactive Google-revoke → signed-out-UI fix. Exercises:
//   PRIMARY: a signed-in Account row in the REAL renderer ends up "Not signed in"
//            after a forced revoke, triggered by ORDINARY activity (opening the
//            Settings window — no call started), and the local google-session.bin
//            is cleared. Guards against the "phantom signed-in" regression where
//            status was trusted from the on-disk file and never revalidated.
//   SECONDARY: a call-start blocked by a revoked session surfaces the softened
//            "You've been signed out …" copy, never a raw invalid_grant string.
// A forced revoke (PROMPTY_E2E_FORCE_REVOKE) resolves with zero latency, so the
// revalidation triggered on Settings-open flips the row immediately — the row is
// signed-out from first paint. The signed-in baseline is covered by the control
// test below (no revoke → the row shows and stays on the seeded email).
import { test, expect, _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

const APP_ROOT = path.resolve(__dirname, "../..");
const UNREACHABLE_RELAY = "http://127.0.0.1:1";

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-verify-revoke-"));
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
      lastTab: "settings",
      signedIn: true,
      signedInUserId: "seed-sub-123",
      signedInEmail: "seed@example.com",
    }),
    "utf8",
  );
}

async function seedGoogleSession(userDataDir: string, expiresAt: number): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, "google-session.bin"),
    JSON.stringify({
      accessToken: "seed-access",
      refreshToken: "seed-refresh",
      expiresAt,
      sub: "seed-sub-123",
      email: "seed@example.com",
      idToken: "seed-id-token",
    }),
    "utf8",
  );
}

function sessionFile(userDataDir: string): string {
  return path.join(userDataDir, "google-session.bin");
}

async function launch(userDataDir: string, env: Record<string, string>): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_AGENT: "1",
      NODE_ENV: "development",
      PROMPTY_RELAY_URL: UNREACHABLE_RELAY,
      ...env,
    },
  });
}

async function waitForReady(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: e }) => {
    if (!e.isReady()) await new Promise<void>((r) => e.once("ready", () => r()));
  });
}

async function openMainWindow(app: ElectronApplication): Promise<Page> {
  await app.evaluate(async () => {
    (globalThis as unknown as { __prompty_e2e: { openMainWindow: (t?: string) => void } }).__prompty_e2e.openMainWindow(
      "settings",
    );
  });
  for (let i = 0; i < 100; i++) {
    for (const w of app.windows()) if (w.url().includes("main-window")) return w;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("main window never appeared");
}

function accountRow(page: Page) {
  return page
    .locator(".set-row", { has: page.locator(".set-label", { hasText: /^Account$/ }) })
    .locator(".set-val");
}

async function analyticsEvents(app: ElectronApplication): Promise<string[]> {
  const evs = (await app.evaluate(async () =>
    (globalThis as unknown as { __prompty_e2e: { getAnalyticsEvents: () => { event: string }[] } }).__prompty_e2e.getAnalyticsEvents(),
  )) as { event: string }[];
  return evs.map((e) => e.event);
}

async function startSession(app: ElectronApplication): Promise<{ ok: boolean; error?: string }> {
  return (await app.evaluate(async () =>
    (globalThis as unknown as {
      __prompty_e2e: { startSession: () => Promise<{ ok: boolean; error?: string }> };
    }).__prompty_e2e.startSession(),
  )) as { ok: boolean; error?: string };
}

// ── CONTROL: no revoke → the Account row stays signed-in (shows the email). ─────
test("control: signed-in Account row stays signed-in when not revoked", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  await seedGoogleSession(userDataDir, Date.now() + 60 * 60 * 1000);
  const app = await launch(userDataDir, { PROMPTY_MOCK_DEEPGRAM: "1" }); // NO force-revoke
  try {
    await waitForReady(app);
    const page = await openMainWindow(app);
    await page.getByTestId("nav-settings").click();
    await expect(accountRow(page)).toContainText("seed@example.com", { timeout: 8000 });
    // A window focus re-queries auth:status; absent a revoke it must NOT sign out.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await new Promise((r) => setTimeout(r, 2500));
    await expect(accountRow(page)).toContainText("seed@example.com");
    expect(existsSync(sessionFile(userDataDir))).toBe(true);
  } finally {
    await app.close();
  }
});

// ── PRIMARY: forced revoke → the real Account row flips to signed-out, no call. ─
test("primary: forced revoke flips the real Account row to signed-out with no call", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  await seedGoogleSession(userDataDir, Date.now() + 60 * 60 * 1000);
  const app = await launch(userDataDir, { PROMPTY_MOCK_DEEPGRAM: "1", PROMPTY_E2E_FORCE_REVOKE: "1" });
  try {
    await waitForReady(app);
    expect(existsSync(sessionFile(userDataDir))).toBe(true); // signed-in on disk to start

    const page = await openMainWindow(app);
    await page.getByTestId("nav-settings").click();
    // Ordinary activity: opening Settings re-syncs the account via auth:status,
    // which kicks the proactive revalidation. Under the forced revoke that clears
    // the revoked session and broadcasts signed-out — the row must reflect it,
    // with NO call ever started, and the signed-out push must not be clobbered by
    // the concurrent optimistic auth:status pull (the ordering-race guard).
    await expect(accountRow(page)).toContainText("Not signed in", { timeout: 10000 });

    // The local Google session was cleared from disk by the proactive revalidate.
    expect(existsSync(sessionFile(userDataDir))).toBe(false);
    // The re-auth teardown ran; no call was started.
    const events = await analyticsEvents(app);
    expect(events).toContain("auth_reauth_required");
    expect(events).not.toContain("call_started");
  } finally {
    await app.close();
  }
});

// ── SECONDARY: softened copy on a call-start blocked by a revoked session. ──────
test("secondary: call-start on a revoked session shows softened copy, no raw invalid_grant", async () => {
  const userDataDir = await freshUserDataDir();
  await seedSettings(userDataDir);
  // Expired so getDeepgramToken forces a refresh → FORCE_REVOKE → revoke path.
  await seedGoogleSession(userDataDir, Date.now() - 60 * 1000);
  // MOCK_DEEPGRAM deliberately absent so the REAL getDeepgramKey path (and its
  // softened-error mapping in coach-session) runs. Preflight still passes via E2E.
  // DEEPGRAM_API_KEY="" (defined, so the repo-root .env loader won't set it)
  // blocks the dev-key seam that would otherwise start the call outright.
  const app = await launch(userDataDir, { PROMPTY_E2E_FORCE_REVOKE: "1", DEEPGRAM_API_KEY: "" });
  try {
    await waitForReady(app);
    const res = await startSession(app);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("You've been signed out — open Ruby and sign in again to start calls.");
    expect(res.error ?? "").not.toMatch(/invalid_grant|refresh token revoked|not signed in/i);
  } finally {
    await app.close();
  }
});
