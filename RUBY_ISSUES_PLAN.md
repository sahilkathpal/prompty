# Ruby Issues — Implementation Plan

Plan for the seven items in `agent-obsidian/ruby issues.md`, with the design
decisions resolved in the grill-me session. Point 2 (Google sign-in) has a
companion backend design doc: `RUBY_RELAY_BACKEND_DESIGN.md`.

---

## 1. Dock icon + "Ruby" display name

**Decision:** Squircle **cream tile** with the 3D gem, dock always present,
rename display name to "Ruby", freeze `appId` and `~/.prompty` data paths.

**Art prep** (source: `~/Downloads/ruby.png`):
- Knock out the white background → transparent; drop the baked-in shadow
  (macOS adds its own).
- Center the gem on a **1024×1024 cream squircle tile** (`--cream` `#faf7e9`),
  macOS Big Sur+ corner radius (~22.37% of side), with balanced padding.
- Generate the full iconset (16, 32, 64, 128, 256, 512, 1024 @1x/@2x) →
  `app/build/icon.icns` (electron-builder `buildResources: build` already
  picks this up).
- Keep `ruby-logo.svg` (flat 2D) as the in-app mark — the 3D tile is the
  app/dock icon only. This divergence is intentional.

**Dock presence:**
- There is **no** `LSUIElement` / `LSBackgroundOnly` / `app.dock.hide()` /
  `setActivationPolicy` anywhere, so nothing is suppressing the dock icon.
  Making it appear = ship the icon + confirm normal-app behavior.
- For dev parity, set the dock icon explicitly in `app/electron/main.ts`
  (`app.dock?.setIcon(...)`) so dev runs show the branded icon too.
- **Verify at runtime** that the icon actually appears (dev + packaged). If
  still absent, debug the launch path (the `openAsHidden` login item should
  hide *windows*, not the dock icon).

**Display name (freeze identity):**
- `app/electron-builder.yml`: `productName: Prompty` → `Ruby`.
- Leave `appId: app.prompty.desktop` **unchanged**.
- Leave all `~/.prompty/*` paths (settings, memory, calls, debug) **unchanged**
  so existing alpha data, login-item registration, and memory are not orphaned.
- Sweep user-visible "Prompty" strings (menu bar app name, about panel) for the
  rename; do **not** touch the `app.prompty.*` identifiers or data-dir literals.
- Full `appId`/data-dir rebrand is a deliberate later migration, out of scope.

**Files:** `app/build/icon.icns`, `app/electron-builder.yml`,
`app/electron/main.ts`.

---

## 2. Google sign-in → Deepgram token gating

**Decision:** Scope **(b)** — build the client side against a defined contract
now; design the backend in `RUBY_RELAY_BACKEND_DESIGN.md`. Architecture is
**token-minting**: the backend mints short-lived, scoped Deepgram keys; the
client keeps connecting **directly** to `wss://api.deepgram.com` (today's
low-latency path), just with an ephemeral key instead of the shared one.

**Why:** The shared `DEEPGRAM_API_KEY` in `.env` (see `coach-session.ts:38-45`,
comment: "Replaces the old relay token-minting path") can't ship to launch
users. Sign-in authorizes minting. The Claude side is **not** a shared-secret
problem — the app runs each user's own local `claude` CLI.

**Client work (this repo):**
- **OAuth flow** — replace the mocked `handleSignIn()` in
  `app/src/onboarding/App.tsx:343-349` (StepSignin, lines 646-682) with a real
  Google OAuth flow (PKCE; system-browser + loopback or custom-protocol
  redirect back into the app).
- **Contract** (implemented against, backend stubbed/mockable):
  - `POST /auth/google` `{ id_token }` → `{ session_jwt, user }`
  - `POST /deepgram/token` `(Authorization: Bearer <session_jwt>)` →
    `{ key, expires_at }`
- **Token storage** — persist the session JWT in the macOS **Keychain**
  (not settings JSON / not `~/.prompty`).
- **Deepgram path** — `resolveDeepgramKey()` (`coach-session.ts:44`) changes
  from "read `.env`" to "fetch a short-lived key via `/deepgram/token` using the
  stored session, per call start." Keep `PROMPTY_MOCK_DEEPGRAM` and a dev
  `.env` fallback for local/E2E.
- **New IPC** — `auth:sign-in`, `auth:status`, `auth:sign-out`; surface signed-in
  identity in settings.
- **Gating** — onboarding can't complete (and calls can't start) without a valid
  session, except in E2E/mock modes.

**Files:** `app/src/onboarding/App.tsx`, `app/src/main-process/coach-session.ts`,
`app/electron/ipc-handlers.ts`, new `app/src/main-process/auth.ts` (+ Keychain),
`app/src/shared/types.ts`.

---

## 3. Prep window auto-increase is too much

**Decision:** Shrink the prep "wide" layout from **1521×1014 → ~1180×760**.

- `app/electron/ipc-handlers.ts:459-473` (`main:set-prep-layout`):
  `[1521, 1014]` → `[1180, 760]`. Keep the center-anchored grow/shrink.
- ~1180 wide fits chat (≤600) + prep panel (≤600) + gutters with no dead space;
  760 tall leaves breathing room on a 14" laptop (vs 1014 ≈ full height).
- Base (non-wide) stays `[900, 600]`.

**Files:** `app/electron/ipc-handlers.ts`.

---

## 4. Consistent max width for content

**Decision:** One shared token for single-column screens; prep stays bespoke.

- **`tokens.css`** (`app/src/shared/tokens.css`): add `--content-max: 640px`.
- **Single-column surfaces** — apply `--content-max` (centered), replacing the
  scattered hardcoded values: home body (`main-window.css:174` `600px`),
  post-call/fullscreen body (`923`/`1010` `600px`), note, settings.
- **Prep screen (treated differently)** — full-width two-pane, **not** governed
  by `--content-max`:
  - Chat bubbles: `prep-bubble-user`/`prep-bubble-asst` (`main-window.css:447-448`)
    `max-width: 80%` → fixed **520px**.
  - Prep panel: keep existing resizable **280–600px** range.

**Files:** `app/src/shared/tokens.css`, `app/src/main-window/main-window.css`,
relevant containers in `app/src/main-window/App.tsx`.

---

## 5. Fold checklist + goal into Ruby's note

**Decision:** **(a) Visual fold, keep structure.** The prep panel reads as one
note document, but goal + checklist render as sections **inside** it and remain
structured `PrepComponent`s under the hood — so live behavior is preserved.

- **Keep intact:** `mark_covered` live item-checking during the call; post-call
  `ChecklistCoverage` (`App.tsx:94-114`); goal injected into `CallSetup`
  (`ipc-handlers.ts:230-235`); `PrepComponent` types (`types.ts:56-90`).
- **Change presentation only:** in the prep panel, render the goal as a headline
  line and the checklist as a checkable section **within** the single note
  surface, instead of as detached cards. Both stay editable (add/remove/edit
  items). Default placement: goal at top of note, checklist below the direction
  body — adjust if desired.

**Files:** `app/src/main-window/App.tsx` (prep panel render),
`app/src/main-window/main-window.css` (in-note section styles).

---

## 6. Reset overlay nudges after onboarding

**Decision:** Robust reset; discard ephemeral history freely; defer post-call
nudges view.

**Root cause:** `fireOnboardingNudge()` (`ipc-handlers.ts:805-817`)
`broadcast(...)`s to **every** window; the overlay window is created once and
**reused** (`overlay-window.ts:40-41`), never remounted, so its React `history`
persists for the app's lifetime. The single `"starting"` reset
(`overlay/App.tsx:97-106`) is timing-fragile and doesn't reliably win, so the
canned onboarding nudges leak into the first real call.

**Safe to discard:** nudges are durably recorded in the call log
(`call-log.ts:19`, written at `coach-session.ts:494`). The overlay history is a
pure display buffer — resetting it loses nothing.

**Fix:**
- Reset the overlay's nudge state (`bloom` + `history` + `queue` + `expanded`)
  **when it is shown for a call** (tie to `showOverlay()` at call start), not
  only on the `"starting"` broadcast. Keep the `"starting"` reset as
  belt-and-suspenders.
- Make `"ended"`/`"idle"` a **full** reset too (also clear `history`/`expanded`);
  safe because that retained history is unreachable (overlay is hidden on end,
  `ipc-handlers.ts:259`).
- Fire a full reset at **`onboarding:complete`** (`ipc-handlers.ts:754-764`,
  which already `hideOverlay()`s) so the demo nudge can't survive.
- Pin the exact event ordering during implementation.

**Deferred:** surfacing `log.nudges` on the post-call screen (data exists; no UI
reads it yet). Separate feature, not part of this fix.

**Files:** `app/src/overlay/App.tsx`, `app/electron/ipc-handlers.ts`,
`app/electron/overlay-window.ts`.

---

## 7. "Stop Listening" everywhere

**Decision:** Unify **all** end-call labels to "Stop Listening"; gate on the
whole active session; keep greyed when idle.

- **Rename** (same `endActiveSession()` action, no behavior change):
  - Tray `"End session"` → `"Stop Listening"` (`tray.ts:54`).
  - Gem overlay `"End call"` → `"Stop Listening"` (`overlay/App.tsx:415`).
  - Main window `"End call"` (`App.tsx:610`) and `"End session"`
    (`App.tsx:997`) → `"Stop Listening"`.
  - Keep the in-progress state label consistent (e.g. "Stopping…").
- **Gating** — tray item stays `enabled: sessionActive` (`tray.ts:55`) — usable
  for the whole call, including reconnect/error states. **Not** gated strictly
  on `status === "listening"`.
- **Visibility** — keep the item always shown, greyed when idle (current
  behavior).

**Files:** `app/electron/tray.ts`, `app/src/overlay/App.tsx`,
`app/src/main-window/App.tsx`.

---

## Suggested sequencing

1. **Quick UI fixes (low risk):** #3 (prep size), #7 (labels), #4 (max-width
   token) — small, independent.
2. **Overlay reset:** #6 — contained, needs a main-process restart to verify
   live.
3. **Prep note fold:** #5 — presentation refactor; verify live coverage still
   works end-to-end.
4. **Branding:** #1 — icon asset pipeline + display-name sweep.
5. **Auth + relay:** #2 — largest; client work here, backend per
   `RUBY_RELAY_BACKEND_DESIGN.md`. Launch-blocking, so start the backend design
   in parallel.
