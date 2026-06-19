import { importJWK, jwtVerify, decodeProtectedHeader, type JWK } from "jose";
import type { GoogleIdentityClaims, Env } from "./types";

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const JWKS_CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h
const JWKS_CACHE_KEY = "google_jwks";

interface GoogleJWKS {
  keys: JWK[];
}

async function loadGoogleJWKS(env: Env): Promise<GoogleJWKS> {
  const cached = await env.GOOGLE_JWKS_CACHE.get(JWKS_CACHE_KEY, "json");
  if (cached && typeof cached === "object" && Array.isArray((cached as GoogleJWKS).keys)) {
    return cached as GoogleJWKS;
  }
  const res = await fetch(GOOGLE_JWKS_URL, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`failed to fetch Google JWKS: ${res.status}`);
  }
  const jwks = (await res.json()) as GoogleJWKS;
  if (!jwks || !Array.isArray(jwks.keys)) {
    throw new Error("malformed Google JWKS response");
  }
  await env.GOOGLE_JWKS_CACHE.put(JWKS_CACHE_KEY, JSON.stringify(jwks), {
    expirationTtl: JWKS_CACHE_TTL_SECONDS,
  });
  return jwks;
}

async function getGooglePublicKey(env: Env, kid: string, allowRefresh = true) {
  const jwks = await loadGoogleJWKS(env);
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) {
    if (allowRefresh) {
      await env.GOOGLE_JWKS_CACHE.delete(JWKS_CACHE_KEY);
      return getGooglePublicKey(env, kid, false);
    }
    throw new Error(`no Google public key for kid ${kid}`);
  }
  return importJWK(jwk, jwk.alg ?? "RS256");
}

/**
 * Validates a Google ID token: RS256 signature against Google's JWKS,
 * issuer one of accounts.google.com / https://accounts.google.com,
 * audience == GOOGLE_CLIENT_ID, exp in future, email_verified === true.
 */
export async function verifyGoogleIdentityToken(
  idToken: string,
  env: Env,
): Promise<GoogleIdentityClaims> {
  const header = decodeProtectedHeader(idToken);
  if (!header.kid) {
    throw new Error("Google ID token missing kid");
  }
  const key = await getGooglePublicKey(env, header.kid);
  const { payload } = await jwtVerify(idToken, key, {
    issuer: GOOGLE_ISSUERS,
    audience: env.GOOGLE_CLIENT_ID,
    algorithms: ["RS256"],
  });
  if (typeof payload.sub !== "string") {
    throw new Error("Google ID token missing sub");
  }
  const claims = payload as unknown as GoogleIdentityClaims;
  // Google sends email_verified as boolean (sometimes string in legacy clients).
  const verified =
    claims.email_verified === true ||
    (typeof claims.email_verified === "string" && claims.email_verified === "true");
  if (!verified) {
    throw new Error("Google ID token email not verified");
  }
  return claims;
}

// Test seam: lets tests inject a custom JWKS URL / verifier without hitting
// the real Google endpoint. Exported only for use by relay/tests.
export async function verifyGoogleIdentityTokenWithJwks(
  idToken: string,
  audience: string,
  jwks: GoogleJWKS,
): Promise<GoogleIdentityClaims> {
  const header = decodeProtectedHeader(idToken);
  if (!header.kid) throw new Error("missing kid");
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("no matching kid");
  const key = await importJWK(jwk, jwk.alg ?? "RS256");
  const { payload } = await jwtVerify(idToken, key, {
    issuer: GOOGLE_ISSUERS,
    audience,
    algorithms: ["RS256"],
  });
  if (typeof payload.sub !== "string") throw new Error("missing sub");
  const claims = payload as unknown as GoogleIdentityClaims;
  const verified =
    claims.email_verified === true ||
    (typeof claims.email_verified === "string" && claims.email_verified === "true");
  if (!verified) throw new Error("email not verified");
  return claims;
}
