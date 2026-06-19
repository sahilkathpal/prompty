import type { Env } from "./types";

// We meter by *mints* (ephemeral Deepgram keys issued), not minutes. A
// continuous call survives key expiry on one mint regardless of length (the
// stream is only auth'd at the initial WebSocket connect), so mints accrue from
// new call sessions + post-1h reconnects + cold-cache relaunches. This is an
// honest, server-side runaway guard — a client-reported duration can't be
// trusted in an open system. See RUBY_AUTH_RELAY_PLAN.md §Rethink #3.
const DEFAULT_DAILY_MINT_LIMIT = 50;
// KV entries expire after 48h so old buckets auto-clean themselves.
const KV_TTL_SECONDS = 60 * 60 * 48;

function utcDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function bucketKey(sub: string, date: string): string {
  return `mints:${sub}:${date}`;
}

export function dailyLimit(env: Env): number {
  const raw = env.DAILY_MINT_LIMIT;
  if (!raw) return DEFAULT_DAILY_MINT_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_MINT_LIMIT;
}

export async function getUsedMints(env: Env, sub: string): Promise<number> {
  const v = await env.RATE_LIMITS.get(bucketKey(sub, utcDateString()));
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Returns true if the user is *under* the daily mint limit right now.
 */
export async function isUnderLimit(env: Env, sub: string): Promise<boolean> {
  const used = await getUsedMints(env, sub);
  return used < dailyLimit(env);
}

/**
 * Increment the user's daily mint counter by one. Not atomic — KV doesn't
 * support CAS. Good enough at a 50/day cap: a ±1 miscount under concurrent
 * requests is irrelevant to a coarse runaway guard.
 */
export async function incrementMints(env: Env, sub: string): Promise<number> {
  const key = bucketKey(sub, utcDateString());
  const current = await getUsedMints(env, sub);
  const next = current + 1;
  await env.RATE_LIMITS.put(key, String(next), {
    expirationTtl: KV_TTL_SECONDS,
  });
  return next;
}
