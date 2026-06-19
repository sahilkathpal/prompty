// End-to-end HTTP check of the two new /deepgram/token gates against a running
// local `wrangler dev`: 403 for a revoked sub, 429 once the daily mint cap is
// hit. Both gates short-circuit before the Deepgram mint, so dummy .dev.vars
// creds are fine. We sign a real session JWT with the dev PROMPTY_JWT_SECRET and
// seed local KV via `wrangler kv key put --local`.
//
// Usage: BASE_URL=http://localhost:8799 tsx test/integration-gates.ts

import { execFileSync } from "node:child_process";
import { signSessionToken } from "../src/jwt";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8799";
const DEV_SECRET = "dummy-jwt-secret-for-local-smoke"; // matches relay/.dev.vars

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function kvPut(binding: string, key: string, value: string): void {
  execFileSync(
    "npx",
    ["wrangler", "kv", "key", "put", "--local", "--preview", `--binding=${binding}`, key, value],
    { stdio: "ignore" },
  );
}

async function postToken(token: string): Promise<Response> {
  return fetch(`${BASE_URL}/deepgram/token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  let failed = 0;

  // --- 403 revoked ---
  try {
    const sub = `it-revoked-${today}`;
    const { token } = await signSessionToken(sub, DEV_SECRET);
    kvPut("SESSIONS", `revoked:${sub}`, "1");
    const res = await postToken(token);
    assert(res.status === 403, `expected 403, got ${res.status}`);
    const body = (await res.json()) as { error?: string };
    assert(/revoked/i.test(body.error ?? ""), `error mentions revoked: ${body.error}`);
    console.log("  PASS  revoked sub → 403");
  } catch (e) {
    failed++;
    console.error(`  FAIL  revoked sub → 403 — ${(e as Error).message}`);
  }

  // --- 429 over the mint cap ---
  try {
    const sub = `it-capped-${today}`;
    const { token } = await signSessionToken(sub, DEV_SECRET);
    kvPut("RATE_LIMITS", `mints:${sub}:${today}`, "50"); // at the default cap
    const res = await postToken(token);
    assert(res.status === 429, `expected 429, got ${res.status}`);
    const body = (await res.json()) as { error?: string; used?: number; limit?: number };
    assert(/mint limit/i.test(body.error ?? ""), `error mentions mint limit: ${body.error}`);
    assert(body.limit === 50, `limit is 50, got ${body.limit}`);
    console.log("  PASS  at mint cap → 429");
  } catch (e) {
    failed++;
    console.error(`  FAIL  at mint cap → 429 — ${(e as Error).message}`);
  }

  // --- valid session, under cap, not revoked → reaches the Deepgram mint ---
  // With dummy creds the mint itself fails upstream (502), proving the gates
  // let it through (not a 401/403/429).
  try {
    const sub = `it-ok-${today}`;
    const { token } = await signSessionToken(sub, DEV_SECRET);
    const res = await postToken(token);
    assert(
      res.status === 502 || res.status === 200,
      `expected to pass gates (502 dummy-mint or 200), got ${res.status}`,
    );
    console.log(`  PASS  clean session passes gates (status ${res.status})`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  clean session passes gates — ${(e as Error).message}`);
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall gate checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
