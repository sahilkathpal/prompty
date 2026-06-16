import {
  test,
  expect,
  _electron as electron,
  ElectronApplication,
  Page,
} from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// Independent verification of Phase 3b: components (goal/checklist) built during
// prep are folded onto the call setup at start and rendered into the in-call
// agent's RESOLVED system prompt under `## Goal` / `## Checklist` (items as
// `- [ ] <text>`), AND they are CONSUMED on start — a second call started
// without re-prepping must NOT contain them.
//
// We drive the real built Electron app and assert against the `session-start`
// event's `systemPrompt` captured by the debug logger (requires PROMPTY_DEBUG=1)
// — the actual model-facing prompt the app produced, not a re-derivation.
//
// Under PROMPTY_MOCK_AGENT=1 the mock prep agent, on user message M, arms a
// goal "Goal: M" and a checklist with items "Cover M" and "Agree next steps".

const APP_ROOT = path.resolve(__dirname, "../..");

async function seedSettings(userDataDir: string): Promise<void> {
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
    }),
    "utf8",
  );
}

async function launchApp(
  userDataDir: string,
  debugLogDir: string,
  callLogDir: string,
): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_DEBUG: "1", // REQUIRED: makes the resolved prompt get captured.
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      PROMPTY_MOCK_AGENT: "1",
      PROMPTY_DEBUG_LOG_DIR: debugLogDir,
      PROMPTY_CALL_LOG_DIR: callLogDir,
      NODE_ENV: "development",
    },
  });
}

async function waitForReady(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ app: electronApp }) => {
    if (!electronApp.isReady()) {
      await new Promise<void>((resolve) =>
        electronApp.once("ready", () => resolve()),
      );
    }
  });
}

async function openMainWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const h = (
      globalThis as unknown as {
        __prompty_e2e: { openMainWindow: () => void };
      }
    ).__prompty_e2e;
    h.openMainWindow();
  });
}

async function getMainPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const p = app.windows().find((pg) => pg.url().includes("main-window"));
    if (p) return p;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("main window page not found");
}

// Find the newest call-*.jsonl whose name is strictly greater than `afterName`
// (call logs are named call-<startedAt>.jsonl, so lexical sort == chronological),
// parse its lines, and return both the filename and the `session-start`
// `systemPrompt`. Polls to a deadline since the session takes a moment to start.
async function readNewSessionStartPrompt(
  debugLogDir: string,
  afterName: string,
  timeoutMs = 20_000,
): Promise<{ file: string; systemPrompt: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no new call-*.jsonl found";
  while (Date.now() < deadline) {
    try {
      const files = (await fs.readdir(debugLogDir))
        .filter((f) => f.startsWith("call-") && f.endsWith(".jsonl"))
        .filter((f) => f > afterName)
        .sort();
      if (files.length) {
        const newest = files[files.length - 1];
        const raw = await fs.readFile(path.join(debugLogDir, newest), "utf8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.kind === "session-start") {
            if (typeof ev.systemPrompt === "string")
              return { file: newest, systemPrompt: ev.systemPrompt };
            lastErr = `session-start event has no systemPrompt: ${line}`;
          }
        }
        lastErr = `newest new file ${newest} has no session-start yet`;
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`readNewSessionStartPrompt timed out: ${lastErr}`);
}

// Pull the `## <Heading>` block (heading line through the line before the next
// `## ` heading) out of a prompt, for quoting in the report.
function extractSection(prompt: string, heading: string): string | null {
  const idx = prompt.indexOf(heading);
  if (idx < 0) return null;
  const rest = prompt.slice(idx);
  const nextHeading = rest.indexOf("\n## ", heading.length);
  return nextHeading < 0 ? rest.trim() : rest.slice(0, nextHeading).trim();
}

test("components inject into the in-call prompt, then are consumed on start", async () => {
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "prompty-e2e-component-injection-"),
  );
  const debugLogDir = path.join(userDataDir, "debug");
  const callLogDir = path.join(userDataDir, "calls");
  await fs.mkdir(debugLogDir, { recursive: true });
  await fs.mkdir(callLogDir, { recursive: true });
  await seedSettings(userDataDir);

  const M = `pricing scope ${Math.random().toString(36).slice(2, 8)}`;

  const app = await launchApp(userDataDir, debugLogDir, callLogDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    const directionTab = page.getByTestId("tab-direction");
    if (await directionTab.count()) await directionTab.click();

    // A non-empty direction is needed for playground-start to fire. Seed one;
    // the mock prep agent also rewrites the direction from M.
    const textarea = page.getByTestId("playground-direction");
    await expect(textarea).toBeVisible();
    await textarea.fill(`Seed brief ${Date.now()}`);

    // ===== Prep: send one message M, wait for the armed goal component =====
    const prepOpen = page.getByTestId("prep-open");
    await expect(prepOpen).toBeVisible();
    await prepOpen.click();
    await page.getByTestId("prep-input").fill(M);
    await page.getByTestId("prep-send").click();
    await expect(page.getByTestId("component-goal")).toBeVisible({
      timeout: 15_000,
    });
    // Confirm the checklist armed too (deterministic mock).
    await expect(page.getByTestId("component-checklist")).toBeVisible({
      timeout: 15_000,
    });

    // ===== Criterion 1: INJECTION — start a call, read session-start prompt ====
    await page.getByTestId("playground-start").click();
    await expect(page.getByTestId("playground-end")).toBeVisible({
      timeout: 20_000,
    });

    const first = await readNewSessionStartPrompt(debugLogDir, "");
    console.log("CALL 1 debug log:", first.file);

    const goalSection = extractSection(first.systemPrompt, "## Goal");
    const checklistSection = extractSection(first.systemPrompt, "## Checklist");
    console.log("CALL 1 ## Goal block:\n" + goalSection);
    console.log("CALL 1 ## Checklist block:\n" + checklistSection);

    expect(first.systemPrompt).toContain("## Goal");
    expect(first.systemPrompt).toContain(`Goal: ${M}`);
    expect(first.systemPrompt).toContain("## Checklist");
    expect(first.systemPrompt).toContain(`- [ ] Cover ${M}`);
    expect(first.systemPrompt).toContain("- [ ] Agree next steps");

    // ===== End the first call =====
    await page.getByTestId("playground-end").click();
    await expect(page.getByTestId("playground-start")).toBeVisible({
      timeout: 30_000,
    });

    // ===== Criterion 2: CONSUMED ON START — second call WITHOUT re-prepping ====
    // The Direction editor still holds text from the first prep, so start fires.
    await page.getByTestId("playground-start").click();
    await expect(page.getByTestId("playground-end")).toBeVisible({
      timeout: 20_000,
    });

    const second = await readNewSessionStartPrompt(debugLogDir, first.file);
    console.log("CALL 2 debug log:", second.file);
    expect(second.file).not.toBe(first.file); // distinct startedAt

    expect(second.systemPrompt).not.toContain("## Goal");
    expect(second.systemPrompt).not.toContain("## Checklist");
    console.log(
      "CALL 2 confirmed: no ## Goal / ## Checklist. prompt length=" +
        second.systemPrompt.length,
    );

    await page.getByTestId("playground-end").click();
    await expect(page.getByTestId("playground-start")).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await app.close();
  }
});
