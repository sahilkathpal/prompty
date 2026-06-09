import { test, expect, _electron as electron, ElectronApplication, Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// S5 verification: the teleprompter bar enforces a minimum dwell, queues
// extras, lets high-urgency preempt, and drops stale nudges. Nudges are driven
// deterministically via the emitNudge bridge (broadcasts nudge:received).

const APP_ROOT = path.resolve(__dirname, "../..");
const ROOT = '[data-testid="teleprompter-root"]';

async function freshUserDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "prompty-e2e-tele-"));
}

async function launchApp(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  const userDataDir = await freshUserDataDir();
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
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

async function getTeleprompterPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const p = app.windows().find((pg) => pg.url().includes("teleprompter"));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("teleprompter page not found");
}

let nudgeSeq = 0;
async function emit(
  app: ElectronApplication,
  text: string,
  urgency: "high" | "medium" = "medium",
): Promise<void> {
  const nudge = { id: `n${nudgeSeq++}`, kind: "info", urgency, text, createdAt: Date.now() };
  // NOTE: electronApplication.evaluate calls the fn with the electron module as
  // the FIRST arg and our payload as the SECOND — so ignore the first param.
  await app.evaluate(async (_electron, n) => {
    (globalThis as unknown as { __prompty_e2e: { emitNudge: (x: unknown) => boolean } }).__prompty_e2e.emitNudge(n);
  }, nudge);
}

async function textOf(tp: Page): Promise<string> {
  return ((await tp.locator(ROOT).textContent()) ?? "").trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The renderer subscribes to nudge:received in a React effect that runs just
// after the root mounts; give it a beat so the first emit isn't lost. (In
// production the teleprompter is created at startup, long before any nudge.)
async function ready(tp: Page): Promise<void> {
  await tp.waitForSelector(ROOT);
  await sleep(600);
}

test("Stage 5: minimum dwell — a queued nudge does not replace the current one early", async () => {
  // Default dwell (2500ms), large stale.
  const app = await launchApp();
  try {
    await waitForReady(app);
    const tp = await getTeleprompterPage(app);
    await ready(tp);
    await emit(app, "first");
    await expect(tp.locator(ROOT)).toHaveText("first");
    await emit(app, "second"); // queued behind the dwell
    await sleep(900);
    expect(await textOf(tp)).toBe("first"); // still showing first (< dwell)
    await expect(tp.locator(ROOT)).toHaveText("second", { timeout: 4000 }); // after dwell
  } finally {
    await app.close();
  }
});

test("Stage 5: high-urgency nudge preempts immediately", async () => {
  const app = await launchApp();
  try {
    await waitForReady(app);
    const tp = await getTeleprompterPage(app);
    await ready(tp);
    await emit(app, "calm one");
    await expect(tp.locator(ROOT)).toHaveText("calm one");
    await emit(app, "URGENT", "high"); // must jump the dwell
    await expect(tp.locator(ROOT)).toHaveText("URGENT", { timeout: 1500 });
    await expect(tp.locator(ROOT)).toHaveAttribute("data-high", "true");
  } finally {
    await app.close();
  }
});

test("Stage 5: stale nudges are dropped unshown", async () => {
  // Short stale (800ms), moderate dwell (1500ms): queued items expire before
  // the current one's dwell elapses, so they're pruned and never shown.
  const app = await launchApp({
    PROMPTY_TELEPROMPTER_STALE_MS: "800",
    PROMPTY_TELEPROMPTER_DWELL_MS: "1500",
  });
  try {
    await waitForReady(app);
    const tp = await getTeleprompterPage(app);
    await ready(tp);
    await emit(app, "shown-A");
    await expect(tp.locator(ROOT)).toHaveText("shown-A");
    await emit(app, "stale-B");
    await emit(app, "stale-C");
    // Sample the displayed text across the dwell window; B and C must never appear.
    const seen = new Set<string>();
    for (let i = 0; i < 22; i++) {
      seen.add(await textOf(tp));
      await sleep(100);
    }
    expect(seen.has("stale-B")).toBe(false);
    expect(seen.has("stale-C")).toBe(false);
    // After the dwell with an all-stale queue, the bar hides.
    expect(await tp.locator(".teleprompter-root.visible").count()).toBe(0);
  } finally {
    await app.close();
  }
});

test("Stage 5: queue cap drops the middle but keeps the newest", async () => {
  // Fast dwell so the queue advances quickly; large stale so nothing expires.
  const app = await launchApp({
    PROMPTY_TELEPROMPTER_DWELL_MS: "300",
    PROMPTY_TELEPROMPTER_STALE_MS: "60000",
  });
  try {
    await waitForReady(app);
    const tp = await getTeleprompterPage(app);
    await ready(tp);
    // Flood 6 nudges; cap is 3 (drop-middle). The newest must survive and show.
    for (let i = 0; i < 6; i++) await emit(app, `N${i}`);
    await expect(tp.locator(ROOT)).toHaveText("N5", { timeout: 4000 });
  } finally {
    await app.close();
  }
});
