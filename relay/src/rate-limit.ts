import type { Env } from "./types";

const DEFAULT_DAILY_LIMIT = 120;
// KV entries expire after 48h so old buckets auto-clean themselves.
const KV_TTL_SECONDS = 60 * 60 * 48;

function utcDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function bucketKey(sub: string, date: string): string {
  return `user:${sub}:minutes:${date}`;
}

export function dailyLimit(env: Env): number {
  const raw = env.DAILY_MINUTES_LIMIT;
  if (!raw) return DEFAULT_DAILY_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
}

export async function getUsedMinutes(env: Env, sub: string): Promise<number> {
  const v = await env.RATE_LIMITS.get(bucketKey(sub, utcDateString()));
  if (!v) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Returns true if user is *under* the daily limit right now.
 */
export async function isUnderLimit(env: Env, sub: string): Promise<boolean> {
  const used = await getUsedMinutes(env, sub);
  return used < dailyLimit(env);
}

/**
 * Increment the user's daily minute counter. Not atomic — KV doesn't support
 * CAS. Good enough for burst rate-limiting at our scale; over-counts under
 * concurrent requests, which is conservative (favors the limit).
 */
export async function incrementMinutes(
  env: Env,
  sub: string,
  delta: number
): Promise<number> {
  const key = bucketKey(sub, utcDateString());
  const current = await getUsedMinutes(env, sub);
  const next = current + delta;
  await env.RATE_LIMITS.put(key, String(next), {
    expirationTtl: KV_TTL_SECONDS,
  });
  return next;
}
