# Prompty v1 — Wiring Plan

Phase after the `mac-app` scaffolding. PLAN.md described the architecture; this plan turns the scaffolded surfaces into a usable v1 by wiring real auth, real calendar, real prep, and a real coach-start flow.

## Decisions locked (from /grill-me session)

| Topic | Decision |
|---|---|
| Auth | Google OAuth only. No Apple, no email. |
| Token custody | App holds OAuth tokens via `safeStorage`. Relay is stateless w.r.t. users (no DB). |
| Calendar source | Google Calendar API, called directly from Electron main with the user's OAuth access token. No reliance on the user's `claude` having Google Calendar MCP. |
| Calendar filter (arm criteria) | Video link present **AND** ≥1 external attendee **AND** duration ≥15 min **AND** user has accepted (or is organizer). |
| Relay deployment | Always remote (CF Worker). v1 hosts on `*.workers.dev`. Dev defaults to deployed staging Worker; local `wrangler dev` only when changing relay code. |
| Prep | Fully manual. `claude` grills the user. No CRM, no LLM-guessed goal. |
| Prep UI | Dedicated "prep" window — a normal Electron `BrowserWindow` with a streaming chat surface. (Option B from grilling.) |
| App windows | Two: **main window** (tabbed: Prep / In-call / Past calls / Settings) + **overlay** (small, always-on-top, in-call only). The current "settings window" becomes the main window; the current "floating panel" becomes the overlay. |
| Overlay lifecycle | Opens only when a coach session starts. Closes when the user ends the session. |
| Session start | **Fully manual.** No mic-activation auto-start. User clicks "Start coaching" from the prep window's last step, the armed-event card in the main window, or the T-0 notification. |
| Session end | **Fully manual.** User clicks "End session" in the overlay. No mic-idle auto-detection. |
| Ad-hoc prep | "Prep a call" button in main window — same prep flow with no calendar event. Result sits in main window as "ready to start" until clicked or quit. No TTL. |
| Recorder mode | Not in v1. Users who want recording-only can run a coach session with an empty goal; we don't build a separate UI for it. |
| Automatic behaviors | Only invisible plumbing (calendar polling, scheduled notifications). Nothing that opens a window or starts capturing audio happens without an explicit user click. |

## Code currently in tree that gets removed or rewritten

- `src/main/relay-client.ts` — Apple sign-in flow (real + dev paste-token). Replace with Google OAuth.
- `src/main/calendar-arm.ts` — `fetchUpcomingEvent()` stub that returns hardcoded data. Replace with real Google Calendar fetch + filter.
- `src/main/mic-watcher.ts` — entire file's purpose was mic-activation auto-start. Delete the file.
- `relay/src/auth.ts` — Apple JWT validation. Replace with Google JWT validation.
- The `notification.click → runSetupSkill()` path in `calendar-arm.ts` — replace with `notification.click → openPrepWindow(event)`.
- Floating-panel onboarding step for "Sign in with Apple" — replace with "Sign in with Google."

## Stages

Sequential. Every stage exits only when its **smoke test** and its **manual-use test** both pass. Manual-use tests that require permissions, OAuth callbacks, or live calls require the user (Sahil) to drive — flagged with **[user-driven]**.

---

### Stage 1 — Window split

**Scope.** Refactor existing window surfaces into the v1 shape before any new feature lands.

- Rename: settings window → **main window**. Tabs: `Prep | In-call | Past calls | Settings`.
  - `Prep` tab: empty for now ("No prep in progress").
  - `In-call` tab: empty for now ("No active session"). Will later show full transcript + checklist with status + nudge history during a live session.
  - `Past calls` tab: lists files from `~/.prompty/calls/*.json`, click to view JSON for now.
  - `Settings` tab: holds today's settings UI.
- Floating panel window → **overlay window**: strip to goal, checklist, nudge feed only. Remove anything that belongs in the main window. Keep always-on-top, panel type, non-focus-stealing.
- Tray menu: `Open main window`, `Show overlay` (greyed out unless session active), `Quit`. Remove the standalone settings menu item.
- IPC: add channels `main:open-tab`, `overlay:open`, `overlay:close`. Wire to the existing settings store changes where relevant.

**Files touched.**
- `electron/settings-window.ts` → `electron/main-window.ts` (rename + add tab routing).
- `electron/panel-window.ts` → `electron/overlay-window.ts` (rename + show/hide control).
- `src/settings/App.tsx` → `src/main/App.tsx` (tabbed shell).
- New `src/main/tabs/{Prep,InCall,PastCalls,Settings}.tsx`.
- `src/panel/` → `src/overlay/` (renderer rename, strip non-overlay UI).
- `electron/tray.ts` — menu rewrite.
- `electron/ipc-handlers.ts` — add the three new channels.

**Smoke test.**
- `npm run typecheck` clean.
- `npm test` (existing smoke tests still green; no regression in agent/deepgram smoke).
- New: `tests/smoke-main-window-tabs.ts` — boots Electron headlessly (`xvfb`-style not feasible on macOS, use `app.whenReady()` + `BrowserWindow` introspection), creates the main window, switches between all 4 tabs via IPC, asserts each tab renders without throwing.

**Manual-use test [user-driven].**
- `npm run dev`.
- Confirm main window opens with 4 tabs; clicking each switches content.
- Confirm overlay is **not** visible by default.
- Open Settings tab, change hotkey, restart — setting persists.
- Confirm tray menu shows the 3 items; "Show overlay" is greyed out.

**Exit.** Both tests pass. Settings persistence verified. No new functionality yet — just the right window shapes.

---

### Stage 2 — Auth + calendar

**Scope.** Rip Apple sign-in. Add Google OAuth in Electron + Google ID-token validation in the relay. Implement real `fetchUpcomingEvent()` against Google Calendar API with the four-condition filter.

**Auth flow (Electron).**
- New `src/main/google-auth.ts`:
  - `signInWithGoogle()` opens a `BrowserWindow` to Google's OAuth authorize URL with scopes `openid email profile https://www.googleapis.com/auth/calendar.readonly`.
  - Captures the auth code via redirect interception (loopback `http://localhost:<random>/callback`).
  - Exchanges code → access/refresh tokens at Google's token endpoint (PKCE, no client secret in app).
  - Encrypts both tokens with `safeStorage`; persists in `app.getPath("userData")/google-session.bin`.
  - `getAccessToken()` returns a fresh access token, refreshing if expired.
- `signedIn` settings flag set on success; `signedInUserId` = Google `sub`.

**Auth flow (relay).**
- `relay/src/auth.ts` rewrite: validate Google ID token against Google's JWKS (cache JWKS in KV with 24h TTL). Verify `iss`, `aud` (Prompty's Google client ID), `exp`. Return Prompty session JWT — same shape as before so `/deepgram/token` is unchanged.
- Delete Apple-specific code paths in relay.

**Calendar fetch.**
- New `src/main/google-calendar.ts`:
  - `listUpcomingEvents(windowMinutes)`: GET `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=...&timeMax=...&singleEvents=true&orderBy=startTime`.
  - Returns the raw event objects.
- New `src/main/calendar-filter.ts`:
  - `qualifies(event, userEmail)`: implements the four-condition filter.
    - Video link: regex match in `event.location`, `event.description`, OR truthy `event.conferenceData?.entryPoints` with type `video`.
    - External attendee: any `attendee.email` not on the same domain as `userEmail`, excluding the user themselves.
    - Duration ≥15 min: `end - start ≥ 15*60*1000`.
    - Accepted/organizer: `event.organizer.self === true` OR the self-attendee's `responseStatus === "accepted"`.
- Rewrite `src/main/calendar-arm.ts`:
  - `fetchUpcomingEvent()` calls `listUpcomingEvents(15)`, filters with `qualifies`, returns the next event ≥now.
  - Arming logic unchanged: poll every 60s, fire notification at T-15.
  - Notification body changes to "Prep for X — click to start" (was "click to prep").
  - On notification click: open prep window (Stage 4 will fill in real behavior; for Stage 2 it stubs as console.log + main-window open on Prep tab).

**Onboarding update.**
- Replace "Sign in with Apple" step with "Sign in with Google." Button label, copy, IPC channel name (`auth:google-sign-in`).

**Files touched.**
- New: `src/main/google-auth.ts`, `src/main/google-calendar.ts`, `src/main/calendar-filter.ts`.
- Modified: `src/main/calendar-arm.ts`, `src/main/relay-client.ts` (gut Apple, keep Deepgram token mint), `src/onboarding/App.tsx`, `src/shared/ipc.ts` (rename `auth:apple-sign-in` → `auth:google-sign-in`), `electron/ipc-handlers.ts`.
- Relay: `relay/src/auth.ts`, `relay/src/index.ts`.

**Smoke tests.**
- New `tests/smoke-calendar-filter.ts` — table-driven test of `qualifies()`: include video-link variants, attendee-domain edge cases, response-status combinations, duration boundary, all-day events. ~12 cases.
- New `tests/smoke-google-token-refresh.ts` — stubbed: mock Google token endpoint, verify refresh flow correctly retries on 401, stores new token, returns valid bearer.
- New `relay/tests/smoke-google-jwt.ts` — mock JWKS endpoint, validate a signed test JWT, confirm rejection on bad `aud` / expired / wrong issuer.

**Manual-use test [user-driven].**
- `npm run dev`.
- Onboarding (or click "Sign in with Google" if onboarding is bypassed) → real Google consent screen → grant calendar scope → land back in the app, `signedIn: true`.
- In the main window's Prep tab (or via a debug menu we add), trigger a manual "fetch upcoming event" call → confirm a real event from your calendar appears (or "no qualifying event" if none in the next 15 min).
- Wait for a real qualifying event to come within the 15-min window, or manually create one in Google Calendar and wait 60s — confirm the macOS notification fires with the real event title.

**Exit.** Smoke tests green. Sahil signed in with Google; real upcoming event detected by the filter; notification fires.

---

### Stage 3 — Manual coach start

**Scope.** Add the "Start coaching" path that doesn't require a prep window. Uses whatever goal/checklist exists (empty for now, since prep window lands in Stage 4).

- Main window's `In-call` tab gains a "Start session" button (active when nothing else is running).
- Armed event card (in main window) gains a "Start now" button.
- T-0 notification: scheduled at arm time. Body: "X is starting — click to begin coaching." Click → starts session.
- "Start session" path:
  - Opens overlay window (Stage 1 wired the show/hide).
  - Spawns Swift sidecar (already wired in Stage E).
  - Starts Deepgram dual-stream client (needs relay token from Stage 2).
  - Spawns agent loop with goal=`""`, checklist=`[]` if no prep, or with prep data when Stage 4 lands.
  - In-call tab shows live transcript + checklist + nudges.
  - Overlay shows compact goal + checklist + latest nudge.
- "End session" button in overlay and in In-call tab: kills sidecar, closes Deepgram streams, flushes log to `~/.prompty/calls/{eventId}.json`, closes overlay, shows post-call summary in main window's Past calls tab.

**Files touched.**
- New `src/main/coach-session.ts` — single source of truth for session start/stop, ties together sidecar + deepgram + agent + log writer.
- Modified: `electron/ipc-handlers.ts` (`session:start`, `session:end` channels), `src/main/tabs/InCall.tsx`, `src/main/tabs/Prep.tsx` (armed-event card with Start button), `src/overlay/` (End button).
- Modified `src/main/calendar-arm.ts` to schedule T-0 notification.

**Smoke tests.**
- New `tests/smoke-coach-session.ts` — start a fake session with stubbed sidecar (PCM from a fixture), stubbed Deepgram (mock WS), real agent loop pointed at a fake `claude` binary. Assert: agent emits ≥1 nudge, log file written on session end.
- Update `tests/smoke-agent.ts` to cover the empty-goal path (just confirms agent doesn't crash with goal=`""`).

**Manual-use test [user-driven].**
- `npm run dev`. Sign in with Google (Stage 2). Wait for or create a qualifying event.
- Click "Start now" from the armed event card → overlay opens, In-call tab populates with live transcript text as you speak into the mic.
- Speak some test content; confirm at least one nudge appears in the overlay.
- Click "End session" → overlay closes; Past calls tab gains the new entry.
- Open `~/.prompty/calls/` and confirm the JSON file is sane.

**Exit.** Smoke + manual-use tests pass. Sahil ran one real end-to-end coaching session against himself talking to the mic.

---

### Stage 4 — Prep window

**Scope.** Build the dedicated grilling window. Two entry points: (i) click the armed-event notification or "Prep" button on the armed event card, (ii) "Prep a call" button in main window for ad-hoc.

- New `electron/prep-window.ts` — `openPrepWindow({event?})`. 600×700, normal window chrome. Loads `src/prep/`.
- `src/prep/App.tsx` — streaming chat UI:
  - Top: event title + attendee summary (if event provided), or "Ad-hoc call prep" if not.
  - Middle: chat transcript (user + assistant turns).
  - Bottom: input textarea + send.
  - Right rail: live-updating "Goal" + "Checklist" cards that get filled in as the conversation progresses (the model writes to them via tool calls, same `prompty-nudges`-style MCP server but for prep).
  - Footer: "Save & start coaching" button (active once goal + ≥1 checklist item exist).
- Backend: `src/main/prep-session.ts` opens a `claude` `query()` stream with a prep-specific system prompt (replaces the existing `/prompty-setup` skill flow). Tools:
  - `set_goal(text)` — writes the goal.
  - `add_checklist_item(text)` — appends.
  - `update_checklist_item(id, text)` — edits.
  - `remove_checklist_item(id)` — deletes.
- On "Save & start coaching": persists `{event?, goal, checklist}` to a pending-prep store (in memory + on disk for crash recovery), closes prep window, opens overlay, starts coach session (Stage 3 plumbing).
- On "Save only": persists, closes prep window. Armed event card now shows "Prepped — start when ready."
- Armed-event notification body updates to: "Prep for X — click to start." Click opens prep window pre-populated with the event.
- Main window Prep tab: shows the current pending prep (if any) with "Resume prep" / "Discard" / "Start coaching" buttons.

**Files touched.**
- New: `electron/prep-window.ts`, `src/main/prep-session.ts`, `src/main/prompts/prep-system.ts`, `src/prep/`.
- Modified: `src/main/calendar-arm.ts` (notification click → prep window), `src/main/tabs/Prep.tsx`, `electron/ipc-handlers.ts` (`prep:open`, `prep:send-message`, `prep:save`, `prep:discard`, `prep:state`).
- Delete: `skills/prompty-setup/` is *not* deleted yet (still useful as a CLI fallback for power users), but the app no longer invokes it. Re-evaluate at end of v1.

**Smoke tests.**
- New `tests/smoke-prep-session.ts` — drive a scripted conversation with a fake `claude` binary that emits expected tool calls; assert goal + checklist persisted correctly.
- New `tests/smoke-prep-window-ipc.ts` — open prep window, send 3 messages via IPC, close, verify state.

**Manual-use test [user-driven].**
- Click an armed-event notification (or trigger one via debug) → prep window opens.
- Have a real grilling conversation with claude; goal and checklist populate in the right rail as you talk.
- Click "Save & start coaching" → prep window closes, overlay opens with the goal + checklist visible.
- Repeat with "Prep a call" button (no event) → confirm ad-hoc flow.

**Exit.** Sahil completed at least one real prep session ending in coaching, and one ad-hoc prep.

---

### Stage 5 — Relay deploy + production cutover

**Scope.** Push the relay to a real `*.workers.dev` URL. Wire app defaults.

- `wrangler deploy` from `relay/`. Subdomain TBD (e.g., `prompty-relay.<account>.workers.dev`).
- Set secrets via `wrangler secret put`: `GOOGLE_CLIENT_ID`, `PROMPTY_JWT_SECRET`, `DEEPGRAM_MASTER_KEY`.
- Create the Google OAuth client in Google Cloud Console (web app type for code exchange + Calendar API enabled).
- App default for `PROMPTY_RELAY_URL` in dev: the staging workers.dev URL. In packaged build: same URL (we have only one for now). Override via env var still supported.
- README update: how to run the app against staging vs. local wrangler dev.

**Smoke tests.**
- `relay/tests/smoke-deployed.ts` — hits `GET /health` on the deployed URL, asserts 200.
- `tests/smoke-relay-roundtrip.ts` (in app) — uses a real Google ID token (env-injected, generated via `gcloud auth print-identity-token` or similar dev fixture) to call `/auth/apple` (renamed to `/auth/google`) → confirms a Prompty session JWT comes back. Then calls `/deepgram/token` with it → confirms a Deepgram key comes back.

**Manual-use test [user-driven].**
- Sahil runs `npm run dev` with no `PROMPTY_RELAY_URL` override.
- Signs in with Google (Stage 2 already works, now hitting real relay).
- Triggers a coaching session that uses real Deepgram transcription — confirms real captions appear in the overlay.

**Exit.** Sahil ran a real, fully-cloud-backed coaching session. Relay is live.

---

## Implementation orchestration

Stages are strictly sequential — each builds on the last and the testing gate is binding. **Within a stage**, several files can be edited in parallel by subagents; I'll fan out where it's clearly independent and converge before the stage's smoke test.

For example, in Stage 2:
- Subagent A — Electron Google OAuth implementation (`src/main/google-auth.ts`).
- Subagent B — Relay Google JWT validation (`relay/src/auth.ts`).
- Subagent C — Calendar fetch + filter (`src/main/google-calendar.ts`, `src/main/calendar-filter.ts`).
- I integrate, write/run smoke tests, hand to Sahil for manual-use.

Each stage ends with me producing a short status block here (or in a new `V1_STATUS.md`) summarizing what passed, what surprised, and what to fix.

## What I cannot test on my own — needs Sahil

For honesty:
- Granting TCC permissions (mic, notifications) — needs OS dialog approval.
- Completing real Google OAuth — needs you in the browser to consent.
- Joining or simulating a real call with two speakers — best I can do alone is speak into the mic.
- Confirming the overlay's always-on-top behavior over a real Zoom window — needs Zoom installed and a fake call.
- Notarization / signing — needs Apple Developer ID secrets.

Everything else (IPC, file IO, agent loop with stubbed `claude`, calendar filter, JWT validation against mock JWKS, settings persistence, tab routing, prep-conversation state) I can drive end-to-end myself.
