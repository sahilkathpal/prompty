# Ruby Relay Backend — Design Doc

> **Superseded by `RUBY_AUTH_RELAY_PLAN.md`**, which folds in the client side and
> grounds the plan in the working `mac-app` implementation (live relay at
> `prompty-relay.sahil-847.workers.dev`). Keep this doc for the architectural
> rationale; use the plan for execution.


Companion to `RUBY_ISSUES_PLAN.md` §2. Designs the backend that lets Ruby stop
shipping a shared Deepgram key. Scope here is the **server side**; the Electron
client work lives in the implementation plan.

> Storage choices below (D1 + KV) are an assumption to confirm against the
> Cloudflare Worker you already have.

---

## Problem

The alpha ships a shared `DEEPGRAM_API_KEY` in `.env`. At launch we can't hand
our permanent key to users. We need to:
1. Identify the user (Google sign-in).
2. Authorize them to transcribe.
3. Give the client a credential to reach Deepgram **without** exposing a
   long-lived secret.

Claude is **not** in scope — the app uses each user's own local `claude` CLI.

---

## Architecture: token-minting (not an audio relay)

The Worker mints a **short-lived, scoped Deepgram key** per call. The client
connects **directly** to `wss://api.deepgram.com` with that ephemeral key.

**Why not proxy the audio through us:** an audio relay would add a latency hop,
cost us bandwidth, and require scaling WebSocket fan-out. Token-minting keeps
today's direct-to-Deepgram path (low latency, zero audio bandwidth on us) and
the Worker stays stateless and trivial to scale. This is the "old relay
token-minting path" the codebase comment refers to, rebuilt cleanly.

```
Electron app ──(Google id_token)──▶ Worker /auth/google ──▶ verify, allowlist
     │                                                         │
     │◀──────────── session JWT ───────────────────────────────
     │
     │──(session JWT)──▶ Worker /deepgram/token ──▶ Deepgram API: create
     │                                              temp key (TTL, scoped)
     │◀──── { key, expires_at } ──────────────────
     │
     └──(ephemeral key)──▶ wss://api.deepgram.com/v1/listen   (audio direct)
```

---

## Endpoints

### `POST /auth/google`
- **In:** `{ id_token }` (Google ID token from the client OAuth/PKCE flow).
- **Server:** verify signature/issuer/audience against Google's JWKS; extract
  `sub`, `email`, `name`, `picture`. Check `email` against the **allowlist**
  (D1). Upsert the user row.
- **Out:** `{ session_jwt, user: { email, name, picture } }`.
- **Errors:** `401` invalid token; `403` not on allowlist.

### `POST /deepgram/token`
- **Auth:** `Authorization: Bearer <session_jwt>`.
- **Server:** verify the session JWT; confirm the user is still allowed; call
  the **Deepgram API** to create a temporary key with a short TTL and minimal
  scope (`usage:write` for streaming). Optional: per-user/short-window rate
  limit via KV to cap abuse.
- **Out:** `{ key, expires_at }`.
- **Errors:** `401` invalid/expired session; `403` revoked; `429` rate-limited.

### `POST /auth/refresh` (optional)
- Exchange a still-valid session for a fresh JWT so users don't re-OAuth often.
- Alternatively keep sessions long-lived and rely on the allowlist check at
  mint time for revocation.

---

## Session model

- **Session JWT**, signed by the Worker (HS256 with a secret in Worker env, or
  EdDSA). Claims: `sub` (user id), `email`, `iat`, `exp` (e.g. 30 days).
- Stored client-side in the **macOS Keychain**.
- **Revocation:** since `/deepgram/token` re-checks the D1 allowlist on every
  mint, removing a user from the allowlist stops new keys immediately (bounded
  by the current ephemeral key's TTL). Keep ephemeral TTL short to tighten this.

---

## Deepgram ephemeral keys

- Use Deepgram's temporary/short-lived API key creation (member key with
  `time_to_live_in_seconds` and scoped permissions) — **confirm exact API +
  field names against current Deepgram docs** during implementation.
- **TTL:** cover one call comfortably (e.g. 2–4h) but no longer; the client
  mints per call start, so a tight TTL limits blast radius if a key leaks.
- Our permanent Deepgram key lives **only** in Worker env (secret), never on the
  client.
- **Metering:** Deepgram usage is attributable per ephemeral key; tag/label
  keys with the user id for per-user accounting if Deepgram supports it.

---

## Storage (Cloudflare-native — confirm)

- **D1** — `users` (allowlist + identity): `id`, `email` (unique), `name`,
  `picture`, `created_at`, `allowed` (bool), `last_seen`.
- **KV** — short-lived state: OAuth nonce/PKCE verifiers (if server-assisted),
  per-user rate-limit counters with TTL. No long-term data.
- No audio, no transcripts ever touch the backend.

---

## Worker config / secrets

- Secrets (Worker env): `DEEPGRAM_API_KEY` (permanent), `SESSION_JWT_SECRET`,
  `GOOGLE_OAUTH_CLIENT_ID` (+ client secret only if using a confidential flow).
- Bindings: D1 database, KV namespace.
- Prefer a **public PKCE** client for the desktop app (no client secret on the
  device); the Worker verifies the resulting Google ID token.

---

## Security notes

- Verify Google ID token `aud` matches our client id; reject otherwise.
- Rate-limit `/deepgram/token` per user (KV) to bound cost if a session leaks.
- Short ephemeral TTLs + allowlist re-check at mint = practical revocation
  without per-request DB writes on the hot path.
- CORS: lock to the app's origin/custom scheme; this isn't a public web API.

---

## Open questions to confirm

1. D1 + KV against the existing Worker, or different storage already in place?
2. Exact Deepgram temporary-key API shape + max TTL on our plan.
3. Session lifetime + whether to implement `/auth/refresh` now or later.
4. Allowlist management: manual D1 rows for launch, or an admin path?
5. Per-user metering granularity needed at launch.
