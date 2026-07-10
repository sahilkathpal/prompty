import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

/**
 * Kill Electron instances left behind by a previously interrupted e2e run.
 *
 * Each spec launches the app via `_helpers.launchApp`, which passes
 *   --user-data-dir=<os.tmpdir()>/prompty-<label>-<rand>
 * and tears it down in a per-spec `finally { app.close() }`. That finally is
 * enough for a clean run — but NOT when the run is hard-killed: a Playwright
 * per-test timeout that kills the worker, a closed terminal, or an aborted
 * `verify`/`run`. Then `finally` never executes and the Electron survives,
 * re-parented to launchd, leaving a stray Dock icon that `killall Dock` can't
 * clear (the process is real). A graceful globalTeardown can't fix this either
 * — it doesn't fire on SIGKILL.
 *
 * The real fix lives in the app itself: under PROMPTY_E2E the main process runs
 * a parent-death watchdog (electron/main.ts) that quits the moment it's
 * orphaned, so new leaks shouldn't happen. This module is the manual backstop —
 * `npm run kill:stray` — for clearing instances that leaked before that landed,
 * or from any path that bypasses the watchdog.
 *
 * Safety: the marker below requires an Electron from THIS repo's node_modules
 * launched with `--user-data-dir=<a temp dir>/prompty-`. The developer's own
 * `npm start` dev window runs `electron .` with NO --user-data-dir, and its
 * default userData path is `.../Application Support/…` (no `/prompty-` temp
 * segment), so a live dev window is never matched.
 */
export function reapStrayElectrons(): number {
  // Match the temp dir both raw and symlink-resolved (macOS $TMPDIR under
  // /var/folders is real, but a $TMPDIR of /tmp resolves to /private/tmp in
  // the child's argv).
  const tmp = os.tmpdir().replace(/\/+$/, "");
  const prefixes = new Set([tmp]);
  try {
    prefixes.add(fs.realpathSync(tmp).replace(/\/+$/, ""));
  } catch {
    // best-effort
  }
  const markers = [...prefixes].map((p) => `--user-data-dir=${p}/prompty-`);

  let out = "";
  try {
    out = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
  } catch {
    return 0; // ps unavailable (non-unix) — nothing to sweep
  }

  let killed = 0;
  for (const line of out.split("\n")) {
    if (!line.includes("node_modules/electron/dist/")) continue;
    if (!markers.some((m) => line.includes(m))) continue;
    const pid = Number(line.trimStart().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed++;
    } catch {
      // already gone / not ours to kill
    }
  }
  return killed;
}

// Runnable directly: `npm run kill:stray`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const n = reapStrayElectrons();
  console.log(`[reap-stray] killed ${n} stray e2e Electron instance(s)`);
}
