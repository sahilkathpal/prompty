# Ruby — Google Sign-in + Deepgram Token Relay (Standalone Plan)

Self-contained plan for issue #2 ("wire in google sign in"). Supersedes the
backend-only `RUBY_RELAY_BACKEND_DESIGN.md` by folding the client side in and
grounding everything in the **prior, working implementation on the `mac-app`
branch**.

## Goal

Stop shipping a shared `DEEPGRAM_API_KEY` in `.env`. Users sign in with Google;
a Cloudflare Worker brokers identity and mints **short-lived Deepgram keys**;
the client connects **directly** to Deepgram with the ephemeral key (today's
low-latency path preserved — no audio proxied through us).

## What already exists (reuse, don't reinvent)

A complete implementation lives on `mac-app`. It is the right architecture and
should be **ported to `ruby-rebuild` with the fixes in "Rethink" below.**

### Live Cloudflare resources (account `sahil-847`)
- **Worker:** `prompty-relay` at `https://prompty-relay.sahil-847.workers.dev`
- **KV namespaces (already created, real IDs in `mac-app:relay/wrangler.toml`):**
  `GOOGLE_JWKS_CACHE`, `RATE_LIMITS`, `SESSIONS`
- **Secrets (set via `wrangler secret put`, held by you — not in git):**
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PROMPTY_JWT_SECRET`,
  `DEEPGRAM_MASTER_KEY`, `DEEPGRAM_PROJECT_ID`
- **Vars:** `DAILY_MINUTES_LIMIT = 6000`

### Relay Worker (`mac-app:relay/`, Hono + TypeScript)
- `src/index.ts` — routes: `/health`, `/auth/google`, `/auth/google/client-id`,
  `/auth/google/exchange`, `/auth/google/refresh`, `/deepgram/token`
- `src/auth.ts` — verifies Google ID token (RS256, `iss=accounts.google.com`,
  `aud=GOOGLE_CLIENT_ID`, `email_verified`); JWKS cached in KV
- `src/google-oauth.ts` — brokers PKCE exchange + refresh (attaches client
  secret server-side)
- `src/deepgram.ts` — `POST /v1/projects/{id}/keys`, `scopes:["usage:write"]`,
  `time_to_live_in_seconds: 3600`, `Authorization: Token <master>`
- `src/jwt.ts` — HS256 session JWT, 30-day TTL, `iss=prompty-relay`
- `src/rate-limit.ts` — per-user per-UTC-day minute counter in `RATE_LIMITS` KV
- `wrangler.toml`, `README.md` (full setup), `test/smoke*.ts`

### Client glue (`mac-app:app/src/main-process/`)
- `relay-config.ts` — base URL (`PROMPTY_RELAY_URL` env override)
- `google-auth.ts` — Electron installed-app **PKCE** flow: loopback
  `http://localhost:<port>/callback`, `safeStorage`-encrypted session at
  `userData/google-session.bin`, relay-brokered exchange/refresh, dev escape
  hatches (`PROMPTY_GOOGLE_CLIENT_ID/SECRET`)
- `relay-client.ts` — Google ID token → relay session JWT (`/auth/google`),
  caches it, mints/caches Deepgram keys (`/deepgram/token`)
- Integration: `coach-session.ts` did
  `const deepgramKey = usingMockDeepgram ? "mock" : await getDeepgramToken();`
- IPC: `auth:google-sign-in`, `auth:sign-out`, `auth:status`,
  `auth:state-changed` broadcast; preflight gated on `signedIn`

## Rethink (decisions — RESOLVED)

The `mac-app` build works but had gaps for launch. Decisions:

1. **Gating → OPEN (decided).** No allowlist. `/auth/google` issues a session to
   any `email_verified` Google account. Abuse is bounded by revocation (#2) and
   the mint cap (#5), not by an allowlist.
2. **Revocation → denylist in `SESSIONS` KV (decided).** Store `revoked:<sub>`
   keyed by Google `sub`. Check it:
   - in `/deepgram/token` after session verify (hot path → revocation bites
     within one key TTL, ≤1h; ~1 KV read/user/hour), and
   - in `/auth/google` (so a revoked user can't mint a fresh session JWT).
   Revoke for launch via `wrangler kv key put --binding=SESSIONS revoked:<sub> 1`.
   Optional later: an admin-secret-protected `POST /admin/revoke`.
3. **Metering → count MINTS, not minutes (decided).** The current code charges
   the budget by key issuance (`incrementMinutes(sub, 60)` per mint), so a
   1-second call costs 60 minutes. **Fix:** replace the per-day *minutes*
   counter with a per-day *mint* counter — `+1` per successful
   `/deepgram/token`, reject with 429 once it exceeds `DAILY_MINT_LIMIT`.
   - 1-second call = 1 mint (was 60 min). The client caches/reuses the key for
     ~1h, so multiple short calls in an hour = 1 mint.
   - Honest + server-side (no reliance on a client-reported duration, which an
     open system can't trust). Hard bound = `DAILY_MINT_LIMIT × 1h TTL`.
   - **`DAILY_MINT_LIMIT = 50/day` (decided).** A continuous call = **1 mint
     regardless of length** (the stream survives key expiry); mints accrue from
     new call sessions + post-1h reconnects + cold-cache app relaunches. 50
     comfortably covers a heavy real day (12–20 calls + reconnects) while still
     bounding a single account to 50 ephemeral keys/day. It's a coarse runaway
     guard, not billing.
   - KV non-atomicity (±1 miscount under concurrency) is irrelevant at this cap.
   - **Persist the client key cache (decided — see Phase B 2b)** so app relaunches
     within a key's window don't each re-mint.
   - Optional, deferred: client `POST /usage {minutes}` at call end for accurate
     cost *analytics* — kept OUT of the enforcement path.
4. **Calendar scope → DROP (decided).** `SCOPES = openid email profile` only.
   Remove `calendar.readonly` from `google-auth.ts`.
5. **Branding → keep as-is (decided).** Worker name/domain
   (`prompty-relay.sahil-847.workers.dev`), `iss=prompty-relay`, secret names,
   `google-session.bin` all unchanged — mirrors the app's frozen `appId`.
   A domain rebrand, if ever, is a separate migration.

## Architecture (confirmed)

```
Electron ──PKCE authorize (system BrowserWindow)──▶ Google
   │   loopback callback captures code
   │──{code,verifier,redirectUri}──▶ relay /auth/google/exchange ──▶ Google (secret attached)
   │◀── {access,refresh,id_token} ── (stored, safeStorage-encrypted)
   │──{idToken}──▶ relay /auth/google ──▶ verify JWKS, [allowlist], sign session JWT
   │◀── {sessionToken, userId} ──
   │──Bearer sessionToken──▶ relay /deepgram/token ──▶ [revocation] + rate-limit + mint 1h key
   │◀── {key, expiresAt} ──
   └──ephemeral key──▶ wss://api.deepgram.com   (audio direct, unchanged)
```

The client secret never ships in the bundle; the Deepgram master key never
leaves the Worker; audio never touches the Worker.

## Execution

### Phase A — Relay (Cloudflare Worker)
1. Copy `mac-app:relay/` into the repo (own top-level `relay/`). Keep
   `wrangler.toml` KV IDs (namespaces already exist).
2. Apply decisions:
   - **Revocation (#2):** add `isRevoked(sub)` (read `revoked:<sub>` from
     `SESSIONS` KV); call it in `/deepgram/token` and `/auth/google` → 403.
   - **Metering (#3):** rewrite `rate-limit.ts` from minutes→mints — a per-UTC-day
     `mints:<sub>:<YYYY-MM-DD>` counter, `+1` per successful mint, reject 429
     over `DAILY_MINT_LIMIT`. Replace the `incrementMinutes(60)` call. Swap the
     `DAILY_MINUTES_LIMIT=6000` var for `DAILY_MINT_LIMIT=50`.
   - Keep gating open (#1); no allowlist code.
3. Restore secrets locally in `relay/.dev.vars` (gitignored) from your held
   values; confirm Cloudflare secrets still set (`wrangler secret list`).
4. `wrangler dev` + `BASE_URL=… npm run smoke`; then `wrangler deploy`.
5. Verify `GET /health`, an end-to-end mint, a 429 past the mint cap, and a 403
   for a revoked `sub`.

### Phase B — Client (Electron, on `ruby-rebuild`)
1. Port `relay-config.ts`, `google-auth.ts`, `relay-client.ts` from `mac-app`
   into `app/src/main-process/`. **Drop Calendar scope (#4):**
   `SCOPES = "openid email profile"`.
2. Switch `coach-session.ts` `resolveDeepgramKey()` →
   `usingMockDeepgram ? "mock" : await getDeepgramToken()`. Keep
   `PROMPTY_MOCK_DEEPGRAM` and a dev `.env` `DEEPGRAM_API_KEY` fallback for
   local/E2E (gate the relay call behind "no local key in dev").
2a. **Re-key on reconnect (NOT in `mac-app` — required).** Per Deepgram docs the
   key TTL maxes at **3600 s** and is only checked at the *initial* WebSocket
   connect — an established stream stays open past key expiry until closed. So a
   continuous call of any length runs on one key (one mint). The only failure
   case: the socket drops (network blip / Deepgram idle-timeout 1011) **>1h into
   a call** and the reconnect re-auths with the now-expired static key (what
   `mac-app` does — it captures the key once and reuses it on reconnect). Fix:
   - Change `deepgram.ts` to take `getKey: () => Promise<string>` instead of a
     static `deepgramKey`; call it on every `connect()`. `getDeepgramToken()`
     re-mints only when the cached key is expired/near-expiry, so reconnects
     within the hour reuse the key (no extra mints); a reconnect past the hour
     gets a fresh one.
   - **No proactive refresh timer** — the live socket survives key expiry;
     cycling it early would *create* a gap. Re-key only on reconnect.
   - Keep TTL at the max 3600 s in `relay/src/deepgram.ts` (can't go higher).
2b. **Persist the key cache (NOT in `mac-app` — required).** `mac-app` keeps the
   minted key only in an in-memory `cachedDeepgramKey`, so quit+relaunch starts
   cold and every relaunched call re-mints — N app restarts = N mints even
   inside one key's window. Fix: persist `{ key, expiresAt }` encrypted via
   `safeStorage` to `userData/deepgram-key.bin` (same pattern as
   `google-session.bin`). On `getDeepgramToken()`: load from disk if the
   in-memory cache is empty; reuse when `expiresAt - now > 10 min`; write back on
   each fresh mint. Net: relaunches within a key's ~50-min window reuse it (no
   extra mints), so the cap reflects real usage windows, not restart count.
   Clear it on sign-out alongside `clearSessionCache()`.
3. IPC handlers: `auth:google-sign-in`, `auth:sign-out`, `auth:status`, +
   `auth:state-changed` broadcast (port from `mac-app:ipc-handlers.ts`).
   Add the channels to `src/shared/ipc.ts`.
4. Preflight: gate session start on signed-in (mirror `mac-app` preflight
   `auth` message); allow E2E/mock bypass.
5. Onboarding: wire the real flow into `StepSignin`
   (`onboarding/App.tsx:343-349`, currently mocked) → `auth:google-sign-in`.
   Block `onboarding:complete` until signed in (except mock/E2E).
6. Settings: show signed-in identity + Sign out.

### Phase C — Verify
- Unit/smoke: port `smoke-google-token-refresh.ts`; relay `smoke.ts` +
  `smoke-google-jwt.ts`.
- E2E: drive sign-in via a mock seam (inject a session with
  `_writeSessionForTests`) so the suite runs without real Google; assert
  preflight gating (signed-out blocks start; signed-in allows).
- Manual: real Google sign-in → start a call → confirm transcription on a
  minted key; sign out → confirm start is blocked.

## Google Cloud setup (confirm against existing project)
- OAuth client type: **Desktop app** (installed-app PKCE; loopback redirect).
- Authorized redirect: loopback `http://localhost` (ephemeral port) — desktop
  clients allow any loopback port.
- Consent screen scopes: `openid`, `email`, `profile` (+ `calendar.readonly`
  only if keeping #4). Publish status / test users as needed for the allowlist.

## Open questions (remaining)
All "rethink" decisions resolved. Settled numbers: `DAILY_MINT_LIMIT = 50`,
key TTL = 3600 s (max), key cache persisted to disk. Deferred (revisit later,
not blocking):
1. **Admin revoke endpoint** (`POST /admin/revoke`) — deferred; use the
   `wrangler kv` one-liner for launch.
2. Client `POST /usage` cost analytics — deferred; out of the enforcement path.
```
