// Relay client — Google-authenticated.
//
// The Electron app holds Google OAuth tokens via google-auth.ts. This module
// exchanges the user's Google ID token for a Prompty session JWT at the relay's
// /auth/google endpoint, caches the JWT in memory, and mints Deepgram ephemeral
// keys against /deepgram/token.
//
// The minted Deepgram key is cached both in memory AND on disk (encrypted via
// safeStorage at userData/deepgram-key.bin). Disk persistence means an app
// quit+relaunch inside a key's ~1h window reuses the same key instead of
// minting a fresh one — so the daily mint cap reflects real usage windows, not
// restart count (RUBY_AUTH_RELAY_PLAN.md §Phase B 2b).

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  getSession,
  getFreshIdToken,
  forceRefreshIdToken,
  signInWithGoogle,
  signOut as googleSignOut,
  RefreshTokenRevokedError,
} from "./google-auth";
import { relayBaseUrl } from "./relay-config";
import { readSecretFile, writeSecretFile } from "./secret-file";

/** A non-OK HTTP response from the relay, carrying the status for retry logic. */
class RelayHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RelayHttpError";
  }
}

// Re-auth signal: when the Google refresh token is revoked/expired
// (invalid_grant), the relay client can't recover — the app layer must clear
// signed-in state, rotate the analytics anon id, and prompt a fresh sign-in.
// The electron layer registers this handler (see ipc-handlers) to keep relay
// state out of the settings/broadcast layer.
type ReauthHandler = (reason: string) => void;
let reauthHandler: ReauthHandler | null = null;
export function setReauthHandler(fn: ReauthHandler | null): void {
  reauthHandler = fn;
}

/** Refresh token is dead: drop all local auth state and notify the app layer. */
function handleReauthRequired(reason: string): void {
  console.warn(`[relay] re-auth required: ${reason}`);
  googleSignOut();
  clearSessionCache();
  reauthHandler?.(reason);
}

const DEEPGRAM_KEY_FILENAME = "deepgram-key.bin";
// Reuse a cached key only while it has comfortably more than this left. The
// stream is only auth'd at the initial WebSocket connect, so a key with ≥10 min
// remaining is safe to start a fresh socket on.
const REUSE_MARGIN_MS = 10 * 60 * 1000;

interface CachedSession {
  sessionToken: string;
  userId: string;
}

interface DeepgramKeyCache {
  key: string;
  expiresAt: number; // ms epoch
}

let cachedSession: CachedSession | null = null;
let cachedDeepgramKey: DeepgramKeyCache | null = null;

function deepgramKeyPath(): string {
  return path.join(app.getPath("userData"), DEEPGRAM_KEY_FILENAME);
}

function readDeepgramKeyFile(): DeepgramKeyCache | null {
  const decoded = readSecretFile(deepgramKeyPath());
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as DeepgramKeyCache;
    if (!parsed.key || typeof parsed.expiresAt !== "number") return null;
    return parsed;
  } catch (e) {
    console.error("[relay] readDeepgramKey parse failed:", (e as Error).message);
    return null;
  }
}

function writeDeepgramKeyFile(c: DeepgramKeyCache): void {
  // Encrypted, or skipped entirely in a packaged build without encryption — the
  // on-disk cache is only an optimization, so losing it is safe (we re-mint).
  writeSecretFile(deepgramKeyPath(), JSON.stringify(c));
}

function clearDeepgramKeyFile(): void {
  try {
    fs.unlinkSync(deepgramKeyPath());
  } catch {}
}

export function clearSessionCache(): void {
  cachedSession = null;
  cachedDeepgramKey = null;
  clearDeepgramKeyFile();
}

async function postAuthGoogle(idToken: string): Promise<CachedSession> {
  const resp = await fetch(`${relayBaseUrl()}/auth/google`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new RelayHttpError(resp.status, `relay /auth/google ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as CachedSession;
  if (!data.sessionToken || !data.userId) {
    throw new Error("relay returned malformed session");
  }
  return data;
}

/**
 * Mint a relay session JWT from a fresh Google ID token. `force` force-refreshes
 * the idToken first (used after a 401, when the current idToken may be why the
 * relay rejected us). If /auth/google itself returns 401 on the first try, we
 * force-refresh and retry once. Returns null when not signed in or on a
 * non-recoverable failure; an `invalid_grant` triggers the re-auth path.
 */
async function mintSession(force: boolean): Promise<string | null> {
  let idToken: string;
  try {
    idToken = force ? await forceRefreshIdToken() : await getFreshIdToken();
  } catch (e) {
    if (e instanceof RefreshTokenRevokedError) handleReauthRequired("invalid_grant");
    else console.error("[relay] could not get fresh idToken:", (e as Error).message);
    return null;
  }
  try {
    cachedSession = await postAuthGoogle(idToken);
    return cachedSession.sessionToken;
  } catch (e) {
    // A stale idToken the relay rejects → force-refresh and retry once.
    if (e instanceof RelayHttpError && e.status === 401 && !force) {
      return mintSession(true);
    }
    console.error("[relay] /auth/google failed:", (e as Error).message);
    return null;
  }
}

/**
 * Returns the cached relay session token, minting one from a FRESH Google ID
 * token if absent. Returns null if the user is not signed into Google.
 */
export async function getSessionToken(): Promise<string | null> {
  if (cachedSession) return cachedSession.sessionToken;
  return mintSession(false);
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
  // A new identity invalidates any previously minted key.
  cachedDeepgramKey = null;
  clearDeepgramKeyFile();
  return { userId: r.userId, email: r.email };
}

/**
 * Returns a usable Deepgram key, reusing a cached one (memory → disk) while it
 * has comfortable life left, otherwise minting a fresh 1h key from the relay.
 * Called on every Deepgram socket connect (including reconnects), so a long
 * call that drops past the key's hour re-mints, while reconnects within the
 * hour reuse the key (no extra mints). See RUBY_AUTH_RELAY_PLAN.md §Phase B 2a/2b.
 */
export async function getDeepgramToken(): Promise<string> {
  const now = Date.now();
  // In-memory cache first, then the encrypted on-disk cache (survives relaunch).
  if (!cachedDeepgramKey) {
    const fromDisk = readDeepgramKeyFile();
    if (fromDisk) cachedDeepgramKey = fromDisk;
  }
  if (cachedDeepgramKey && cachedDeepgramKey.expiresAt - now > REUSE_MARGIN_MS) {
    return cachedDeepgramKey.key;
  }

  let session = await getSessionToken();
  if (!session) {
    throw new Error("not signed in — sign in with Google first");
  }
  try {
    return cacheAndReturn(await requestDeepgramKey(session));
  } catch (e) {
    // Session JWT rejected (expired 30-day token, or minted from a since-rotated
    // identity). Drop it, mint a fresh one — force-refreshing the idToken — and
    // retry exactly once.
    if (!(e instanceof RelayHttpError) || e.status !== 401) throw e;
    cachedSession = null;
    session = await mintSession(true);
    if (!session) throw new Error("not signed in — sign in with Google first");
    return cacheAndReturn(await requestDeepgramKey(session));
  }
}

async function requestDeepgramKey(session: string): Promise<DeepgramKeyCache> {
  const resp = await fetch(`${relayBaseUrl()}/deepgram/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session}`,
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new RelayHttpError(resp.status, `relay /deepgram/token ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { key: string; expiresAt: number };
  if (!data.key) throw new Error("relay returned malformed deepgram key");
  return {
    key: data.key,
    expiresAt: data.expiresAt > 1e12 ? data.expiresAt : data.expiresAt * 1000,
  };
}

function cacheAndReturn(key: DeepgramKeyCache): string {
  cachedDeepgramKey = key;
  writeDeepgramKeyFile(key);
  return key.key;
}
