// Smoke test for the relay-client auth wiring (RUBY_AUTH_REFRESH_PLAN Phase 1):
//   - getSessionToken mints the session JWT from a FRESH Google id token,
//   - a /deepgram/token 401 force-refreshes the id token, re-mints, retries once,
//   - a refresh invalid_grant fires the re-auth handler and clears the session.
//
// Same offline harness as smoke-google-token-refresh: electron is shimmed via
// Module._resolveFilename and every network call goes through a programmable
// globalThis.fetch. The dev escape hatch (PROMPTY_GOOGLE_CLIENT_SECRET) routes
// Google refreshes straight to oauth2.googleapis.com; PROMPTY_RELAY_URL points
// the relay calls at a stub host.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Module from "node:module";

// ---- Electron shim ---------------------------------------------------------

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "prompty-relay-test-"));

const electronShim = {
  app: {
    getPath: (_name: string) => tmpUserData,
    isPackaged: false,
  },
  BrowserWindow: class {},
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
};

const origResolve = (Module as unknown as {
  _resolveFilename: (req: string, ...rest: unknown[]) => string;
})._resolveFilename;
(Module as unknown as {
  _resolveFilename: (req: string, ...rest: unknown[]) => string;
})._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "electron") return "electron-shim";
  return origResolve.call(this, request, ...rest);
};
require.cache["electron-shim"] = {
  id: "electron-shim",
  filename: "electron-shim",
  loaded: true,
  // @ts-expect-error - partial NodeModule
  exports: electronShim,
};

// ---- Fetch shim ------------------------------------------------------------

interface FetchCall {
  url: string;
  init?: RequestInit;
}
const calls: FetchCall[] = [];
type FetchResponder = (url: string, init?: RequestInit) => Promise<Response>;
let responder: FetchResponder = async () => new Response("not implemented", { status: 500 });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  calls.push({ url, init });
  return responder(url, init);
}) as typeof fetch;

function resetFetchLog(): void {
  calls.length = 0;
}
function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}
function bodyOf(init?: RequestInit): Record<string, unknown> {
  return JSON.parse((init?.body as string) ?? "{}");
}
function authHeader(init?: RequestInit): string {
  return ((init?.headers as Record<string, string>) ?? {}).authorization ?? "";
}
// A syntactically-real JWT with the given exp (seconds) so jwtExpMs can read it.
function fakeJwt(expSec: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ exp: Math.floor(expSec) })}.sig`;
}

// ---- Env + imports ---------------------------------------------------------

process.env.PROMPTY_GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.PROMPTY_GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.PROMPTY_RELAY_URL = "https://relay.test";
const RELAY = "https://relay.test";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

const googleAuth = require("../src/main-process/google-auth") as typeof import("../src/main-process/google-auth");
const relay = require("../src/main-process/relay-client") as typeof import("../src/main-process/relay-client");

function freshSession(idToken = "id-fresh") {
  return {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Date.now() + 60 * 60 * 1000,
    sub: "google-sub",
    email: "u@example.com",
    idToken,
  };
}
function staleSession(idToken = "id-old") {
  return { ...freshSession(idToken), expiresAt: Date.now() - 60_000 };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
let failed = 0;
async function run(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name} — ${(e as Error).message}`);
  }
}

async function main() {
  await run("getSessionToken mints the session JWT from a fresh id token", async () => {
    relay.clearSessionCache();
    googleAuth._writeSessionForTests(freshSession("id-fresh"));
    resetFetchLog();
    responder = async (url, init) => {
      if (url === `${RELAY}/auth/google`) {
        assert(bodyOf(init).idToken === "id-fresh", `auth/google idToken was ${bodyOf(init).idToken}`);
        return json({ sessionToken: "jwt-1", userId: "google-sub" });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    };
    const tok = await relay.getSessionToken();
    assert(tok === "jwt-1", `expected jwt-1, got ${tok}`);
    assert(calls.filter((c) => c.url === `${RELAY}/auth/google`).length === 1, "one /auth/google call");
  });

  await run("getDeepgramToken force-refreshes + re-mints + retries once on a 401", async () => {
    relay.clearSessionCache();
    googleAuth._writeSessionForTests(freshSession("id-fresh"));
    resetFetchLog();
    let dgCalls = 0;
    responder = async (url, init) => {
      if (url === GOOGLE_TOKEN) {
        return json({ access_token: "a2", id_token: "id-refreshed", expires_in: 3600, token_type: "Bearer" });
      }
      if (url === `${RELAY}/auth/google`) {
        const which = bodyOf(init).idToken === "id-refreshed" ? "jwt-2" : "jwt-1";
        return json({ sessionToken: which, userId: "google-sub" });
      }
      if (url === `${RELAY}/deepgram/token`) {
        dgCalls++;
        if (dgCalls === 1) {
          assert(authHeader(init) === "Bearer jwt-1", "first mint used jwt-1");
          return new Response("unauthorized", { status: 401 });
        }
        assert(authHeader(init) === "Bearer jwt-2", "retry used the re-minted jwt-2");
        return json({ key: "dg-key", expiresAt: Date.now() + 60 * 60 * 1000 });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    };
    const key = await relay.getDeepgramToken();
    assert(key === "dg-key", `expected dg-key, got ${key}`);
    assert(dgCalls === 2, `expected 2 deepgram calls, got ${dgCalls}`);
    assert(calls.some((c) => c.url === GOOGLE_TOKEN), "force-refreshed the id token on 401");
  });

  await run("a refresh invalid_grant fires the re-auth handler and clears the session", async () => {
    relay.clearSessionCache();
    googleAuth._writeSessionForTests(staleSession("id-old")); // expired → mint forces a refresh
    let reauthReason: string | null = null;
    relay.setReauthHandler((r) => {
      reauthReason = r;
    });
    resetFetchLog();
    responder = async (url) => {
      if (url === GOOGLE_TOKEN) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    };
    const tok = await relay.getSessionToken();
    assert(tok === null, `expected null session, got ${tok}`);
    assert(reauthReason === "invalid_grant", `re-auth handler reason was ${reauthReason}`);
    assert(googleAuth.getSession() === null, "google session file cleared on re-auth");
    relay.setReauthHandler(null);
  });

  await run("a persisted session JWT is reused across relaunch with zero Google/relay I/O", async () => {
    relay.clearSessionCache();
    googleAuth._writeSessionForTests(freshSession("id-fresh"));
    // Mint once — the relay returns a real JWT (far-future exp) that gets persisted.
    const jwt = fakeJwt(Date.now() / 1000 + 30 * 24 * 3600); // +30d
    resetFetchLog();
    responder = async (url) => {
      if (url === `${RELAY}/auth/google`) return json({ sessionToken: jwt, userId: "google-sub" });
      return new Response(`unexpected ${url}`, { status: 500 });
    };
    const first = await relay.getSessionToken();
    assert(first === jwt, "minted the JWT");
    assert(calls.length === 1, `expected 1 mint call, got ${calls.length}`);

    // Simulate relaunch: drop memory, keep the on-disk session.
    relay.__resetSessionMemoryForTests();
    resetFetchLog();
    responder = async () => {
      throw new Error("should not touch the network on a warm relaunch");
    };
    const second = await relay.getSessionToken();
    assert(second === jwt, `expected reused ${jwt}, got ${second}`);
    assert(calls.length === 0, `expected 0 network calls on relaunch, got ${calls.length}`);
  });

  await run("a near-expiry persisted JWT is re-minted once", async () => {
    relay.clearSessionCache();
    googleAuth._writeSessionForTests(freshSession("id-fresh"));
    // Mint a JWT expiring in 1h — inside the 24h re-mint margin — and persist it.
    const stale = fakeJwt(Date.now() / 1000 + 3600);
    responder = async (url) =>
      url === `${RELAY}/auth/google`
        ? json({ sessionToken: stale, userId: "google-sub" })
        : new Response(`unexpected ${url}`, { status: 500 });
    await relay.getSessionToken();

    // Relaunch: disk holds the near-expiry JWT, so the next fetch must re-mint.
    relay.__resetSessionMemoryForTests();
    const fresh = fakeJwt(Date.now() / 1000 + 30 * 24 * 3600);
    resetFetchLog();
    responder = async (url) =>
      url === `${RELAY}/auth/google`
        ? json({ sessionToken: fresh, userId: "google-sub" })
        : new Response(`unexpected ${url}`, { status: 500 });
    const tok = await relay.getSessionToken();
    assert(tok === fresh, `expected re-minted ${fresh}, got ${tok}`);
    assert(calls.filter((c) => c.url === `${RELAY}/auth/google`).length === 1, "re-minted exactly once");
  });

  if (failed > 0) {
    console.error(`\n${failed} case(s) failed`);
    process.exit(1);
  }
  console.log("\nall relay-auth cases passed");
  globalThis.fetch = realFetch;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
