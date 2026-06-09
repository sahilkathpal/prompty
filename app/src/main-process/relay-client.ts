// Relay client (Stage 2) — Google-authenticated.
//
// The Electron app holds Google OAuth tokens via google-auth.ts. This module
// exchanges the user's Google ID token for a Prompty session JWT at the
// relay's /auth/google endpoint, caches the JWT in memory, and mints
// Deepgram ephemeral keys against /deepgram/token.

import { getSession, signInWithGoogle } from "./google-auth";
import { relayBaseUrl } from "./relay-config";

interface CachedSession {
  sessionToken: string;
  userId: string;
}

let cachedSession: CachedSession | null = null;
let cachedDeepgramKey: { key: string; expiresAt: number } | null = null;

export function clearSessionCache(): void {
  cachedSession = null;
  cachedDeepgramKey = null;
}

async function postAuthGoogle(idToken: string): Promise<CachedSession> {
  const resp = await fetch(`${relayBaseUrl()}/auth/google`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`relay /auth/google ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as CachedSession;
  if (!data.sessionToken || !data.userId) {
    throw new Error("relay returned malformed session");
  }
  return data;
}

/**
 * Returns the cached relay session token, minting one from the user's Google
 * ID token if absent. Returns null if the user is not signed into Google.
 */
export async function getSessionToken(): Promise<string | null> {
  if (cachedSession) return cachedSession.sessionToken;
  const g = getSession();
  if (!g || !g.idToken) return null;
  try {
    cachedSession = await postAuthGoogle(g.idToken);
    return cachedSession.sessionToken;
  } catch (e) {
    console.error("[relay] /auth/google failed:", (e as Error).message);
    return null;
  }
}

export async function getUserId(): Promise<string | null> {
  if (cachedSession) return cachedSession.userId;
  const g = getSession();
  return g?.sub ?? null;
}

/**
 * Sign in to Google (opens BrowserWindow), then exchange ID token for a
 * relay session JWT. Returns the persisted session.
 */
export async function signInWithGoogleAndRelay(): Promise<{ userId: string; email: string }> {
  const r = await signInWithGoogle();
  try {
    cachedSession = await postAuthGoogle(r.idToken);
  } catch (e) {
    console.error("[relay] /auth/google failed (continuing locally):", (e as Error).message);
  }
  cachedDeepgramKey = null;
  return { userId: r.userId, email: r.email };
}

export async function getDeepgramToken(): Promise<string> {
  const now = Date.now();
  if (cachedDeepgramKey && cachedDeepgramKey.expiresAt - now > 10 * 60 * 1000) {
    return cachedDeepgramKey.key;
  }
  const session = await getSessionToken();
  if (!session) {
    throw new Error("not signed in — sign in with Google first");
  }
  const resp = await fetch(`${relayBaseUrl()}/deepgram/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session}`,
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`relay /deepgram/token ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { key: string; expiresAt: number };
  if (!data.key) throw new Error("relay returned malformed deepgram key");
  cachedDeepgramKey = {
    key: data.key,
    expiresAt: data.expiresAt > 1e12 ? data.expiresAt : data.expiresAt * 1000,
  };
  return data.key;
}
