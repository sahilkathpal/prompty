// Google OAuth (installed-app PKCE flow) for Electron.
//
// Opens Google's authorize URL in the user's *system browser* (not an embedded
// BrowserWindow — Google blocks OAuth in embedded webviews with a
// "disallowed_useragent" error, which renders as a broken/JS-less page), then
// captures the auth code at a loopback redirect, exchanges for tokens via PKCE
// (no client secret), and persists tokens encrypted with safeStorage.

import { app, shell } from "electron";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { relayBaseUrl } from "./relay-config";
import { readSecretFile, writeSecretFile } from "./secret-file";

const SESSION_FILENAME = "google-session.bin";

// Identity only — Calendar scope dropped (RUBY_AUTH_RELAY_PLAN.md §Rethink #4).
const SCOPES = ["openid", "email", "profile"].join(" ");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  sub: string;
  email: string;
  idToken?: string;
}

/**
 * The refresh token was rejected by Google with `invalid_grant` — it was
 * revoked (user removed the app in their Google account) or expired (6-month
 * inactivity). This is the one legitimate re-sign-in case: the caller must clear
 * the session and prompt a fresh sign-in, not retry.
 */
export class RefreshTokenRevokedError extends Error {
  constructor() {
    super("google refresh token revoked (invalid_grant)");
    this.name = "RefreshTokenRevokedError";
  }
}

// Injected telemetry hook: fired when a refresh grant fails for a transient
// (non-invalid_grant) reason. Kept as an injected callback so this module stays
// decoupled from the electron analytics layer — the electron layer registers it
// (mirrors relay-client's setReauthHandler). `reason` is a coarse label (error
// name), never a raw message, so no content leaks into analytics.
type RefreshFailedHandler = (reason: string) => void;
let refreshFailedHandler: RefreshFailedHandler | null = null;
export function setRefreshFailedHandler(fn: RefreshFailedHandler | null): void {
  refreshFailedHandler = fn;
}

// The OAuth client ID and secret are NOT bundled with the app. The relay
// holds them and brokers the two operations that need the secret — the
// authorization-code exchange and the refresh-token grant — so nothing
// confidential ships in the binary. The client ID (needed to build the
// authorize URL) is fetched from the relay and cached.
//
// Dev escape hatch: set PROMPTY_GOOGLE_CLIENT_ID and PROMPTY_GOOGLE_CLIENT_SECRET
// to talk to Google directly and bypass the relay (e.g. testing against a
// different Cloud project, or offline from a deployed relay).
let cachedClientId: string | null = null;

async function clientId(): Promise<string> {
  const override = process.env.PROMPTY_GOOGLE_CLIENT_ID?.trim();
  if (override) return override;
  if (cachedClientId) return cachedClientId;
  const resp = await fetch(`${relayBaseUrl()}/auth/google/client-id`);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(
      `relay /auth/google/client-id ${resp.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await resp.json()) as { clientId?: string };
  if (!data.clientId) throw new Error("relay returned no clientId");
  cachedClientId = data.clientId;
  return cachedClientId;
}

// Present only in dev. When set, the token exchange/refresh hits Google
// directly instead of being brokered by the relay.
function localClientSecret(): string | null {
  return process.env.PROMPTY_GOOGLE_CLIENT_SECRET?.trim() || null;
}

function sessionPath(): string {
  return path.join(app.getPath("userData"), SESSION_FILENAME);
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

function decodeJwtPayload<T = Record<string, unknown>>(jwt: string): T {
  const parts = jwt.split(".");
  if (parts.length < 2) throw new Error("malformed JWT");
  const padded = parts[1] + "===".slice((parts[1].length + 3) % 4);
  const json = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json) as T;
}

function readSessionFile(): GoogleSession | null {
  const decoded = readSecretFile(sessionPath());
  if (!decoded) return null;
  try {
    return JSON.parse(decoded) as GoogleSession;
  } catch (e) {
    console.error("[google-auth] readSession parse failed:", (e as Error).message);
    return null;
  }
}

function writeSessionFile(s: GoogleSession): void {
  // The Google session holds a long-lived refresh token — never persisted in
  // cleartext in a packaged build (writeSecretFile skips rather than leak it).
  writeSecretFile(sessionPath(), JSON.stringify(s));
}

export function getSession(): GoogleSession | null {
  return readSessionFile();
}

export function signOut(): void {
  try {
    fs.unlinkSync(sessionPath());
  } catch {}
}

interface LoopbackResult {
  code: string;
  state: string;
  redirectUri: string;
}

function startLoopbackServer(
  expectedState: string,
): Promise<{ result: Promise<LoopbackResult>; port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    let resolveResult!: (r: LoopbackResult) => void;
    let rejectResult!: (e: Error) => void;
    const result = new Promise<LoopbackResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/callback") {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        if (error) {
          res.statusCode = 400;
          res.end(`OAuth error: ${error}`);
          rejectResult(new Error(`Google returned error: ${error}`));
          return;
        }
        if (!code || !state) {
          res.statusCode = 400;
          res.end("missing code/state");
          rejectResult(new Error("missing code/state from Google"));
          return;
        }
        if (state !== expectedState) {
          res.statusCode = 400;
          res.end("state mismatch");
          rejectResult(new Error("state mismatch"));
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html");
        res.end(
          "<html><body style='font-family:-apple-system'><h3>Signed in.</h3><p>You can close this window.</p></body></html>",
        );
        const port = (server.address() as { port: number }).port;
        resolveResult({ code, state, redirectUri: `http://localhost:${port}/callback` });
      } catch (e) {
        rejectResult(e as Error);
      }
    });
    server.on("error", (e) => reject(e));
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        result,
        port,
        close: () => {
          try {
            server.close();
          } catch {}
        },
      });
    });
  });
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  scope?: string;
}

// Direct Google token request — dev-only path, gated on a local client secret.
async function googleTokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`google token request failed ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as TokenResponse;
}

// Relay-brokered token request — the default path. The relay attaches the
// client_id + client_secret server-side and returns Google's token response.
async function relayTokenRequest(
  endpoint: string,
  payload: Record<string, string>,
): Promise<TokenResponse> {
  const resp = await fetch(`${relayBaseUrl()}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`relay ${endpoint} ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as TokenResponse;
}

async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const secret = localClientSecret();
  if (secret) {
    return googleTokenRequest(
      new URLSearchParams({
        code,
        client_id: await clientId(),
        client_secret: secret,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    );
  }
  return relayTokenRequest("/auth/google/exchange", {
    code,
    codeVerifier: verifier,
    redirectUri,
  });
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const secret = localClientSecret();
  if (secret) {
    return googleTokenRequest(
      new URLSearchParams({
        client_id: await clientId(),
        client_secret: secret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    );
  }
  return relayTokenRequest("/auth/google/refresh", { refreshToken });
}

// Best practice (RFC 8252 §8.2 / Google "OAuth for Native Apps"): keep exactly
// ONE in-flight authorization at a time. The user may trigger "Sign in" again —
// or use the reopen/cancel affordances — while the system browser is still open.
// We reuse the SAME flow (same loopback port and `state`) so any browser tab they
// already have open stays valid, instead of spawning a parallel loopback with a
// rotated state (which would strand the open tab). reopenSignIn() re-opens the
// same authorize URL; cancelSignIn() tears the flow down.
type PendingSignIn = {
  authUrl: string;
  cancel: () => void;
  promise: Promise<{ userId: string; email: string; idToken: string }>;
};
let pendingSignIn: PendingSignIn | null = null;

/**
 * Re-open the system browser to the in-flight authorize URL. For the case where
 * the user closed/lost the tab we opened. Returns false if no sign-in is running.
 */
export function reopenSignIn(): boolean {
  if (!pendingSignIn || !pendingSignIn.authUrl) return false;
  void shell.openExternal(pendingSignIn.authUrl);
  return true;
}

/** Cancel the in-flight sign-in (user backed out). No-op if none is running. */
export function cancelSignIn(): void {
  pendingSignIn?.cancel();
}

export function signInWithGoogle(): Promise<{ userId: string; email: string; idToken: string }> {
  // Already authorizing → don't start a parallel flow. Re-open the same URL and
  // join the existing attempt so a still-open tab keeps working.
  if (pendingSignIn) {
    void shell.openExternal(pendingSignIn.authUrl);
    return pendingSignIn.promise;
  }

  // Cancellation channel: cancelSignIn() rejects this so the race below unblocks
  // with a distinct "cancelled" error the renderer can treat quietly.
  let rejectCancelled!: (e: Error) => void;
  const cancelled = new Promise<never>((_, rej) => {
    rejectCancelled = rej;
  });
  cancelled.catch(() => {});

  const entry: PendingSignIn = {
    authUrl: "",
    cancel: () => rejectCancelled(new Error("Sign-in cancelled.")),
    // Filled in synchronously below.
    promise: undefined as unknown as PendingSignIn["promise"],
  };
  pendingSignIn = entry;

  const run = async (): Promise<{ userId: string; email: string; idToken: string }> => {
    const cid = await clientId();
    const { verifier, challenge } = makePkce();
    const state = base64url(crypto.randomBytes(16));

    const loopback = await startLoopbackServer(state);
    const redirectUri = `http://localhost:${loopback.port}/callback`;

    const authUrl = new URL(AUTH_URL);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", cid);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", SCOPES);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    entry.authUrl = authUrl.toString();

    // Open in the system browser. Google rejects OAuth in embedded webviews
    // (Electron BrowserWindow), so the loopback redirect is what brings the code
    // back to us — see RFC 8252 (OAuth 2.0 for Native Apps).
    await shell.openExternal(entry.authUrl);

    // The system browser has no "window closed" signal we can observe. Bound the
    // wait three ways: the loopback callback (success), a 5-min abandon timeout,
    // or an explicit user cancel.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Sign-in timed out. Please try again.")),
        5 * 60 * 1000,
      );
    });
    // Swallow the rejection when the timeout isn't the race winner (success or a
    // loopback error settled first) so it never surfaces as an unhandled rejection.
    timedOut.catch(() => {});

    let result: LoopbackResult;
    try {
      result = await Promise.race([loopback.result, timedOut, cancelled]);
    } finally {
      if (timer) clearTimeout(timer);
      loopback.close();
    }

    const tokens = await exchangeCode(result.code, verifier, redirectUri);
    if (!tokens.id_token || !tokens.refresh_token) {
      throw new Error("Google did not return id_token + refresh_token");
    }
    const idClaims = decodeJwtPayload<{ sub?: string; email?: string; email_verified?: boolean }>(
      tokens.id_token,
    );
    if (!idClaims.sub || !idClaims.email) {
      throw new Error("id_token missing sub/email");
    }
    const session: GoogleSession = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      sub: idClaims.sub,
      email: idClaims.email,
      idToken: tokens.id_token,
    };
    writeSessionFile(session);
    return { userId: session.sub, email: session.email, idToken: tokens.id_token };
  };

  const promise = run().finally(() => {
    if (pendingSignIn === entry) pendingSignIn = null;
  });
  entry.promise = promise;
  return promise;
}

/**
 * Run the refresh grant and persist the rotated tokens (access, id, and the
 * possibly-rotated refresh token). The single place a refresh happens — both the
 * access-token and id-token accessors funnel here. A Google `invalid_grant`
 * (revoked/expired refresh token) is surfaced as RefreshTokenRevokedError so the
 * caller can distinguish "must re-sign-in" from a transient failure.
 */
async function refreshSession(s: GoogleSession): Promise<GoogleSession> {
  // E2E hook: force every refresh to behave as a revoked token (invalid_grant),
  // so the revoke → teardown → signed-out-UI path can be driven deterministically
  // without a real Google round-trip. Mirrors PROMPTY_E2E_FORCE_PREFLIGHT.
  if (process.env.PROMPTY_E2E_FORCE_REVOKE === "1") throw new RefreshTokenRevokedError();
  let refreshed: TokenResponse;
  try {
    refreshed = await refreshAccessToken(s.refreshToken);
  } catch (e) {
    if (/invalid_grant/.test((e as Error).message)) throw new RefreshTokenRevokedError();
    // A transient (non-revoke) refresh failure — network, relay, Google 5xx. The
    // caller decides recovery; we surface it to telemetry so a broken refresh
    // path is visible without waiting for users to report dead calls.
    refreshFailedHandler?.((e as Error).name || "error");
    throw e;
  }
  const next: GoogleSession = {
    ...s,
    accessToken: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    // Google may rotate the refresh_token; it returns a fresh id_token on the
    // refresh grant because the original consent carried the openid scope.
    refreshToken: refreshed.refresh_token ?? s.refreshToken,
    idToken: refreshed.id_token ?? s.idToken,
  };
  writeSessionFile(next);
  return next;
}

/**
 * Return the stored session, refreshing it first if the access token is within
 * ~60s of expiry (the id_token expires on the same ~1h clock, so this keeps both
 * fresh). Throws if not signed in.
 */
export async function ensureFreshSession(): Promise<GoogleSession> {
  const s = readSessionFile();
  if (!s) throw new Error("not signed in — call signInWithGoogle() first");
  if (s.accessToken && s.expiresAt - Date.now() > 60_000) return s;
  return refreshSession(s);
}

/** A fresh Google access token (refreshes when near expiry). */
export async function getAccessToken(): Promise<string> {
  return (await ensureFreshSession()).accessToken;
}

/**
 * A fresh Google ID token (refreshes when near expiry). This is what the relay
 * client posts to /auth/google — refreshing it here is the fix that lets a
 * relaunch mint a session without a stale-idToken grace.
 */
export async function getFreshIdToken(): Promise<string> {
  const s = await ensureFreshSession();
  if (!s.idToken) throw new Error("session has no id_token");
  return s.idToken;
}

/** Force-refresh unconditionally. Used by callers that receive a downstream 401. */
export async function forceRefreshAccessToken(): Promise<string> {
  const s = readSessionFile();
  if (!s) throw new Error("not signed in");
  return (await refreshSession(s)).accessToken;
}

/** Force-refresh and return a fresh ID token. Used on a relay 401 before retry. */
export async function forceRefreshIdToken(): Promise<string> {
  const s = readSessionFile();
  if (!s) throw new Error("not signed in");
  const next = await refreshSession(s);
  if (!next.idToken) throw new Error("refresh returned no id_token");
  return next.idToken;
}

// Exposed for tests to inject a session deterministically.
export function _writeSessionForTests(s: GoogleSession): void {
  writeSessionFile(s);
}
