// Unit test for the Phase A changes: mint-count metering (rate-limit.ts) and
// the revocation denylist (revocation.ts). Uses an in-memory KV stub so it runs
// offline with no Cloudflare account, real secrets, or live wrangler dev.

import {
  dailyLimit,
  getUsedMints,
  incrementMints,
  isUnderLimit,
} from "../src/rate-limit";
import { isRevoked } from "../src/revocation";
import type { Env } from "../src/types";

// Minimal in-memory KVNamespace good enough for get/put used by these modules.
function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    GOOGLE_JWKS_CACHE: makeKV(),
    RATE_LIMITS: makeKV(),
    SESSIONS: makeKV(),
    GOOGLE_CLIENT_ID: "x",
    GOOGLE_CLIENT_SECRET: "x",
    PROMPTY_JWT_SECRET: "x",
    DEEPGRAM_MASTER_KEY: "x",
    DEEPGRAM_PROJECT_ID: "x",
    ...over,
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

interface Check {
  name: string;
  fn: () => Promise<void>;
}

const SUB = "google-sub-abc";

const checks: Check[] = [
  {
    name: "default daily limit is 50 mints",
    fn: async () => {
      assert(dailyLimit(makeEnv()) === 50, "default 50");
    },
  },
  {
    name: "DAILY_MINT_LIMIT var overrides the default",
    fn: async () => {
      assert(dailyLimit(makeEnv({ DAILY_MINT_LIMIT: "3" })) === 3, "override 3");
    },
  },
  {
    name: "each mint increments the counter by exactly 1",
    fn: async () => {
      const env = makeEnv();
      assert((await getUsedMints(env, SUB)) === 0, "starts at 0");
      assert((await incrementMints(env, SUB)) === 1, "→1");
      assert((await incrementMints(env, SUB)) === 2, "→2");
      assert((await getUsedMints(env, SUB)) === 2, "reads back 2");
    },
  },
  {
    name: "isUnderLimit flips false exactly at the cap",
    fn: async () => {
      const env = makeEnv({ DAILY_MINT_LIMIT: "3" });
      assert(await isUnderLimit(env, SUB), "under at 0");
      await incrementMints(env, SUB); // 1
      await incrementMints(env, SUB); // 2
      assert(await isUnderLimit(env, SUB), "still under at 2/3");
      await incrementMints(env, SUB); // 3
      assert(!(await isUnderLimit(env, SUB)), "at limit 3/3 → not under");
    },
  },
  {
    name: "counters are isolated per sub",
    fn: async () => {
      const env = makeEnv();
      await incrementMints(env, "user-a");
      assert((await getUsedMints(env, "user-b")) === 0, "user-b untouched");
    },
  },
  {
    name: "isRevoked false when no denylist entry",
    fn: async () => {
      const env = makeEnv();
      assert(!(await isRevoked(env, SUB)), "not revoked by default");
    },
  },
  {
    name: "isRevoked true once revoked:<sub> is set in SESSIONS KV",
    fn: async () => {
      const env = makeEnv();
      await env.SESSIONS.put(`revoked:${SUB}`, "1");
      assert(await isRevoked(env, SUB), "revoked after put");
      assert(!(await isRevoked(env, "other-sub")), "only the keyed sub");
    },
  },
];

async function main() {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.fn();
      console.log(`  PASS  ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL  ${c.name} — ${(e as Error).message}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall metering/revocation checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
