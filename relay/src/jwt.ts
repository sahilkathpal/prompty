import { SignJWT, jwtVerify } from "jose";
import type { PromptySessionClaims } from "./types";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

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
