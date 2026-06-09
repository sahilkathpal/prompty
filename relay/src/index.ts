import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifyGoogleIdentityToken } from "./auth";
import { exchangeAuthCode, refreshAccessToken } from "./google-oauth";
import { mintDeepgramKey } from "./deepgram";
import { signSessionToken, verifySessionToken } from "./jwt";
import {
  dailyLimit,
  getUsedMinutes,
  incrementMinutes,
  isUnderLimit,
} from "./rate-limit";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

// Permissive CORS for /health only (lets us hit it from anywhere).
app.use("/health", cors({ origin: "*" }));

app.get("/health", (c) => {
  return c.json({ ok: true, ts: Math.floor(Date.now() / 1000) });
});

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
    return c.json(
      { error: `google token invalid: ${(err as Error).message}` },
      401
    );
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

  if (!(await isUnderLimit(c.env, sub))) {
    const used = await getUsedMinutes(c.env, sub);
    return c.json(
      {
        error: "daily minute limit reached",
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

  // Over-count by the full key TTL (60 minutes). We're rate-limiting bursts,
  // not metering — better to over-count than risk runaway usage.
  try {
    await incrementMinutes(c.env, sub, 60);
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
