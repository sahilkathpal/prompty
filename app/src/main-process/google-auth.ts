// Google OAuth (installed-app PKCE flow) for Electron.
//
// Opens a BrowserWindow at Google's authorize URL, captures the auth code
// at a loopback redirect, exchanges for tokens via PKCE (no client secret),
// and persists tokens encrypted with safeStorage.

import { app, BrowserWindow, safeStorage } from "electron";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { relayBaseUrl } from "./relay-config";

const SESSION_FILENAME = "google-session.bin";

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

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
  try {
    const p = sessionPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p);
    let decoded: string;
    if (safeStorage.isEncryptionAvailable()) {
      try {
        decoded = safeStorage.decryptString(raw);
      } catch {
        // May have been written as plaintext during e2e.
        decoded = raw.toString("utf8");
      }
    } else {
      decoded = raw.toString("utf8");
    }
    return JSON.parse(decoded) as GoogleSession;
  } catch (e) {
    console.error("[google-auth] readSession failed:", (e as Error).message);
    return null;
  }
}

function writeSessionFile(s: GoogleSession): void {
  const p = sessionPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(JSON.stringify(s));
    fs.writeFileSync(p, enc);
  } else {
    fs.writeFileSync(p, JSON.stringify(s), "utf8");
  }
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

export async function signInWithGoogle(): Promise<{ userId: string; email: string; idToken: string }> {
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

  const win = new BrowserWindow({
    width: 500,
    height: 700,
    title: "Sign in with Google",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(authUrl.toString());

  let closed = false;
  win.on("closed", () => {
    closed = true;
  });

  let result: LoopbackResult;
  try {
    result = await loopback.result;
  } finally {
    loopback.close();
    if (!closed) {
      try {
        win.close();
      } catch {}
    }
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
}

/**
 * Returns a fresh access token. Refreshes via refresh_token if expired/near
 * expiry.
 */
export async function getAccessToken(): Promise<string> {
  const s = readSessionFile();
  if (!s) throw new Error("not signed in — call signInWithGoogle() first");
  // Refresh ~60 seconds before expiry.
  if (s.accessToken && s.expiresAt - Date.now() > 60_000) {
    return s.accessToken;
  }
  const refreshed = await refreshAccessToken(s.refreshToken);
  const next: GoogleSession = {
    ...s,
    accessToken: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    // Google may rotate the refresh_token
    refreshToken: refreshed.refresh_token ?? s.refreshToken,
    idToken: refreshed.id_token ?? s.idToken,
  };
  writeSessionFile(next);
  return next.accessToken;
}

/**
 * Force-refresh the access token unconditionally. Used by callers that
 * receive 401 from a downstream API.
 */
export async function forceRefreshAccessToken(): Promise<string> {
  const s = readSessionFile();
  if (!s) throw new Error("not signed in");
  const refreshed = await refreshAccessToken(s.refreshToken);
  const next: GoogleSession = {
    ...s,
    accessToken: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    refreshToken: refreshed.refresh_token ?? s.refreshToken,
    idToken: refreshed.id_token ?? s.idToken,
  };
  writeSessionFile(next);
  return next.accessToken;
}

// Exposed for tests to inject a session deterministically.
export function _writeSessionForTests(s: GoogleSession): void {
  writeSessionFile(s);
}
