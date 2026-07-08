import { test, expect } from "@playwright/test";
import {
  launchApp,
  freshUserDataDir,
  seedSettings,
  waitForReady,
  openMainWindow,
  getMainPage,
} from "./_helpers";
import fs from "node:fs/promises";

type Ev = { event: string; properties: Record<string, unknown> };

// PostHog identity is main-process only. Under PROMPTY_E2E the client never
// touches the network — instead alias()/identify()/rotate ops are recorded into
// the same ring buffer as capture(), so we can assert the exact sequence.
//
// This pins the Phase-1 identity fix: alias fires ONLY at sign-in (never on
// relaunch), and sign-out rotates the anon id so a second account on one device
// can't cross-merge into the first.

test("identity: returning signed-in user re-identifies WITHOUT aliasing", async () => {
  test.setTimeout(60_000);

  const dir = await freshUserDataDir("identity-relaunch");
  // A returning user: signed in, with an anon id already on disk.
  await seedSettings(dir, {
    signedIn: true,
    signedInUserId: "google_user_relaunch",
    analyticsAnonId: "anon_seeded",
  });
  const app = await launchApp(dir);
  try {
    await waitForReady(app);

    const evs = (): Promise<Ev[]> =>
      app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { getAnalyticsEvents: () => Ev[] } }).__prompty_e2e.getAnalyticsEvents());

    // Launch re-identifies the returning user...
    await expect
      .poll(async () => (await evs()).some((e) => e.event === "$identify" && e.properties.distinct_id === "google_user_relaunch"), { timeout: 5_000 })
      .toBe(true);
    // ...but must NOT alias on relaunch (the bug this phase fixes).
    expect((await evs()).some((e) => e.event === "$create_alias")).toBe(false);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("identity: sign-in aliases once; sign-out rotates anon; next sign-in aliases the NEW anon", async () => {
  test.setTimeout(60_000);

  const dir = await freshUserDataDir("identity-switch");
  await seedSettings(dir); // not signed in
  const app = await launchApp(dir);
  try {
    await waitForReady(app);

    const evs = (): Promise<Ev[]> =>
      app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { getAnalyticsEvents: () => Ev[] } }).__prompty_e2e.getAnalyticsEvents());
    const settings = (): Promise<{ analyticsAnonId: string }> =>
      app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { getSettings: () => { analyticsAnonId: string } } }).__prompty_e2e.getSettings());
    const aliasEvents = async (): Promise<Ev[]> => (await evs()).filter((e) => e.event === "$create_alias");

    // No identity events before sign-in (not signed in at launch).
    expect((await aliasEvents()).length).toBe(0);

    // Account A signs in: exactly one alias + one identify, alias target = the
    // current anon id.
    await app.evaluate((_el, uid) => (globalThis as unknown as { __prompty_e2e: { signInIdentity: (u: string) => void } }).__prompty_e2e.signInIdentity(uid), "google_user_A");
    await expect.poll(async () => (await aliasEvents()).length, { timeout: 5_000 }).toBe(1);
    const aliasA = (await aliasEvents())[0];
    expect(aliasA.properties.distinct_id).toBe("google_user_A");
    const anonA = aliasA.properties.alias as string;
    expect((await settings()).analyticsAnonId).toBe(anonA);
    expect((await evs()).filter((e) => e.event === "$identify" && e.properties.distinct_id === "google_user_A").length).toBe(1);

    // Sign out (real IPC handler) → rotates the anon id.
    await openMainWindow(app);
    const main = await getMainPage(app);
    await main.evaluate(() => (window as unknown as { prompty: { invoke: (c: string, p?: unknown) => Promise<unknown> } }).prompty.invoke("auth:sign-out"));
    await expect.poll(async () => (await settings()).analyticsAnonId, { timeout: 5_000 }).not.toBe(anonA);
    const anonB = (await settings()).analyticsAnonId;

    // Account B signs in on the same device: aliases the ROTATED anon, never A's.
    await app.evaluate((_el, uid) => (globalThis as unknown as { __prompty_e2e: { signInIdentity: (u: string) => void } }).__prompty_e2e.signInIdentity(uid), "google_user_B");
    await expect.poll(async () => (await aliasEvents()).length, { timeout: 5_000 }).toBe(2);
    const aliasB = (await aliasEvents())[1];
    expect(aliasB.properties.distinct_id).toBe("google_user_B");
    expect(aliasB.properties.alias).toBe(anonB);
    expect(aliasB.properties.alias).not.toBe(anonA);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
