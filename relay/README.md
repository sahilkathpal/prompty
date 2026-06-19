# prompty-relay

Cloudflare Worker that brokers auth + Deepgram keys for the Prompty Mac app.

## Endpoints

- `GET /health` → `{ ok, ts }`
- `POST /auth/google` — body `{ idToken }`; verifies a Google ID token against
  Google's JWKS (RS256, `iss=accounts.google.com`, `aud=GOOGLE_CLIENT_ID`,
  `email_verified`). Returns `{ sessionToken, userId }` (Prompty session JWT,
  HS256, 30-day TTL).
- `GET /auth/google/client-id` → `{ clientId }`. The public OAuth client ID,
  served so the desktop app can build the authorize URL without bundling it.
- `POST /auth/google/exchange` — body `{ code, codeVerifier, redirectUri }`.
  Brokers the PKCE authorization-code exchange with Google (attaching
  `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` server-side) and returns Google's
  token response (`access_token`, `refresh_token`, `id_token`, `expires_in`).
- `POST /auth/google/refresh` — body `{ refreshToken }`. Brokers the
  refresh-token grant the same way and returns the refreshed token response.
  Both broker endpoints keep the client secret off the client entirely.
- `POST /deepgram/token` — header `Authorization: Bearer <sessionToken>`.
  Verifies session, rejects a revoked `sub` (403), checks the per-user daily
  **mint** counter (`mints:<sub>:<YYYY-MM-DD>` in `RATE_LIMITS` KV), and if under
  `DAILY_MINT_LIMIT` (default 50) calls Deepgram's key-creation API to mint a
  1-hour `usage:write` key. Returns `{ key, expiresAt }`. Bumps the counter by 1
  (one mint = one ephemeral key; a continuous call runs on one key regardless of
  length, so this meters usage windows, not minutes). Over the cap → 429.

## Gating & revocation

Gating is **open**: any `email_verified` Google account gets a session.
Abuse is bounded by the mint cap and a revocation **denylist** keyed by Google
`sub` in the `SESSIONS` KV namespace — checked on both `/auth/google` (no fresh
session) and `/deepgram/token` (no fresh key, bites within one key TTL ≤1h).
Revoke a user with:

```bash
npx wrangler kv key put --binding=SESSIONS "revoked:<sub>" 1
```

## Local tests

```bash
npm run test            # offline: typecheck + google-jwt + mint/revocation units
npm run dev             # wrangler dev (needs .dev.vars; dummy values OK for smoke)
BASE_URL=http://localhost:8787 npm run smoke        # health + error paths
BASE_URL=http://localhost:8787 npm run smoke:gates  # end-to-end 403 / 429 / pass
```

## Setup

```bash
cd relay
npm install
```

### 1. Create KV namespaces

```bash
npx wrangler kv namespace create APPLE_JWKS_CACHE
npx wrangler kv namespace create APPLE_JWKS_CACHE --preview

npx wrangler kv namespace create RATE_LIMITS
npx wrangler kv namespace create RATE_LIMITS --preview

npx wrangler kv namespace create SESSIONS
npx wrangler kv namespace create SESSIONS --preview
```

Paste the resulting IDs into `wrangler.toml` (the `REPLACE_ME_*` placeholders).

### 2. Set secrets

```bash
# Google OAuth desktop client. The ID is served at /auth/google/client-id and
# the secret is used only server-side to broker the token exchange/refresh, so
# neither ships in the app bundle.
npx wrangler secret put GOOGLE_CLIENT_ID           # ...apps.googleusercontent.com
npx wrangler secret put GOOGLE_CLIENT_SECRET       # GOCSPX-...

# Random 32+ byte string for signing Prompty session JWTs (HS256).
#   openssl rand -base64 48 | tr -d '\n' | pbcopy
npx wrangler secret put PROMPTY_JWT_SECRET

# Deepgram admin/master API key (has key-creation rights on the project).
npx wrangler secret put DEEPGRAM_MASTER_KEY

# Deepgram project UUID to mint keys under.
npx wrangler secret put DEEPGRAM_PROJECT_ID
```

For local dev, mirror the same names into `.dev.vars` (gitignored):

```ini
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
PROMPTY_JWT_SECRET=dev-secret-do-not-ship
DEEPGRAM_MASTER_KEY=dg-...
DEEPGRAM_PROJECT_ID=...
```

### 3. Run locally

```bash
npx wrangler dev
# in another shell
curl http://localhost:8787/health
# → {"ok":true,"ts":...}

BASE_URL=http://localhost:8787 npm run smoke
```

### 4. Deploy (manual — not automated)

```bash
npx wrangler deploy
```

## Notes

- Apple JWKS is cached in KV under a single key `apple_jwks` with a 24h TTL.
  On a `kid` cache miss the cache is busted and refetched once.
- Session tokens are stateless JWTs (HS256, 30-day exp, `iss=prompty-relay`).
  The `SESSIONS` KV namespace is reserved for future revocation but currently
  unused.
- Rate-limit semantics: every successful `/deepgram/token` response charges
  the caller 60 minutes against a per-UTC-day bucket; further requests are
  rejected with 429 once usage hits `DAILY_MINUTES_LIMIT` (default 120). KV
  is not atomic — concurrent requests may over-count, which is intentional.
