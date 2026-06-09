// Smoke test for Google token refresh + 401 retry behavior.
//
// google-auth and google-calendar both import 'electron'. To avoid pulling
// Electron in, we shim it via Module._resolveFilename before importing the
// modules under test. Token refresh + calendar 401 retry both go through
// globalThis.fetch — we patch that with a programmable shim.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import Module from "node:module";

// ---- Electron shim ---------------------------------------------------------

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), "prompty-google-test-"));

const electronShim = {
  app: {
    getPath: (_name: string) => tmpUserData,
    isPackaged: false,
  },
  BrowserWindow: class {},
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
let responder: FetchResponder = async () =>
  new Response("not implemented", { status: 500 });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input.toString();
  calls.push({ url, init });
  return responder(url, init);
}) as typeof fetch;

function resetFetchLog(): void {
  calls.length = 0;
}

// ---- Dynamic imports ------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-var-requires
const googleAuth = require("../src/main-process/google-auth") as typeof import("../src/main-process/google-auth");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const googleCalendar = require("../src/main-process/google-calendar") as typeof import("../src/main-process/google-calendar");

// Exercise the direct-to-Google token path (dev escape hatch): with both env
// vars set, exchange/refresh hit oauth2.googleapis.com directly rather than
// being brokered by the relay.
process.env.PROMPTY_GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.PROMPTY_GOOGLE_CLIENT_SECRET = "test-client-secret";

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
  await run("getAccessToken refreshes when stale", async () => {
    // Seed a stale session.
    googleAuth._writeSessionForTests({
      accessToken: "stale-access",
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 60_000, // expired
      sub: "google-sub",
      email: "u@example.com",
      idToken: "id-token",
    });

    resetFetchLog();
    responder = async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(
          JSON.stringify({
            access_token: "fresh-access",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    };

    const tok = await googleAuth.getAccessToken();
    assert(tok === "fresh-access", `expected fresh-access, got ${tok}`);
    assert(calls.length === 1, `expected 1 call, got ${calls.length}`);
    assert(
      calls[0].url === "https://oauth2.googleapis.com/token",
      "expected token endpoint call",
    );
    const body = (calls[0].init?.body as string) ?? "";
    assert(body.includes("grant_type=refresh_token"), "body contains grant_type=refresh_token");
    assert(body.includes("refresh_token=refresh-1"), "body contains refresh token");
  });

  await run("getAccessToken returns cached token when fresh", async () => {
    googleAuth._writeSessionForTests({
      accessToken: "still-fresh",
      refreshToken: "refresh-2",
      expiresAt: Date.now() + 60 * 60 * 1000,
      sub: "google-sub",
      email: "u@example.com",
      idToken: "id-token",
    });

    resetFetchLog();
    responder = async () => {
      throw new Error("should not have called fetch");
    };

    const tok = await googleAuth.getAccessToken();
    assert(tok === "still-fresh", `expected still-fresh, got ${tok}`);
    assert(calls.length === 0, `expected 0 calls, got ${calls.length}`);
  });

  await run("calendar list retries on 401 with refreshed token", async () => {
    googleAuth._writeSessionForTests({
      accessToken: "good-access",
      refreshToken: "refresh-3",
      expiresAt: Date.now() + 60 * 60 * 1000, // not stale
      sub: "google-sub",
      email: "u@example.com",
      idToken: "id-token",
    });

    resetFetchLog();
    let calendarCalls = 0;
    responder = async (url, init) => {
      if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) {
        calendarCalls++;
        const auth = (init?.headers as Record<string, string> | undefined)?.["authorization"]
          ?? (init?.headers as Record<string, string> | undefined)?.["Authorization"];
        if (auth === "Bearer good-access") {
          return new Response("unauthorized", { status: 401 });
        }
        if (auth === "Bearer refreshed-access") {
          return new Response(
            JSON.stringify({ items: [{ id: "ev1", summary: "hello" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("wrong bearer", { status: 500 });
      }
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(
          JSON.stringify({ access_token: "refreshed-access", expires_in: 3600, token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    };

    const events = await googleCalendar.listUpcomingEvents(15);
    assert(events.length === 1, `expected 1 event, got ${events.length}`);
    assert(events[0].id === "ev1", `expected ev1, got ${events[0].id}`);
    assert(calendarCalls === 2, `expected 2 calendar calls, got ${calendarCalls}`);
  });

  if (failed > 0) {
    console.error(`\n${failed} case(s) failed`);
    process.exit(1);
  }
  console.log("\nall google-token-refresh cases passed");

  // restore
  globalThis.fetch = realFetch;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
