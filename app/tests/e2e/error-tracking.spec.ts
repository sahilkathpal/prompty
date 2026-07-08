import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import { launchApp, freshUserDataDir, seedSettings, waitForReady } from "./_helpers";
import fs from "node:fs/promises";
import os from "node:os";

type Ev = { event: string; properties: Record<string, unknown> };
type Err = Record<string, unknown>;

// Error tracking + the shared content scrubber run in the main process. Under
// PROMPTY_E2E the PostHog client never touches the network; capture() records to
// the events ring and captureException() to the errors ring, both AFTER the
// first-pass scrub — so this asserts the real scrub + wrapper behavior offline.

const events = (app: ElectronApplication): Promise<Ev[]> =>
  app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { getAnalyticsEvents: () => Ev[] } }).__prompty_e2e.getAnalyticsEvents());
const errors = (app: ElectronApplication): Promise<Err[]> =>
  app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { getAnalyticsErrors: () => Err[] } }).__prompty_e2e.getAnalyticsErrors());
const captureEvent = (app: ElectronApplication, event: string, properties: Record<string, unknown>): Promise<void> =>
  app.evaluate((_el, a) => (globalThis as unknown as { __prompty_e2e: { captureEvent: (x: unknown) => void } }).__prompty_e2e.captureEvent(a), { event, properties });
const captureError = (app: ElectronApplication, message: string, ctx: Record<string, unknown>): Promise<void> =>
  app.evaluate((_el, a) => (globalThis as unknown as { __prompty_e2e: { captureError: (x: unknown) => void } }).__prompty_e2e.captureError(a), { message, ctx });

test("error-tracking: scrubber redacts + drops content; wrapper tags + rate-limits; opt-out gates", async () => {
  test.setTimeout(60_000);

  const dir = await freshUserDataDir("error-tracking");
  await seedSettings(dir);
  const app = await launchApp(dir);
  try {
    await waitForReady(app);

    const home = os.homedir();
    const longStr = "x".repeat(500);
    const token = "sk_" + "A1b2C3d4".repeat(6); // 51-char token-like run

    // ── Scrubber on events (capture path) ──
    await captureEvent(app, "prep_started", {
      homePath: `${home}/Secret/notes.txt`, // home dir → ~
      blob: longStr, // >200 free-text → dropped
      secret: token, // token-like run → [redacted]
      ok: "home", // short metadata → kept
      count: 3, // number → kept
    });
    await expect
      .poll(async () => (await events(app)).some((e) => e.event === "prep_started"), { timeout: 5_000 })
      .toBe(true);
    const p = (await events(app)).find((e) => e.event === "prep_started")!.properties;
    expect(p.homePath).toBe("~/Secret/notes.txt"); // redacted
    expect(p.blob).toBeUndefined(); // dropped
    expect(String(p.secret)).not.toContain(token); // redacted
    expect(String(p.secret)).toContain("[redacted]");
    expect(p.ok).toBe("home");
    expect(p.count).toBe(3);

    // ── captureException wrapper: tags + fingerprint + scrub ──
    await captureError(app, `boom at ${home}/x`, {
      component: "capture",
      phase: "in-call",
      fingerprint: "capture:test-issue",
      extra: { note: longStr, path: `${home}/a`, code: 42 },
    });
    await expect
      .poll(async () => (await errors(app)).some((e) => e.$exception_fingerprint === "capture:test-issue"), { timeout: 5_000 })
      .toBe(true);
    const e1 = (await errors(app)).find((e) => e.$exception_fingerprint === "capture:test-issue")!;
    expect(e1.component).toBe("capture");
    expect(e1.phase).toBe("in-call");
    expect(String(e1.message)).toBe("boom at ~/x"); // message redacted
    expect(e1.note).toBeUndefined(); // long extra dropped
    expect(e1.path).toBe("~/a"); // extra path redacted
    expect(e1.code).toBe(42); // short extra kept
    expect(Array.isArray(e1.breadcrumbs)).toBe(true);

    // ── Default fingerprint = component:errorName ──
    await captureError(app, "plain", { component: "agent" });
    await expect
      .poll(async () => (await errors(app)).some((e) => e.$exception_fingerprint === "agent:Error"), { timeout: 5_000 })
      .toBe(true);

    // ── Rate limit: cap at 5 per fingerprint per session ──
    for (let i = 0; i < 10; i++) await captureError(app, `flood ${i}`, { component: "ipc", fingerprint: "ipc:flood" });
    await app.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    expect((await errors(app)).filter((e) => e.$exception_fingerprint === "ipc:flood").length).toBe(5);

    // ── Opt-out gates exceptions too ──
    await app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { setAnalyticsOptOut: (v: boolean) => void } }).__prompty_e2e.setAnalyticsOptOut(true));
    await captureError(app, "after opt-out", { component: "main", fingerprint: "main:after-optout" });
    await captureEvent(app, "prep_started", { marker: "after-optout" });
    await app.evaluate(() => new Promise((r) => setTimeout(r, 200)));
    expect((await errors(app)).some((e) => e.$exception_fingerprint === "main:after-optout")).toBe(false);
    expect((await events(app)).some((e) => e.properties.marker === "after-optout")).toBe(false);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
