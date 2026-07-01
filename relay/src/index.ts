import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  verifyGoogleIdentityToken,
  verifyGoogleIdentityTokenAllowingStale,
} from "./auth";
import { exchangeAuthCode, refreshAccessToken } from "./google-oauth";
import { mintDeepgramKey } from "./deepgram";
import { signSessionToken, verifySessionToken } from "./jwt";
import {
  dailyLimit,
  getUsedMints,
  incrementMints,
  isUnderLimit,
} from "./rate-limit";
import { isRevoked } from "./revocation";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

// The desktop app runs the PKCE authorize flow against a loopback redirect
// (http://localhost:<ephemeral-port>/callback — see app/.../google-auth.ts).
// Restrict the brokered code exchange to exactly that shape so a caller can't
// point the exchange at an attacker-controlled redirect_uri (audit finding).
function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  return (
    u.protocol === "http:" &&
    (u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
    u.pathname === "/callback"
  );
}

// Permissive CORS for /health only (lets us hit it from anywhere).
app.use("/health", cors({ origin: "*" }));

app.get("/health", (c) => {
  return c.json({ ok: true, ts: Math.floor(Date.now() / 1000) });
});

// Public app config — dynamic links the desktop app fetches on launch so they
// can be changed via wrangler vars + deploy without shipping a new signed build.
// No secrets here; the app also hardcodes fallbacks for when this is unreachable.
app.get("/config", (c) => {
  return c.json({
    foundersUrl: c.env.FOUNDERS_URL ?? "https://cal.com/team/revise-ai/quick-chat",
    howItWorksUrl: c.env.HOW_IT_WORKS_URL ?? "https://cal.com/team/revise-ai/quick-chat",
  });
});

// STOPGAP: parse ALLOW_STALE_GOOGLE_IDTOKEN_DAYS off env. Returns 0 (grace
// path disabled — today's behavior) if unset, empty, "0", or unparseable.
// A positive integer enables the grace path in /auth/google. Remove once
// the desktop app persists its session JWT and wires refresh (see
// google-auth.ts:354-391, currently dead code).
function graceDaysFromEnv(raw: string | undefined): number {
  if (typeof raw !== "string" || raw.trim() === "") return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

app.post("/auth/google", async (c) => {
  let body: { idToken?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const idToken = body?.idToken;
  if (typeof idToken !== "string" || idToken.length === 0) {
    return c.json({ error: "idToken required" }, 400);
  }

  let claims;
  try {
    claims = await verifyGoogleIdentityToken(idToken, c.env);
  } catch (err) {
    // STOPGAP grace path: if the token failed strictly because of exp and the
    // env flag is set, retry with a bounded grace window. Signature, iss, aud,
    // email_verified still enforced. See auth.ts:verifyGoogleIdentityTokenAllowingStale.
    const message = (err as Error).message ?? "";
    const isExpiredError =
      (err as { code?: string })?.code === "ERR_JWT_EXPIRED" ||
      /"exp" claim/i.test(message) ||
      /jwt expired/i.test(message);
    const graceDays = graceDaysFromEnv(c.env.ALLOW_STALE_GOOGLE_IDTOKEN_DAYS);
    if (isExpiredError && graceDays > 0) {
      try {
        claims = await verifyGoogleIdentityTokenAllowingStale(
          idToken,
          c.env,
          graceDays,
        );
        // Observability: count how many users are riding the stopgap so we
        // know when it's safe to remove ALLOW_STALE_GOOGLE_IDTOKEN_DAYS.
        console.log(
          JSON.stringify({
            event: "auth_google_grace_used",
            sub: claims.sub,
            graceDays,
            iat: claims.iat,
            ageSeconds: Math.floor(Date.now() / 1000) - (claims.iat ?? 0),
          }),
        );
      } catch (graceErr) {
        return c.json(
          { error: `google token invalid: ${(graceErr as Error).message}` },
          401,
        );
      }
    } else {
      return c.json(
        { error: `google token invalid: ${message}` },
        401,
      );
    }
  }

  if (await isRevoked(c.env, claims.sub)) {
    return c.json({ error: "account revoked" }, 403);
  }

  try {
    const { token } = await signSessionToken(claims.sub, c.env.PROMPTY_JWT_SECRET);
    return c.json({ sessionToken: token, userId: claims.sub });
  } catch (err) {
    return c.json(
      { error: `session mint failed: ${(err as Error).message}` },
      500
    );
  }
});

// The app needs the OAuth client ID (public) to build the authorize URL. It
// lives in the relay so the desktop bundle ships neither the ID nor the secret.
app.get("/auth/google/client-id", (c) => {
  return c.json({ clientId: c.env.GOOGLE_CLIENT_ID });
});

// Broker the PKCE authorization-code exchange so the client secret stays
// server-side. Body: { code, codeVerifier, redirectUri }.
app.post("/auth/google/exchange", async (c) => {
  let body: { code?: unknown; codeVerifier?: unknown; redirectUri?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const { code, codeVerifier, redirectUri } = body;
  if (
    typeof code !== "string" ||
    typeof codeVerifier !== "string" ||
    typeof redirectUri !== "string" ||
    !code ||
    !codeVerifier ||
    !redirectUri
  ) {
    return c.json({ error: "code, codeVerifier, redirectUri required" }, 400);
  }
  if (!isAllowedRedirectUri(redirectUri)) {
    return c.json({ error: "redirectUri must be a loopback /callback URL" }, 400);
  }
  try {
    const tokens = await exchangeAuthCode(c.env, { code, codeVerifier, redirectUri });
    return c.json(tokens);
  } catch (err) {
    return c.json({ error: `token exchange failed: ${(err as Error).message}` }, 502);
  }
});

// Broker the refresh-token grant. Body: { refreshToken }.
app.post("/auth/google/refresh", async (c) => {
  let body: { refreshToken?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const refreshToken = body?.refreshToken;
  if (typeof refreshToken !== "string" || !refreshToken) {
    return c.json({ error: "refreshToken required" }, 400);
  }
  try {
    const tokens = await refreshAccessToken(c.env, refreshToken);
    return c.json(tokens);
  } catch (err) {
    return c.json({ error: `token refresh failed: ${(err as Error).message}` }, 502);
  }
});

app.post("/deepgram/token", async (c) => {
  const authHeader = c.req.header("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return c.json({ error: "missing bearer token" }, 401);
  }
  const sessionToken = match[1].trim();

  let sub: string;
  try {
    const claims = await verifySessionToken(sessionToken, c.env.PROMPTY_JWT_SECRET);
    sub = claims.sub;
  } catch (err) {
    return c.json(
      { error: `session invalid: ${(err as Error).message}` },
      401
    );
  }

  // Revocation bites here within one key TTL (≤1h) — the hot path.
  if (await isRevoked(c.env, sub)) {
    return c.json({ error: "account revoked" }, 403);
  }

  if (!(await isUnderLimit(c.env, sub))) {
    const used = await getUsedMints(c.env, sub);
    return c.json(
      {
        error: "daily mint limit reached",
        used,
        limit: dailyLimit(c.env),
      },
      429
    );
  }

  let minted;
  try {
    minted = await mintDeepgramKey(c.env, sub);
  } catch (err) {
    return c.json(
      { error: `deepgram key mint failed: ${(err as Error).message}` },
      502
    );
  }

  // One mint = one count. A continuous call runs on a single key regardless of
  // length, so this reflects real usage windows, not call duration.
  try {
    await incrementMints(c.env, sub);
  } catch (err) {
    console.error("rate-limit increment failed", err);
  }

  return c.json({ key: minted.key, expiresAt: minted.expiresAt });
});

app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json({ error: "internal error" }, 500);
});

export default app;
