import type { Env } from "./types";

// Revocation denylist. Gating is open (any email_verified Google account gets a
// session), so abuse is bounded by revocation + the mint cap, not an allowlist.
// A revoked user is keyed by their Google `sub` in the SESSIONS KV namespace.
//
// Revoke for launch with:
//   wrangler kv key put --binding=SESSIONS revoked:<sub> 1
// (An admin-secret-protected POST /admin/revoke is deferred — see the plan.)
//
// Checked on two paths:
//   - /deepgram/token (hot path) → revocation bites within one key TTL (≤1h),
//     at ~1 KV read per user per hour.
//   - /auth/google → a revoked user can't mint a fresh session JWT either.

function revokedKey(sub: string): string {
  return `revoked:${sub}`;
}

export async function isRevoked(env: Env, sub: string): Promise<boolean> {
  const v = await env.SESSIONS.get(revokedKey(sub));
  return v != null;
}
