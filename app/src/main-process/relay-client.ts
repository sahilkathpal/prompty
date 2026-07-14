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
const SESSION_FILENAME = "relay-session.bin";
// Reuse a cached key only while it has comfortably more than this left. The
// stream is only auth'd at the initial WebSocket connect, so a key with ≥10 min
// remaining is safe to start a fresh socket on.
const REUSE_MARGIN_MS = 10 * 60 * 1000;
// Re-mint the session JWT when it has less than this left. The relay signs it
// for 7 days; a day of margin means a relaunch almost always reuses the
// persisted JWT (zero Google I/O) and only re-mints ~weekly or on a cold miss.
const SESSION_REUSE_MARGIN_MS = 24 * 60 * 60 * 1000;
// Fallback lifetime if the session JWT's exp claim can't be read (shouldn't
// happen — the relay always signs an exp). Conservative so we re-mint sooner.
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface RelaySession {
  sessionToken: string;
  userId: string;
}

interface CachedSession extends RelaySession {
  expiresAt: number; // ms epoch, from the JWT exp claim
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

function sessionPath(): string {
  return path.join(app.getPath("userData"), SESSION_FILENAME);
}

/** ms-epoch expiry from a JWT's `exp` claim, or null if it can't be read. */
function jwtExpMs(jwt: string): number | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    const padded = parts[1] + "===".slice((parts[1].length + 3) % 4);
    const payload = JSON.parse(
      Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function readSessionCacheFile(): CachedSession | null {
  const decoded = readSecretFile(sessionPath());
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as CachedSession;
    if (!parsed.sessionToken || !parsed.userId || typeof parsed.expiresAt !== "number") return null;
    return parsed;
  } catch (e) {
    console.error("[relay] readSession parse failed:", (e as Error).message);
    return null;
  }
}

function writeSessionCacheFile(c: CachedSession): void {
  // Encrypted, or skipped in a packaged build without encryption — losing it is
  // safe (we re-mint via the Google refresh), it's only a launch-time optimization.
  writeSecretFile(sessionPath(), JSON.stringify(c));
}

function clearSessionCacheFile(): void {
  try {
    fs.unlinkSync(sessionPath());
  } catch {}
}

/** Cache a freshly-minted session in memory + on disk, keyed by its JWT expiry. */
function cacheSession(s: RelaySession): string {
  cachedSession = { ...s, expiresAt: jwtExpMs(s.sessionToken) ?? Date.now() + DEFAULT_SESSION_TTL_MS };
  writeSessionCacheFile(cachedSession);
  return cachedSession.sessionToken;
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
  clearSessionCacheFile();
}

/** Test-only: drop the in-memory caches WITHOUT touching disk (simulate relaunch). */
export function __resetSessionMemoryForTests(): void {
  cachedSession = null;
  cachedDeepgramKey = null;
}

/** Test-only: clear the revalidation throttle so a fresh revalidateAuth() runs. */
export function __resetRevalidateThrottleForTests(): void {
  lastRevalidateAt = 0;
}

async function postAuthGoogle(idToken: string): Promise<RelaySession> {
  const resp = await fetch(`${relayBaseUrl()}/auth/google`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new RelayHttpError(resp.status, `relay /auth/google ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as RelaySession;
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
    return cacheSession(await postAuthGoogle(idToken));
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
 * Returns a usable relay session token, reusing the persisted 30-day JWT
 * (memory → disk) while it has comfortable life left, otherwise minting a fresh
 * one from a FRESH Google ID token. A relaunch within the JWT's life does ZERO
 * Google I/O. Returns null if the user is not signed into Google.
 */
export async function getSessionToken(): Promise<string | null> {
  const now = Date.now();
  if (!cachedSession) {
    const fromDisk = readSessionCacheFile();
    if (fromDisk) cachedSession = fromDisk;
  }
  if (cachedSession && cachedSession.expiresAt - now > SESSION_REUSE_MARGIN_MS) {
    return cachedSession.sessionToken;
  }
  return mintSession(false);
}

// Throttle proactive revalidation so bursty triggers (window focus, repeated
// Settings opens) can't hammer Google's token endpoint.
let lastRevalidateAt = 0;
const REVALIDATE_THROTTLE_MS = 60 * 1000;

/**
 * Proactively confirm the Google refresh token is still valid, so a revoke is
 * detected — and the local session cleared + the UI flipped to signed-out —
 * WITHOUT waiting for the next call or for the 7-day relay JWT to age out.
 *
 * This closes the "phantom signed-in" gap: auth:status / authSatisfied report
 * signed-in purely from the presence of google-session.bin, and the only code
 * that clears it (handleReauthRequired) previously ran solely as a side effect of
 * a lazy mintSession. Opening Settings or focusing the window never triggered
 * that, so a revoked user kept seeing a green "Signed in" row for days.
 *
 * Forces the refresh grant against Google; an invalid_grant routes through the
 * normal re-auth teardown. No-op when not signed in. Transient network errors are
 * ignored — we never sign a user out on a blip. Throttled so focus/status churn
 * can't spam the endpoint.
 */
export async function revalidateAuth(): Promise<void> {
  if (!getSession()) return; // not signed in — nothing to validate
  const now = Date.now();
  if (now - lastRevalidateAt < REVALIDATE_THROTTLE_MS) return;
  lastRevalidateAt = now;
  try {
    await forceRefreshIdToken();
  } catch (e) {
    if (e instanceof RefreshTokenRevokedError) handleReauthRequired("revalidate");
    else console.warn("[relay] auth revalidation skipped (transient):", (e as Error).message);
  }
}

export async function getUserId(): Promise<string | null> {
  if (!cachedSession) {
    const fromDisk = readSessionCacheFile();
    if (fromDisk) cachedSession = fromDisk;
  }
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
    cacheSession(await postAuthGoogle(r.idToken));
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
