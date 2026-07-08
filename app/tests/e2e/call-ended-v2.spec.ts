import { test, expect } from "@playwright/test";
import { launchApp, freshUserDataDir, seedSettings, waitForReady, e2e, injectUtterance } from "./_helpers";
import fs from "node:fs/promises";
import path from "node:path";

type Ev = { event: string; properties: Record<string, unknown> };

// The v2 outcome signal on call_ended (RUBY_OBSERVABILITY_PLAN §7.1): a real
// mock-audio call with injected final utterances must carry transcript_utterances
// (the "did it actually work" number) and the peer health fields. Runs offline
// through the real session + analytics path (PROMPTY_E2E ring buffer).

test("call_ended v2: transcript_utterances + health props reflect the call", async () => {
  test.setTimeout(60_000);

  const dir = await freshUserDataDir("call-ended-v2");
  await seedSettings(dir);
  const app = await launchApp(dir);
  try {
    await waitForReady(app);
    const events = (): Promise<Ev[]> =>
      app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { getAnalyticsEvents: () => Ev[] } }).__prompty_e2e.getAnalyticsEvents());

    await e2e(app, "startSession");
    await expect.poll(async () => (await events()).some((e) => e.event === "call_started"), { timeout: 5_000 }).toBe(true);

    // Two final utterances → transcript_utterances === 2.
    await injectUtterance(app, "we run eight brokers", "them");
    await injectUtterance(app, "pricing is the sticking point", "them");

    await e2e(app, "endSession");
    await expect.poll(async () => (await events()).some((e) => e.event === "call_ended"), { timeout: 5_000 }).toBe(true);

    const ce = (await events()).find((e) => e.event === "call_ended")!;
    expect(ce.properties.transcript_utterances).toBe(2);
    // Peer health fields are present and sane for a clean mock call (no real
    // sidecar/tap, so restarts 0 and them-silent false).
    expect(typeof ce.properties.nudges_fired_count).toBe("number");
    expect(ce.properties.them_silent_seen).toBe(false);
    expect(ce.properties.sidecar_restarts).toBe(0);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// A crash/force-quit mid-call emits no call_ended — the journal salvages the
// data on next launch, and call_recovered (§7.2) counts the otherwise-vanished
// call so it isn't lost from the denominator.
test("call_recovered: a planted orphaned journal is counted on boot", async () => {
  test.setTimeout(60_000);

  const dir = await freshUserDataDir("call-recovered");
  await seedSettings(dir);

  // Plant an orphaned journal (proof of a crash) under the call-log dir launchApp
  // points PROMPTY_CALL_LOG_DIR at: <userDataDir>/calls/.journal/<id>.jsonl.
  const journalDir = path.join(dir, "calls", ".journal");
  await fs.mkdir(journalDir, { recursive: true });
  const startedAt = Date.now() - 120_000; // ~2 min ago → duration_s ≈ 120
  const lines = [
    JSON.stringify({ t: "header", direction: "Recovered discovery call", startedAt }),
    JSON.stringify({ t: "utt", u: { speaker: "them", text: "salvaged line", startMs: 0, endMs: 1000, isFinal: true } }),
  ];
  await fs.writeFile(path.join(journalDir, `${startedAt}.jsonl`), lines.join("\n") + "\n", "utf8");

  const app = await launchApp(dir);
  try {
    await waitForReady(app);
    const events = (): Promise<Ev[]> =>
      app.evaluate(() => (globalThis as unknown as { __prompty_e2e: { getAnalyticsEvents: () => Ev[] } }).__prompty_e2e.getAnalyticsEvents());

    await expect.poll(async () => (await events()).some((e) => e.event === "call_recovered"), { timeout: 5_000 }).toBe(true);
    const cr = (await events()).find((e) => e.event === "call_recovered")!;
    expect(cr.properties.had_transcript).toBe(true);
    expect(typeof cr.properties.duration_s).toBe("number");
    expect(cr.properties.duration_s as number).toBeGreaterThan(0);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
