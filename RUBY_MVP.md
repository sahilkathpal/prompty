# Ruby — MVP Spec & Strip Plan

> Status: **implemented.** The strip/build/hardening phases below have landed on
> `ruby-rebuild`: the cut features are removed, the Deepgram key is read from the
> environment, the gem overlay and post-call card are built, and the hardening in §6
> survives. This document is kept as the authoritative spec, not pending work; §5–§9
> describe the plan as it was executed.
>
> Product name **Ruby** is user-facing only; the code stays `prompty` for now (no rename churn).
> Branch: `ruby-rebuild`. Audience: the developer + a few hand-picked design partners.

---

## 1. Purpose

Ruby hands you the next great question on a live call. You're in a conversation where
getting good information out of the other person is the point — a discovery call, a user
interview, a 1:1 — and at the moment you'd otherwise say "makes sense, so anyway…", Ruby
surfaces the one follow-up that mines what they just said.

Personality: **Clippy's warmth, with the judgment Clippy never had.** Silence is the default.
A bad nudge is worse than no nudge. If it would feel strange for a human assistant to
interrupt with it, Ruby stays quiet.

It stays a native macOS app (Electron + Swift sidecar) so the overlay floats over any call
surface and audio is captured at the OS level — platform-agnosticism is preserved even though
the MVP experience is deliberately narrow.

---

## 2. The MVP loop

1. **Start — manual.** Global hotkey or menubar. Ruby is inert until you reach for it: no
   background mic-watching, no foreground-app polling, no calendar awareness. The trust story
   is "Ruby does nothing until you start it."
2. **Prep — none required.** Optional free-text context box ("who you're talking to, what
   you're after"). Optional opt-in skill (discovery / hiring / user-interview), never the
   default. User-dropped `.md` skills are the power-user ceiling. A stated pacing preference in
   the context box ("only interrupt if critical" / "jump in often") overrides the default quiet bar.
3. **In-call — the gem.** A small persistent ruby anchor, top-right, faint glow = listening
   (status: listening / no-audio / reconnecting / error). When there's something to say, **one
   ephemeral note** blooms beneath it and fades after a few seconds. Nothing stacks in the
   resting state. Click the gem to expand a quiet scrollback of notes surfaced this call; click
   away to collapse. Two doors to one engine: **proactive** notes (high bar) and the **on-demand
   hotkey** (low bar, zero interruption risk — you asked, so it always answers). Cadence is the
   agent's judgment plus a display debounce. Hidden from screen-share via content-protection.
4. **Post-call — one auto summary card.** Zero required input, written to `~/.prompty/calls/`.
   Three sections:
   - **Recap** — a few lines.
   - **Insights & quotes** — Ruby-assisted ones marked `✦` with a trailing clause
     ("surfaced after Ruby's nudge to ask what they tried before"). **Under-claim when unsure** —
     a false claim of credit is worse than no claim.
   - **Questions you didn't ask** — the safety net that lets the in-call surface be ephemeral.
   - Plus one quiet stat line: "Ruby surfaced 6, you used 3."

---

## 3. Resolved decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Core job | Hand you the next great follow-up question |
| 2 | Surface | Native macOS app (Electron + Swift sidecar); platform-agnostic capture preserved |
| 3 | Prep | Zero structured prep; optional free-text context; optional opt-in skills |
| 4 | Cadence | Agent judgment + display debounce; stated pacing preference overrides |
| 5 | In-call display | Ephemeral single note + on-demand expandable scrollback; nothing accumulates at rest |
| 6 | Start/stop | Manual start (hotkey + menubar); mic-idle/manual end; **no ambient detection** |
| 7 | Per-person memory | Deferred; single-call only; context box is the manual memory stand-in |
| 8 | Interaction | Proactive notes **and** on-demand "what should I ask?" hotkey |
| 9 | Post-call | 3-section auto card (Recap / Insights ✦ / Questions you didn't ask) + stat; written to disk |
| 10 | Audience & infra | Dev + design partners; relay, Apple/Google sign-in, rate-limit, notarization/Sparkle all shelved |
| 11 | Prompt floor | Broad follow-up philosophy lives in `base.md`; optional skills layer on top |
| 12 | Calm/Lab | Calm only; Lab (rejected-reasoning view) deferred; keep logging `stay_quiet(reason)` |
| 13 | Naming | "Ruby" in UX; `prompty` in code |
| 14 | Overlay form | The gem: anchor + bloom + expandable history |
| 15 | Screen-share | Already solved via `setContentProtection(true)`; nothing to build |

---

## 4. Deferred / cut from the MVP

Relay (Deepgram token minting) · Apple/Google sign-in & session tokens · KV rate-limiting ·
calendar arming · ambient call detection / mic-activation watcher · structured prep & the prep
interview · checklist + goal banner · nudge-kind taxonomy & urgency-queue machinery beyond a
single note + debounce · Calm/**Lab** split (Lab only) · notarization + Sparkle auto-update.

All of it stays recoverable in git history; this is removal from the active branch, not erasure.

---

## 5. Strip plan

### 5a. Delete outright (serve only cut features; no MVP consumer)

**Main process** (`app/src/main-process/`):
`relay-client.ts`, `relay-config.ts`, `google-auth.ts`, `google-calendar.ts`, `calendar-arm.ts`,
`calendar-filter.ts`, `mic-watcher.ts`, `prep-session.ts`, `prompts/prep-system.ts`, `pending-prep.ts`

**Other:**
- `relay/` — entire directory
- `skills/prompty-setup/` — also already broken (posts to the deleted `:7878` server)
- `app/src/overlay/components/Brief.tsx`, `app/src/overlay/components/Checklist.tsx`
- `app/src/main-window/prep.css`
- `app/src/main-process/prompts/skills/*/prep.md` (prep playbooks; the `*/in-call.md` ones stay)
- `app/electron/auto-updater.ts` (auto-update cut)
- `audio-sidecar/Sources/AudioSidecar/ScreenShareWatcher.swift` — **confirmed dead**: emits
  `screen_share_started/stopped` frames the app never listens for; content-protection replaces it.
- Docs: `PLAN.md`, `V1_PLAN.md`, `V1_STAGE5_CHECKLIST.md`

### 5b. Trim (remove cut-feature wiring, keep the core)

- **`app/electron/ipc-handlers.ts`** — drop the ~36 `auth:*` / `calendar:*` / `prep:*` /
  `pending-prep:*` channels and the calendar-arm scheduler block. **Keep** `call:start/end`,
  `nudge:request`, overlay control, onboarding, and the **direction load/save** handlers — the
  direction box is the surviving free-text context input (decision #3).
- **`app/electron/main.ts`** — remove calendar-arm + prep E2E stubs.
- **`app/electron/tray.ts`** — remove "Signed in" status.
- **`app/electron/settings-store.ts`** — remove `signedIn*` fields; keep hotkey, panel position, debug, etc.
- **`app/src/shared/types.ts`, `app/src/shared/ipc.ts`** — remove now-dead channels/types
  (prep, calendar, auth, pending-prep, `CallSetup.goal`/`.checklist` if unused at runtime).
- **`app/src/overlay/App.tsx` + `overlay.css`** — remove goal/checklist state + styles.
- **`app/src/main-window/App.tsx`** — remove Google-auth UI rows/buttons.
- **`app/package.json`** — drop `electron-updater` and `@electron/notarize` deps.
- **`README.md`** — rewrite to Ruby MVP scope.
- **`app/RELEASING.md`** — trim to the local-signed-build section only.
- **`.env.example`** — drop `ATTIO_TOKEN`.
- **`audio-sidecar/README.md`** — remove stale ScreenCaptureKit-fallback / Screen-Recording-permission
  references (SCK fallback was already removed in commit `d33215c`; tap is the sole system-audio path).

### 5c. Keep — core loop + earned hardening (do **not** touch)

`coach-session.ts`, `deepgram.ts`, `agent.ts`, `sidecar.ts`, `answer.ts` (hotkey), `call-log.ts`,
`journal.ts`, `running-summary.ts`, `summary.ts`, `models.ts`, `windowing.ts`, `debug-logger.ts`,
`claude-cli.ts`, `prompts/loader.ts`, `prompts/system.ts`, `prompts/base.md`,
`prompts/skills/*/in-call.md`; the overlay + teleprompter window scaffolds (until the gem rebuild);
the replay harness; all smoke tests for surviving features.

Audio sidecar: `ObjCException/`, `MicCapture.swift`, `CoreAudioTap.swift`, `main.swift`,
`ProcessTargeting.swift` (debug-only, harmless), `Protocol.swift`, tests, `Package.swift`.

---

## 6. Hardening inventory — must survive the strip

These are deliberate fixes (commits `0f75845`, `0aa1562`, `518ea3a`). Locations are approximate —
verify by function name, not line number.

| Hardening | Where | Why it matters |
|---|---|---|
| ObjC-exception bridge | `audio-sidecar/Sources/ObjCException/` + `MicCapture.swift` `runCatchingObjCException()` | Bluetooth A2DP↔HFP flip mid-call raises an uncatchable `NSException` on `installTap`/`engine.start`; without the shim the sidecar SIGABRTs and both streams die. Converts it to a Swift throw → retry. |
| Debounced + retried mic reconfigure | `MicCapture.swift` `handleConfigChange()`, `reconfigure(attempt:gen:)` | Device switch fires a burst of config-change notifications; HW format isn't immediately stable. Debounce (0.3s) coalesces; up to 6 retries let the format settle; generation counter ensures only the latest transition wins. |
| Converter rebuild before re-tap | `MicCapture.swift` `buildAndStart()` | Stops engine + removes tap, re-reads input format, rebuilds converter, *then* re-taps — installing a tap mid-flip is the exact NSException trigger. |
| Tap format-change listener | `CoreAudioTap.swift` `kAudioTapPropertyFormat` listener → `rebuildConverterForCurrentTapFormat()` on `ioQueue` | Output device / sample-rate shift (e.g. VoIP app starts) would otherwise garble the transcript via stale resampling. Rebuild runs on the IO queue (no lock, no race) with an early-exit if format is unchanged. |
| Signal + stdin parent-death handling | `main.swift` | Clean shutdown on SIGTERM/INT/HUP and when Electron closes stdin — no orphaned sidecar. |
| Deepgram KeepAlive (5s) | `deepgram.ts` | Idle sockets drop after ~10s; the system-audio tap produces no PCM during silence, so keepalive holds the socket open mid-call. |
| Deepgram backoff reconnect + buffer cap | `deepgram.ts` | Bounded exponential backoff (500ms→8s, max 6) on unexpected close (incl. Deepgram's 1011); `MAX_PENDING_CHUNKS=400` caps buffered audio during an outage. Emits `open`/`reconnecting`/`error` for the status dot. |
| Mic-silence detection | `coach-session.ts` | macOS can grant mic permission yet feed all-zero PCM; 4s of pure silence → `mic-silent` status + a user-facing "check System Settings" message instead of a cryptic no-audio state. |
| Audio route-change resilience | `coach-session.ts` `markAudio()` + Deepgram reconnect | Headphones/bluetooth/device switch / another app grabbing the mic → reconnect + soft `reconnecting` status; resumes on the next frame. |
| Auto-consider coalescing | `coach-session.ts` | Max 1 in-flight + 1 queued consider; queued always uses the freshest transcript window, and the hotkey can jump the queue. |
| Turn-interrupt on decision | `agent.ts` `finishTurnEarly()` | Cut the turn the moment `emit_nudge`/`stay_quiet` lands — don't hold the serial session open for model cleanup. Critical for hotkey latency. |
| `stay_quiet(reason)` logging | `agent.ts` → debug log / journal | Feeds the replay harness for prompt tuning. Keep even though Lab UI is deferred. |

---

## 7. Build tasks the strip creates (not deletions)

1. **Deepgram key via env var.** `coach-session.ts` currently obtains the key only through
   `relay-client.getDeepgramToken()`. After removing the relay, read `process.env.DEEPGRAM_API_KEY`
   (from a gitignored `.env` loaded at startup). The README's "dev paste-token modal" does **not**
   exist in code — this is net-new (small) wiring, not a revert. Onboarding/settings copy should tell
   a partner where to put the key.
2. **Confirm the direction → session path survives without prep.** Prep used to feed
   direction/goal/checklist into `coach-session`. With prep gone, the free-text **direction** comes
   from the main-window box via the kept `direction` IPC handlers. Verify a call starts with that
   direction (and optional skill) and no prep dependency remains.
3. **The gem (separate, forward-build pass).** Neither current window is the gem yet: `overlay` is a
   panel (brief/checklist/`NudgeFeed` sticky-pile), `teleprompter` is a single-line bar with good
   dwell/queue logic. Target end state is **one** window:
   - Rebuild `overlay/App.tsx` as the gem (anchor + bloom + expandable history).
   - Fold the teleprompter's dwell/queue/high-urgency-preempt logic into the bloom.
   - Delete the teleprompter window, the `headsUpBar` toggle, and `NudgeFeed` (the accumulating pile
     contradicts the ephemeral decision #5).
   - Keep `setContentProtection(true)` on the gem window.

---

## 8. Security

`.env` is correctly gitignored (`.gitignore:4`), is **not tracked**, and has **never been
committed** to any branch — verified via `git ls-files` / `git log --all -- .env`. No git action
needed. (An earlier draft of this doc wrongly claimed it was tracked; that was a sub-agent error,
corrected here.)

The only exposure: the codebase sweep printed the live Deepgram key and Attio token values into the
review session transcript. Rotate both **only if** that transcript leaves this machine (shipped to a
log sink, shared, etc.); otherwise nothing to do.

---

## 9. Suggested execution order (when green-lit)

1. Security: untrack `.env`, rotate keys.
2. Delete §5a, trim §5b — branch should still compile.
3. Build task §7.1 (env-var key) + verify §7.2 (direction path) — restores a working call.
4. Run replay harness + smoke tests; confirm hardening in §6 intact.
5. Separate pass: build the gem (§7.3).
6. Rewrite `README.md`; delete obsolete docs; this file supersedes `PLAN.md`/`V1_PLAN.md`.
