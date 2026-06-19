/**
 * Tiny smoke test for the relay. Hits `/health` and (optionally) probes the
 * auth endpoints to confirm they return well-formed errors when called
 * without credentials.
 *
 * Usage:
 *   BASE_URL=http://localhost:8787 npx tsx test/smoke.ts
 *   BASE_URL=https://prompty-relay.example.workers.dev npx tsx test/smoke.ts
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8787";

interface Check {
  name: string;
  fn: () => Promise<void>;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function expectJson(res: Response): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  assert(ct.includes("application/json"), `expected JSON, got ${ct}`);
  return res.json();
}

const checks: Check[] = [
  {
    name: "GET /health returns ok",
    fn: async () => {
      const res = await fetch(`${BASE_URL}/health`);
      assert(res.ok, `status ${res.status}`);
      const body = (await expectJson(res)) as { ok?: boolean; ts?: number };
      assert(body.ok === true, "ok=true");
      assert(typeof body.ts === "number", "ts is number");
    },
  },
  {
    name: "POST /auth/google rejects missing body",
    fn: async () => {
      const res = await fetch(`${BASE_URL}/auth/google`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert(res.status === 400, `expected 400, got ${res.status}`);
      const body = (await expectJson(res)) as { error?: string };
      assert(typeof body.error === "string", "error string present");
    },
  },
  {
    name: "POST /deepgram/token rejects missing bearer",
    fn: async () => {
      const res = await fetch(`${BASE_URL}/deepgram/token`, {
        method: "POST",
      });
      assert(res.status === 401, `expected 401, got ${res.status}`);
      const body = (await expectJson(res)) as { error?: string };
      assert(typeof body.error === "string", "error string present");
    },
  },
  {
    name: "POST /deepgram/token rejects bogus bearer",
    fn: async () => {
      const res = await fetch(`${BASE_URL}/deepgram/token`, {
        method: "POST",
        headers: { Authorization: "Bearer not-a-real-jwt" },
      });
      assert(res.status === 401, `expected 401, got ${res.status}`);
    },
  },
];

async function main() {
  console.log(`smoke-testing ${BASE_URL}`);
  let failed = 0;
  for (const check of checks) {
    try {
      await check.fn();
      console.log(`  PASS  ${check.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${check.name} — ${(err as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
