# prompty-relay

Cloudflare Worker that brokers auth + Deepgram keys for the Prompty Mac app.

## Endpoints

- `GET /health` → `{ ok, ts }`
- `POST /auth/apple` — body `{ identityToken }`; verifies Apple identity JWT
  against Apple's JWKS (RS256, `iss=https://appleid.apple.com`,
  `aud=APPLE_BUNDLE_ID`, not expired). Returns `{ sessionToken, userId }`
  (Prompty session JWT, HS256, 30-day TTL).
- `POST /deepgram/token` — header `Authorization: Bearer <sessionToken>`.
  Verifies session, checks the per-user daily counter
  (`user:<sub>:minutes:<YYYY-MM-DD>` in `RATE_LIMITS` KV), and if under the
  limit calls Deepgram's key-creation API to mint a 1-hour `usage:write` key.
  Returns `{ key, expiresAt }`. Bumps the counter by 60 minutes.

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
# Your iOS/macOS bundle identifier (Apple identity token `aud` claim).
npx wrangler secret put APPLE_BUNDLE_ID            # e.g. com.prompty.app

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
APPLE_BUNDLE_ID=com.prompty.app
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
