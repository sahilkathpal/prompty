// Smoke test for Google ID token validation.
//
// Generates an RSA keypair, exposes it as a JWK set, signs a Google-shaped
// JWT, and runs it through verifyGoogleIdentityTokenWithJwks (the test seam).
// Then asserts rejection cases.

import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  type JWK,
  type KeyLike,
} from "jose";
import { verifyGoogleIdentityTokenWithJwks } from "../src/auth";

const AUD = "test-client-id.apps.googleusercontent.com";
const KID = "test-kid-1";

interface Case {
  name: string;
  build: () => Promise<string>;
  audience?: string;
  expectFail?: string | RegExp;
}

async function buildJwt(opts: {
  privateKey: KeyLike;
  aud?: string;
  iss?: string;
  exp?: number;
  emailVerified?: boolean | string;
  sub?: string;
  kid?: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    email: "alice@example.com",
    email_verified: opts.emailVerified ?? true,
  })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? KID })
    .setSubject(opts.sub ?? "google-sub-12345")
    .setIssuedAt(now)
    .setIssuer(opts.iss ?? "https://accounts.google.com")
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime(opts.exp ?? now + 3600)
    .sign(opts.privateKey);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const jwks = { keys: [publicJwk] };

  const cases: Case[] = [
    {
      name: "accepts valid Google ID token",
      build: () => buildJwt({ privateKey }),
    },
    {
      name: "rejects bad audience",
      build: () => buildJwt({ privateKey, aud: "evil-client-id" }),
      expectFail: /aud/i,
    },
    {
      name: "rejects expired token",
      build: () =>
        buildJwt({
          privateKey,
          exp: Math.floor(Date.now() / 1000) - 60,
        }),
      expectFail: /exp/i,
    },
    {
      name: "rejects wrong issuer",
      build: () =>
        buildJwt({ privateKey, iss: "https://evil.example.com" }),
      expectFail: /iss/i,
    },
    {
      name: "rejects unverified email",
      build: () => buildJwt({ privateKey, emailVerified: false }),
      expectFail: /verified/i,
    },
    {
      name: "rejects unknown kid",
      build: () => buildJwt({ privateKey, kid: "unknown-kid" }),
      expectFail: /matching kid/i,
    },
    {
      name: "accepts iss without https prefix (accounts.google.com)",
      build: () =>
        buildJwt({ privateKey, iss: "accounts.google.com" }),
    },
    {
      name: "accepts email_verified='true' string",
      build: () => buildJwt({ privateKey, emailVerified: "true" }),
    },
  ];

  let failed = 0;
  for (const c of cases) {
    try {
      const jwt = await c.build();
      let claims;
      let err: Error | null = null;
      try {
        claims = await verifyGoogleIdentityTokenWithJwks(jwt, AUD, jwks);
      } catch (e) {
        err = e as Error;
      }
      if (c.expectFail) {
        if (!err) {
          throw new Error("expected failure but verification succeeded");
        }
        if (typeof c.expectFail === "string" && !err.message.includes(c.expectFail)) {
          throw new Error(`expected error to contain "${c.expectFail}", got: ${err.message}`);
        }
        if (c.expectFail instanceof RegExp && !c.expectFail.test(err.message)) {
          throw new Error(`expected error to match ${c.expectFail}, got: ${err.message}`);
        }
      } else {
        if (err) throw err;
        assert(claims?.sub, "claims has sub");
      }
      console.log(`  PASS  ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL  ${c.name} — ${(e as Error).message}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} case(s) failed`);
    process.exit(1);
  }
  console.log("\nall google-jwt cases passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
