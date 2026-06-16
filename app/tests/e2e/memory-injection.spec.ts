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

// Independent verification of Phase 1b: the user's saved memory items are
// injected into the in-call agent's RESOLVED system prompt under a
// `## What Ruby knows about you` section. We drive the real built Electron app,
// start a session, then assert against the `session-start` event's
// `systemPrompt` captured by the debug logger (requires debugMode:true) — i.e.
// the actual model-facing prompt the app produced, not a re-derivation.

const APP_ROOT = path.resolve(__dirname, "../..");
const HEADING = "## What Ruby knows about you";

async function seedSettings(userDataDir: string): Promise<void> {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    path.join(userDataDir, "prompty-settings.json"),
    JSON.stringify({
      onboardingCompleted: true,
      loginItemPrompted: true,
      debugMode: true, // REQUIRED: makes the resolved prompt get captured.
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
  memoryFile: string,
  debugLogDir: string,
): Promise<ElectronApplication> {
  return await electron.launch({
    args: [APP_ROOT, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROMPTY_E2E: "1",
      PROMPTY_MOCK_AUDIO: "1",
      PROMPTY_MOCK_DEEPGRAM: "1",
      PROMPTY_MOCK_AGENT: "1",
      PROMPTY_MEMORY_FILE: memoryFile,
      PROMPTY_DEBUG_LOG_DIR: debugLogDir,
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

async function startSession(app: ElectronApplication): Promise<void> {
  const res = await app.evaluate(async () => {
    const h = (
      globalThis as unknown as {
        __prompty_e2e: { startSession: () => Promise<{ ok: boolean; error?: string }> };
      }
    ).__prompty_e2e;
    return await h.startSession();
  });
  expect(res.ok, `startSession failed: ${res.error ?? ""}`).toBe(true);
}

async function endSession(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const h = (
      globalThis as unknown as {
        __prompty_e2e: { endSession: () => Promise<unknown> };
      }
    ).__prompty_e2e;
    await h.endSession();
  });
}

async function openMainWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(async () => {
    const h = (
      globalThis as unknown as { __prompty_e2e: { openMainWindow: () => void } }
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

// Poll the debug-log dir for the newest call-*.jsonl, parse its lines, and
// return the `systemPrompt` from the `session-start` event. Writes are sync but
// the session takes a moment to start, so we poll to a deadline.
async function readSessionStartPrompt(
  debugLogDir: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no call-*.jsonl found";
  while (Date.now() < deadline) {
    try {
      const files = (await fs.readdir(debugLogDir))
        .filter((f) => f.startsWith("call-") && f.endsWith(".jsonl"))
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
            if (typeof ev.systemPrompt === "string") return ev.systemPrompt;
            lastErr = `session-start event has no systemPrompt: ${line}`;
          }
        }
      }
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`readSessionStartPrompt timed out: ${lastErr}`);
}

test("POSITIVE: a saved memory item is injected into the resolved system prompt", async () => {
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "prompty-e2e-mem-inject-pos-"),
  );
  const memoryFile = path.join(userDataDir, "memory.json");
  const debugLogDir = path.join(userDataDir, "debug");
  const MEM_TEXT = "Only nudge me on truly critical moments.";

  // Pre-seed the memory store with one item (deterministic assertion).
  await fs.writeFile(
    memoryFile,
    JSON.stringify([
      { id: "m1", text: MEM_TEXT, createdAt: 1, source: "manual" },
    ]),
    "utf8",
  );
  await seedSettings(userDataDir);

  const app = await launchApp(userDataDir, memoryFile, debugLogDir);
  try {
    await waitForReady(app);
    await startSession(app);
    const prompt = await readSessionStartPrompt(debugLogDir);

    // Criterion 1: heading present AND the exact memory text present.
    expect(prompt).toContain(HEADING);
    expect(prompt).toContain(MEM_TEXT);

    // Quote the actual block we matched for the report.
    const idx = prompt.indexOf(HEADING);
    const block = prompt.slice(idx, idx + 200).split("\n## ")[0];
    console.log("MATCHED BLOCK (positive):\n" + block);

    await endSession(app);
  } finally {
    await app.close();
  }
});

test("NEGATIVE: with no memory items the section is absent from the prompt", async () => {
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "prompty-e2e-mem-inject-neg-"),
  );
  // Point at a fresh path that does not exist → readMemory() returns [].
  const memoryFile = path.join(userDataDir, "empty-memory.json");
  const debugLogDir = path.join(userDataDir, "debug");
  await seedSettings(userDataDir);

  const app = await launchApp(userDataDir, memoryFile, debugLogDir);
  try {
    await waitForReady(app);
    await startSession(app);
    const prompt = await readSessionStartPrompt(debugLogDir);

    // Criterion 2: the section must be ABSENT.
    expect(prompt).not.toContain(HEADING);
    console.log(
      "NEGATIVE confirmed: heading absent. prompt length=" + prompt.length,
    );

    await endSession(app);
  } finally {
    await app.close();
  }
});

test("BONUS: a memory item added through the real Memory tab UI reaches the prompt", async () => {
  const userDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "prompty-e2e-mem-inject-ui-"),
  );
  const memoryFile = path.join(userDataDir, "memory.json");
  const debugLogDir = path.join(userDataDir, "debug");
  const UI_TEXT = "Coach me gently; I dislike hard interruptions.";
  await seedSettings(userDataDir);

  const app = await launchApp(userDataDir, memoryFile, debugLogDir);
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // Add via the real UI: Memory tab → input → add.
    await page.getByTestId("tab-memory").click();
    await page.getByTestId("memory-input").fill(UI_TEXT);
    await page.getByTestId("memory-add").click();
    await expect(
      page.getByTestId("memory-item").filter({ hasText: UI_TEXT }),
    ).toHaveCount(1);

    await startSession(app);
    const prompt = await readSessionStartPrompt(debugLogDir);

    expect(prompt).toContain(HEADING);
    expect(prompt).toContain(UI_TEXT);
    const idx = prompt.indexOf(HEADING);
    console.log(
      "MATCHED BLOCK (UI add):\n" +
        prompt.slice(idx, idx + 200).split("\n## ")[0],
    );

    await endSession(app);
  } finally {
    await app.close();
  }
});
