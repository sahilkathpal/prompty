import { SignJWT, jwtVerify } from "jose";
import type { PromptySessionClaims } from "./types";

// 7 days. This TTL is also the ceiling on how long a user's *own* Google-side
// revocation can lag: /deepgram/token trusts this JWT and never re-checks Google,
// so a self-revoke only bites when the app next re-mints (which force-refreshes the
// Google id token). The app persists + reuses this JWT across relaunch, so a longer
// TTL widens that lag; 7 days balances zero-I/O relaunch against revocation latency.
// (An admin revoke via the KV denylist still bites within ≤1h on the hot path.)
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
// Audience pins what this token is FOR. verifySessionToken requires it, so a
// token minted for any other purpose (or with the secret reused elsewhere) can't
// be replayed against the relay's protected endpoints (audit finding: missing aud).
const SESSION_AUDIENCE = "prompty-relay-session";

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(
  sub: string,
  secret: string
): Promise<{ token: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_TTL_SECONDS;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("prompty-relay")
    .setAudience(SESSION_AUDIENCE)
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secretKey(secret));
  return { token, exp };
}

export async function verifySessionToken(
  token: string,
  secret: string
): Promise<PromptySessionClaims> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    issuer: "prompty-relay",
    audience: SESSION_AUDIENCE,
    // Pin the algorithm so a token can't be smuggled in under "none" or an
    // asymmetric alg if the secret is ever mishandled (alg-confusion defense).
    algorithms: ["HS256"],
  });
  if (typeof payload.sub !== "string") {
    throw new Error("session token missing sub");
  }
  return {
    sub: payload.sub,
    iat: payload.iat ?? 0,
    exp: payload.exp ?? 0,
    iss: "prompty-relay",
  };
}
