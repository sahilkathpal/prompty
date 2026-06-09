import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifyGoogleIdentityToken } from "./auth";
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
