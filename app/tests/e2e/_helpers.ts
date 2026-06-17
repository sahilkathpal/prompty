// Shared Playwright + Electron harness for the E2E suite.
//
// Every spec used to inline its own copy of freshUserDataDir / seedSettings /
// launchApp / waitForReady / getMainPage / getOverlayPage / emitNudge, so the
// harness drifted per file and an env change meant editing 15 places. This is
// the single source of truth: the base mock env, the window plumbing, and the
// call-log polling all live here.
//
// All specs run against the BUILT app under real (non-headless) Electron, with
// audio/Deepgram/agent mocked so they're deterministic and offline.

import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

/** Repo `app/` root — the Electron app entry point Playwright launches. */
export const APP_ROOT = path.resolve(__dirname, "../..");

/**
 * The base environment every E2E run shares: the test-mode flag plus the three
 * mock switches that keep the session offline and deterministic. Specs layer
 * their own overrides (call-log dir, debug capture, overlay timings) on top.
 */
export const BASE_E2E_ENV: Record<string, string> = {
  PROMPTY_E2E: "1",
  PROMPTY_MOCK_AUDIO: "1",
  PROMPTY_MOCK_DEEPGRAM: "1",
  PROMPTY_MOCK_AGENT: "1",
  NODE_ENV: "development",
};

/** A fresh temp userData dir, prefixed for easy identification under $TMPDIR. */
export async function freshUserDataDir(label = "e2e"): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `prompty-${label}-`));
}

/** Settings that mark onboarding complete so the app boots straight to the app. */
export async function seedSettings(
  userDataDir: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, "prompty-settings.json"),
    JSON.stringify({
      onboardingCompleted: true,
      loginItemPrompted: true,
      hotkey: "Alt+Shift+Space",
      panelPosition: null,
      launchAtLogin: false,
      lastTab: "direction",
      ...overrides,
    }),
    "utf8",
  );
}

/**
 * Launch the built Electron app pointed at `userDataDir`. `env` is merged over
 * BASE_E2E_ENV, so a spec only names what it adds (e.g. PROMPTY_CALL_LOG_DIR,
 * PROMPTY_DEBUG, the overlay timing vars).
 */
export async function launchApp(
  userDataDir: string,
  opts: { env?: Record<string, string> } = {},
): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ...BASE_E2E_ENV, ...opts.env },
  });
}

/** Resolve once the Electron app has reached its `ready` state. */
export async function waitForReady(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: electronApp }) => {
    if (!electronApp.isReady()) {
      await new Promise<void>((resolve) =>
        electronApp.once("ready", () => resolve()),
      );
    }
  });
}

/** Call a method on the `__prompty_e2e` test bridge inside the main process. */
export async function e2e<R = void>(
  app: ElectronApplication,
  method: string,
  arg?: unknown,
): Promise<R> {
  return (await app.evaluate(
    async (_el, { method, arg }) => {
      const h = (globalThis as unknown as { __prompty_e2e: Record<string, (a?: unknown) => unknown> })
        .__prompty_e2e;
      return h[method](arg) as R;
    },
    { method, arg },
  )) as R;
}

/** Poll for an app window whose URL contains `fragment`. */
async function getWindow(
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
  throw new Error(`${fragment} window not found`);
}

export async function openMainWindow(app: ElectronApplication): Promise<void> {
  await e2e(app, "openMainWindow");
}
export async function getMainPage(app: ElectronApplication): Promise<Page> {
  return getWindow(app, "main-window");
}
export async function showOverlay(app: ElectronApplication): Promise<void> {
  await e2e(app, "showOverlay");
}
export async function getOverlayPage(app: ElectronApplication): Promise<Page> {
  return getWindow(app, "overlay");
}

/**
 * Drive the prep suggest-then-create gate under the mock agent: send a
 * substantive message (which makes Ruby OFFER a goal + checklist), wait for the
 * offer, then confirm with "yes" so the components are actually created. The
 * resulting goal is "Goal: M" and the checklist is "Cover M" / "Agree next
 * steps". Use this anywhere a test needs armed components.
 */
export async function prepArmComponents(page: Page, message: string): Promise<void> {
  await page.getByTestId("prep-input").fill(message);
  await page.getByTestId("prep-send").click();
  // Ruby offers first — wait for the offer turn before confirming.
  await page
    .getByTestId("prep-msg-assistant")
    .filter({ hasText: "pin a goal" })
    .first()
    .waitFor({ timeout: 15_000 });
  await page.getByTestId("prep-input").fill("yes");
  await page.getByTestId("prep-send").click();
}

let nudgeSeq = 0;
/** Push a nudge straight to the overlay via the test bridge. */
export async function emitNudge(
  app: ElectronApplication,
  text: string,
  urgency: "high" | "medium" = "medium",
): Promise<void> {
  await e2e(app, "emitNudge", {
    id: `e2e-${Date.now()}-${nudgeSeq++}`,
    text,
    urgency,
    createdAt: Date.now(),
  });
}

/** Inject a final transcript utterance into the active session. */
export async function injectUtterance(
  app: ElectronApplication,
  text: string,
  speaker: "me" | "them" = "them",
): Promise<void> {
  await e2e(app, "injectUtterance", {
    speaker,
    text,
    startMs: 0,
    endMs: 0,
    isFinal: true,
  });
}

/** Poll a call-log dir for the newest *.json and return its parsed contents. */
export async function readNewestCallLog<T = Record<string, unknown>>(
  callLogDir: string,
  opts: { timeoutMs?: number; require?: (log: T) => boolean } = {},
): Promise<{ file: string; log: T }> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no *.json found in call log dir";
  while (Date.now() < deadline) {
    try {
      const files = (await fs.readdir(callLogDir)).filter((f) => f.endsWith(".json")).sort();
      if (files.length) {
        const newest = files[files.length - 1];
        const log = JSON.parse(await fs.readFile(path.join(callLogDir, newest), "utf8")) as T;
        if (!opts.require || opts.require(log)) return { file: newest, log };
        lastErr = `newest file ${newest} did not satisfy require()`;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`readNewestCallLog timed out: ${lastErr}`);
}
