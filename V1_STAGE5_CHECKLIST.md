# Stage 5 — Relay Deploy + Production Cutover

Walkable checklist. Total time ~30–45 min if no surprises. You drive each command; I verify the result before moving to the next step.

Anywhere you see `<...>` you fill in. Anywhere you see `# verify` is a step I'll run to confirm before we continue.

---

## Prerequisites (10 min)

You need accounts and basic CLIs in place before we touch any code.

### 0.1 Accounts

- [ ] **Cloudflare** — free tier is enough (Workers + KV included). Sign up at cloudflare.com if you don't have one.
- [ ] **Google Cloud** — free tier is fine. console.cloud.google.com.
- [ ] **Deepgram** — sign up at console.deepgram.com if not already done. They give $200 free credit; we'll burn cents.

### 0.2 CLIs

- [ ] `wrangler --version` returns a version. (Already in `relay/package.json` devDeps, so `npx wrangler` works from inside `relay/`.) For convenience: `npm install -g wrangler` if you want it on PATH.
- [ ] `gcloud --version` — optional, only needed if you want to generate a real Google ID token from the CLI for testing. Not strictly required.

---

## Part A — Google OAuth client (5 min)

### A.1 Enable Calendar API
1. Go to https://console.cloud.google.com.
2. Top bar → project selector → **New Project** (or pick an existing one). Name: `prompty` (or anything).
3. Left nav → **APIs & Services** → **Library** → search **Google Calendar API** → **Enable**.

### A.2 Configure OAuth consent screen
1. Left nav → **APIs & Services** → **OAuth consent screen**.
2. User type: **External**. Create.
3. App name: `Prompty`. User support email: your email. Developer email: same.
4. Save and continue.
5. Scopes → **Add or remove scopes** → search and add:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `https://www.googleapis.com/auth/calendar.readonly`
6. Save and continue.
7. Test users → **Add users** → add your email (sahil@revise.network). Save.

> Note: while the app is in "Testing" mode, only test-listed users can sign in. That's fine for v1 — you. We can publish later.

### A.3 Create OAuth client
1. Left nav → **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**.
2. Application type: **Desktop app**. Name: `Prompty Desktop`.
3. Create.
4. Copy the **Client ID** — looks like `123456789-xxxx.apps.googleusercontent.com`.
5. (Desktop apps don't need a client secret for the Electron PKCE flow — but Google still issues one. Ignore it.)

**Save this somewhere:**
```
GOOGLE_CLIENT_ID=<paste>
```

# verify: I'll check the format looks right.

---

## Part B — Deepgram (3 min)

### B.1 Get master API key
1. https://console.deepgram.com → **API Keys** in left nav.
2. **Create a New API Key** → name `prompty-relay-master`. Scope: `member` (default works). TTL: leave blank / no expiry.
3. Copy the key. Starts with letters/numbers, ~40 chars.

**Save:**
```
DEEPGRAM_MASTER_KEY=<paste>
```

### B.2 Get project ID
1. Same page, top-right → **Settings** → **Project**. Project ID is a UUID.
2. Copy.

**Save:**
```
DEEPGRAM_PROJECT_ID=<paste>
```

# verify: format checks.

---

## Part C — Cloudflare Worker (10 min)

We deploy to `*.workers.dev` for v1 — no custom domain.

### C.1 Authenticate wrangler
```bash
cd /Users/sahilkathpal/code/prompty/relay
npx wrangler login
```
Opens a browser; you click Allow. Returns to terminal with success.

# verify: `npx wrangler whoami` shows your Cloudflare account email.

### C.2 Create KV namespaces
Three namespaces — capture the IDs from each command.

```bash
npx wrangler kv namespace create GOOGLE_JWKS_CACHE
npx wrangler kv namespace create GOOGLE_JWKS_CACHE --preview
npx wrangler kv namespace create RATE_LIMITS
npx wrangler kv namespace create RATE_LIMITS --preview
npx wrangler kv namespace create SESSIONS
npx wrangler kv namespace create SESSIONS --preview
```

Each prints something like:
```
🌀 Creating namespace with title "prompty-relay-GOOGLE_JWKS_CACHE"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "GOOGLE_JWKS_CACHE", id = "abc123def456..." }
```

Copy each id (and each preview id) — six values total.

### C.3 Update wrangler.toml
Replace the six `REPLACE_ME_*` placeholders in `relay/wrangler.toml` with the IDs from C.2. I can do this for you in one shot if you paste the IDs.

# verify: I'll grep for any remaining `REPLACE_ME` in the file.

### C.4 Set Worker secrets
```bash
cd /Users/sahilkathpal/code/prompty/relay

npx wrangler secret put GOOGLE_CLIENT_ID
# paste GOOGLE_CLIENT_ID from A.3, press Enter

npx wrangler secret put DEEPGRAM_MASTER_KEY
# paste DEEPGRAM_MASTER_KEY from B.1

npx wrangler secret put DEEPGRAM_PROJECT_ID
# paste DEEPGRAM_PROJECT_ID from B.2

# Generate a long random secret for signing Prompty session JWTs:
openssl rand -base64 64 | tr -d '\n'
# copy that string, then:
npx wrangler secret put PROMPTY_JWT_SECRET
# paste it
```

# verify: `npx wrangler secret list` shows 4 entries.

### C.5 Deploy
```bash
cd /Users/sahilkathpal/code/prompty/relay
npx wrangler deploy
```

Output ends with:
```
Published prompty-relay (X sec)
  https://prompty-relay.<your-account-subdomain>.workers.dev
```

**Save the deployed URL:**
```
PROMPTY_RELAY_URL=<the workers.dev URL>
```

# verify: `curl https://prompty-relay.<...>.workers.dev/health` returns `{"ok":true,"ts":...}`.

---

## Part D — Wire app defaults (3 min)

The app currently defaults to `https://relay.prompty.app` (which doesn't exist) when packaged, and `http://localhost:8787` in dev. We update both to point at the deployed workers.dev URL.

### D.1 Update app/src/main-process/relay-client.ts
Change the `relayBaseUrl()` default from `https://relay.prompty.app` to the deployed URL. I'll do this edit when you give me the URL.

### D.2 Add to dev env
You can keep using `npm run dev` without overriding, and it'll hit the deployed Worker. Optional: set `PROMPTY_RELAY_URL=http://localhost:8787` in your shell when you want to test against a local `wrangler dev`.

# verify: I run `cd app && npm run dev` with `PROMPTY_E2E=0` and check the relay URL the auth flow uses (will show up in dev console).

---

## Part E — Real-user manual tests (10 min)

These are the gated tests V1_PLAN's Stage 5 calls out. You drive; I observe.

### E.1 Real Google sign-in
1. `cd /Users/sahilkathpal/code/prompty/app && npm run dev`
2. App should auto-open onboarding (or the signed-in state from earlier — we may need to reset it).
3. Reset to signed-out state: `rm ~/Library/Application\ Support/prompty/google-session.bin` and clear `signedIn` in prompty-settings.json. I'll do this before launch.
4. Click **Sign in with Google** in onboarding.
5. Browser opens to Google consent. Sign in with the email you added as a test user in A.2.
6. Grant the calendar.readonly scope.
7. Land back in the app. Onboarding advances.

**Expected:** Settings tab shows your email. `prompty-settings.json` shows `signedIn: true` and `signedInEmail`.

# verify: I read the settings file and confirm.

### E.2 Real calendar arming
1. With the app running and signed in, create a calendar event in Google Calendar starting in ~10 min. Include a Zoom/Meet/Teams link in the description. Invite a guest from a different email domain (e.g. yourself@gmail.com if your primary is @revise.network — or just add a fake-looking external guest).
2. Wait up to 60s for the calendar-arm poll to fire (or hit a debug menu if we expose one).
3. A macOS notification should appear: "Prep for {your event title} — click to start."

# verify: I `tail -f` the dev log and confirm a fetch happened and the notification fired.

### E.3 Real prep + coach session with real Deepgram
1. Click the notification → prep window opens with the real event info.
2. Have a 3-turn conversation with claude. Hit **Save & start coaching**.
3. Overlay opens. Sidecar spawns (real Swift binary). Deepgram WS connects with a real minted key.
4. Speak into the mic. Wait ~5s. Live transcript should populate in the In-call tab. Nudges should start firing in the overlay.
5. Click **End session** in the overlay. Verify `~/.prompty/calls/` gains a JSON file with the real transcript.

# verify: I check the JSON file's contents and confirm it has utterances + nudges.

### E.4 Rate-limit check (optional)
The relay enforces a 120-min/day cap. Not worth testing fully unless you hit it accidentally. Just note that it's there.

---

## Exit criteria

Stage 5 (and v1) is complete when:
- [ ] `curl https://prompty-relay.<...>/health` returns 200 (Part C.5).
- [ ] You signed in with real Google in the app (Part E.1).
- [ ] Real calendar event was detected by the arming filter (E.2).
- [ ] Real coach session with real Deepgram transcription ran end-to-end (E.3).
- [ ] All 13 Playwright E2E tests still pass with the new defaults (I'll re-run after D.1).

---

## What we're NOT doing in Stage 5
- Custom domain (`relay.prompty.app`). v1 lives on `*.workers.dev`. Move later.
- Notarized DMG distribution. Still requires Apple Developer ID + a separate notarize pass. Documented in `app/RELEASING.md`; not part of v1 functionality.
- Publishing the Google OAuth consent screen (it stays in Testing mode — only test users can sign in). Required for non-test users; deferred.
- Multi-user rate limit verification. The relay code is there; tested only at the unit level.

---

## When you're ready

Tell me when you've completed Part A (the Google Client ID) and we'll work through B → C → D → E together. You paste values, I edit configs and run verifications.
