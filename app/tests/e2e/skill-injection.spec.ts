import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import {
  freshUserDataDir,
  seedSettings,
  launchApp,
  waitForReady,
  openMainWindow,
  getMainPage,
} from "./_helpers";

// Independent end-to-end verification of the skill picker (Phase 1):
//   1. INJECTION — picking a skill in the Direction tab and starting a call
//      folds it onto the setup, so the in-call agent's RESOLVED system prompt
//      carries that skill's playbook body.
//   2. NO LEAK — the skill's frontmatter (title/description) is stripped and
//      never reaches the prompt.
//   3. STICKY PERSISTENCE — the pick is written synchronously to settings and
//      restored into the picker after an app restart.
//
// We drive the real built Electron app (audio/Deepgram/agent mocked) and assert
// against the `session-start` debug event's `systemPrompt` (PROMPTY_DEBUG=1) —
// the actual model-facing prompt the app produced, not a re-derivation.

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
          if (ev.kind === "session-start" && typeof ev.systemPrompt === "string") {
            return { file: newest, systemPrompt: ev.systemPrompt };
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

test("skill picker injects the playbook (no frontmatter leak) and persists across restart", async () => {
  const userDataDir = await freshUserDataDir("e2e-skill-injection");
  const debugLogDir = path.join(userDataDir, "debug");
  await fs.mkdir(debugLogDir, { recursive: true });
  await seedSettings(userDataDir, { lastTab: "direction" });

  const env = { PROMPTY_DEBUG: "1", PROMPTY_DEBUG_LOG_DIR: debugLogDir };

  const app = await launchApp(userDataDir, { env });
  try {
    await waitForReady(app);
    await openMainWindow(app);
    const page = await getMainPage(app);

    // Type the brief on the home chat bar and send → lands on the prep screen,
    // where the skill/playbook picker lives.
    const home = page.getByTestId("home-direction");
    await expect(home).toBeVisible();
    await home.fill(`Seed brief ${Date.now()}`);
    await page.getByTestId("home-send").click();

    // Pick the discovery skill from the dropdown, then start the call from prep.
    // The picker is a custom dropdown (not a native <select>): open it, then
    // click the option by its title.
    const picker = page.getByTestId("playground-skill");
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await picker.locator(".skill-dd-trigger").click();
    await picker.locator(".skill-dd-item", { hasText: "Sales discovery" }).click();
    // The trigger label now reflects the chosen playbook.
    await expect(picker.locator(".skill-dd-label")).toHaveText("Sales discovery");
    // The selected skill's description hint should render.
    await expect(page.getByTestId("playground-skill-hint")).toContainText("mine pain");

    await page.getByTestId("prep-begin").click();
    await expect(page.getByTestId("end-call")).toBeVisible({ timeout: 20_000 });

    // ===== Criterion 1 + 2: INJECTION + NO LEAK =====
    const first = await readNewSessionStartPrompt(debugLogDir, "");
    console.log("skill call debug log:", first.file);
    expect(first.systemPrompt).toContain("Playbook: sales discovery");
    expect(first.systemPrompt).toContain("Mine pain before pitching");
    expect(first.systemPrompt).not.toContain("title:"); // frontmatter stripped
    expect(first.systemPrompt).not.toContain("description:");

    await page.getByTestId("end-call").click();
    // Call ended — back on the home screen.
    await expect(page.getByTestId("home-direction")).toBeVisible({ timeout: 30_000 });

    // The pick was persisted synchronously to settings (no debounce).
    const settings = JSON.parse(
      await fs.readFile(path.join(userDataDir, "prompty-settings.json"), "utf8"),
    );
    expect(settings.skill).toBe("discovery");
  } finally {
    await app.close();
  }

  // ===== Criterion 3: STICKY — relaunch and confirm the picker restored it =====
  const app2 = await launchApp(userDataDir, { env });
  try {
    await waitForReady(app2);
    await openMainWindow(app2);
    const page2 = await getMainPage(app2);
    // The picker lives in the prep panel now — open prep to confirm the
    // restored value survived the restart.
    await page2.getByTestId("home-direction").fill("Re-open prep");
    await page2.getByTestId("home-send").click();
    const picker2 = page2.getByTestId("playground-skill");
    await expect(picker2).toBeVisible({ timeout: 15_000 });
    // The custom dropdown has no `value`; the restored pick shows as the label.
    await expect(picker2.locator(".skill-dd-label")).toHaveText("Sales discovery");
  } finally {
    await app2.close();
  }
});
