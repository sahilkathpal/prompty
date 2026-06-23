import { test, expect } from "@playwright/test";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  openMainWindow,
  getMainPage,
} from "./_helpers";
import path from "node:path";
import fs from "node:fs/promises";

// Phase 7 — Settings legibility + a11y sweep + final cleanup. Drives the real
// built app and asserts the reworked Settings + Memory surfaces:
//   - group headers (M6)
//   - friendly status, not raw enums/paths (M5/M11)
//   - the Debug logs row gated behind PROMPTY_DEBUG (M4b)
//   - sign-out confirm guard (M3)
//   - reversible memory delete via the Undo toast (M2)
//   - keyboard reachability of interactive controls (X6)

async function seedGoogleSession(userDataDir: string): Promise<void> {
  await fs.writeFile(
    path.join(userDataDir, "google-session.bin"),
    JSON.stringify({
      accessToken: "seed-access",
      refreshToken: "seed-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      sub: "seed-sub-123",
      email: "seed@example.com",
      idToken: "seed-id-token",
    }),
    "utf8",
  );
}

test("Settings: group headers, friendly status, and Debug row gated by PROMPTY_DEBUG", async () => {
  const dir = await freshUserDataDir("e2e-phase7-settings");
  await seedSettings(dir);

  // Default launch: PROMPTY_DEBUG explicitly off so the Debug row stays hidden.
  const app = await launchApp(dir, { env: { PROMPTY_DEBUG: "0" } });
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    await page.getByTestId("nav-settings").click();
    await expect(page.locator("text=Settings").first()).toBeVisible();

    // M6: uppercase group headers.
    await expect(page.locator(".set-group-label", { hasText: "Permissions" })).toBeVisible();
    await expect(page.locator(".set-group-label", { hasText: "Account" })).toBeVisible();
    await expect(page.locator(".set-group-label", { hasText: "Advanced" })).toBeVisible();

    // M5: the Claude row shows a friendly status, never a raw filesystem path.
    const claudeRow = page.locator(".set-row", { hasText: "Claude Code" });
    await expect(claudeRow).toBeVisible();
    const claudeVal = (await claudeRow.locator(".set-val").textContent())?.trim() ?? "";
    expect(claudeVal).toMatch(/^(Connected|Not found|checking…)$/);
    expect(claudeVal).not.toContain("/");

    // M11: the mic row maps the permission enum to plain language (never the raw
    // "granted"/"denied"/"restricted").
    const micRow = page.locator(".set-row", { hasText: "Microphone" });
    const micVal = (await micRow.locator(".set-val").textContent())?.trim() ?? "";
    expect(micVal).not.toMatch(/granted|denied|restricted/);

    // M10: the hotkey row explains what the shortcut does.
    await expect(page.locator(".set-hint", { hasText: "ask Ruby for a nudge mid-call" })).toBeVisible();

    // M4b: no Debug logs row without the flag.
    await expect(page.locator(".set-row", { hasText: "Debug logs" })).toHaveCount(0);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }

  // Relaunch with the flag on — the Debug row appears.
  const app2 = await launchApp(dir, { env: { PROMPTY_DEBUG: "1" } });
  try {
    await waitForReady(app2);
    await openMainWindow(app2);
    const page = await getMainPage(app2);
    await page.getByTestId("nav-settings").click();
    await expect(page.locator(".set-row", { hasText: "Debug logs" })).toBeVisible();
  } finally {
    await app2.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Settings: sign out asks for confirmation before tearing down the session", async () => {
  const dir = await freshUserDataDir("e2e-phase7-signout");
  await seedSettings(dir);
  await seedGoogleSession(dir);

  const app = await launchApp(dir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    await page.getByTestId("nav-settings").click();
    const acctRow = page.locator(".set-row", { hasText: "Account" });
    await expect(acctRow).toContainText("seed@example.com");
    await expect(acctRow.locator(".set-connected-pill")).toHaveText("Signed in");

    // First click reveals a confirm with the consequence spelled out — it does
    // NOT sign out yet.
    await acctRow.getByRole("button", { name: "Sign out" }).click();
    await expect(page.locator(".set-confirm-text")).toContainText("sign in again");
    await expect(acctRow).toContainText("seed@example.com"); // still signed in

    // Cancel returns to the single Sign out button.
    await acctRow.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".set-confirm-text")).toHaveCount(0);
    await expect(acctRow).toContainText("seed@example.com");
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Memory: delete is reversible via the Undo toast", async () => {
  const dir = await freshUserDataDir("e2e-phase7-memundo");
  const memoryFile = path.join(dir, "memory.json");
  await seedSettings(dir);

  const app = await launchApp(dir, { env: { PROMPTY_MEMORY_FILE: memoryFile } });
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    await page.getByTestId("nav-memory").click();
    const FIRST = "Don't interrupt when I'm mid-sentence.";
    const SECOND = "Keep nudges short.";
    await page.getByTestId("memory-input").fill(FIRST);
    await page.getByTestId("memory-add").click();
    await page.getByTestId("memory-input").fill(SECOND);
    await page.getByTestId("memory-add").click();
    await expect(page.getByTestId("memory-item")).toHaveCount(2);
    await expect(page.getByTestId("memory-item").first()).toContainText(FIRST);

    // Delete the FIRST row → it goes, but an Undo toast appears.
    await page.getByTestId("memory-delete").first().click();
    await expect(page.getByTestId("memory-item")).toHaveCount(1);
    await expect(page.getByTestId("memory-undo")).toBeVisible();

    // M2: Undo restores it IN PLACE — back at the front, not appended to the end.
    await page.getByTestId("memory-undo-btn").click();
    await expect(page.getByTestId("memory-item")).toHaveCount(2);
    await expect(page.getByTestId("memory-item").first()).toContainText(FIRST);
    await expect(page.getByTestId("memory-item").nth(1)).toContainText(SECOND);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a11y: Settings back button and nav controls are keyboard-focusable", async () => {
  const dir = await freshUserDataDir("e2e-phase7-a11y");
  await seedSettings(dir);

  const app = await launchApp(dir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // The home nav icons are real <button>s, reachable by keyboard.
    const focusedTag = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="nav-settings"]') as HTMLElement | null;
      btn?.focus();
      return document.activeElement?.getAttribute("data-testid");
    });
    expect(focusedTag).toBe("nav-settings");

    await page.getByTestId("nav-settings").click();
    // The back button takes focus and is a button (keyboard-operable).
    const backIsButton = await page.evaluate(() => {
      const back = document.querySelector(".pcs-back") as HTMLElement | null;
      back?.focus();
      return document.activeElement?.tagName === "BUTTON";
    });
    expect(backIsButton).toBe(true);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
