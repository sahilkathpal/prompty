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

// Home readiness banner: the three hard call-start requirements (signed in, mic
// granted, Claude found) are surfaced proactively on Home — not only when the
// user hits the call-start wall. This spec focuses on the AUTH item because it's
// the one we can drive deterministically (mic/Claude depend on the real machine
// state). It also proves the live wiring: signing out from Settings makes the
// Home prompt reappear without a relaunch — the exact gap this feature closes.

async function seedGoogleSession(userDataDir: string): Promise<void> {
  await fs.writeFile(
    path.join(userDataDir, "google-session.bin"),
    JSON.stringify({
      accessToken: "seed-access",
      refreshToken: "seed-refresh",
      expiresAt: Date.now() + 60 * 60 * 1000,
      sub: "seed-sub-123",
      email: "verify@example.com",
      idToken: "seed-id-token",
    }),
    "utf8",
  );
}

test("Home: a signed-out user is prompted to sign in (with an inline action)", async () => {
  const dir = await freshUserDataDir("e2e-readiness-out");
  await seedSettings(dir);

  const app = await launchApp(dir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // The setup banner is present, with the auth item + its action button.
    await expect(page.getByTestId("home-setup")).toBeVisible();
    const authItem = page.getByTestId("home-setup-auth");
    await expect(authItem).toBeVisible();
    await expect(authItem).toContainText("Sign in");
    const action = page.getByTestId("home-setup-auth-action");
    await expect(action).toBeVisible();
    await expect(action).toHaveText("Sign in with Google");
    await expect(action).toBeEnabled();
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Home: a signed-in user gets no sign-in prompt", async () => {
  const dir = await freshUserDataDir("e2e-readiness-in");
  await seedSettings(dir);
  await seedGoogleSession(dir);

  const app = await launchApp(dir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // Account is satisfied, so the auth item must not appear (mic/Claude items
    // may or may not, depending on the machine — we assert only on auth).
    await expect(page.getByTestId("home-setup-auth")).toHaveCount(0);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Home: signing out from Settings makes the sign-in prompt reappear live", async () => {
  const dir = await freshUserDataDir("e2e-readiness-live");
  await seedSettings(dir);
  await seedGoogleSession(dir);

  const app = await launchApp(dir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // Signed in → no auth prompt on Home.
    await expect(page.getByTestId("home-setup-auth")).toHaveCount(0);

    // Sign out from Settings (confirm guard).
    await page.getByTestId("nav-settings").click();
    const acctRow = page.locator(".set-row", { hasText: "Account" });
    await acctRow.getByRole("button", { name: "Sign out" }).click();
    await acctRow.locator(".set-btn-danger").click();
    await expect(acctRow).toContainText("Not signed in");

    // Back to Home — the prompt is now there, no relaunch needed.
    await page.locator(".pcs-back").click();
    await expect(page.getByTestId("home-setup-auth")).toBeVisible();
    await expect(page.getByTestId("home-setup-auth")).toContainText("Sign in");
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
