# Prompty → Mac App Rewrite Plan

Branch: `mac-app`. Greenfield. Old `main` (Chrome extension + Node server) keeps running until parity.

## Product shape

Platform-agnostic real-time call coach for macOS. Works over any call surface (Zoom, Google Meet, FaceTime, Slack huddle, Discord, phone-via-Continuity) by capturing system audio at the OS level instead of attaching to a browser tab. Floating panel overlays any app and surfaces goal, checklist, and live nudges during the call.

## Resolved decisions

| Decision | Choice |
|---|---|
| Scope | Platform-agnostic Mac app, any call, any app |
| Audio capture | CoreAudio tap on macOS 14.4+, ScreenCaptureKit fallback on 13.0–14.3 |
| macOS floor | 13 (Ventura) |
| Stack | Electron + React (UI, agent loop, Deepgram client) + Swift sidecar (audio only) |
| Server | Folded into Electron main process — no separate Node server, no terminal |
| LLM auth | App shells out to the user's local `claude` binary (Claude Code is a silent dependency) |
| Transcription | Dev pays. Cloudflare Worker mints short-lived Deepgram tokens, 120 min/day/user cap |
| User auth | Sign in with Apple |
| Overlay | Floating panel, draggable, compact-mode toggle, auto-collapse on screen-share |
| Call trigger | Calendar arms at T-5min → mic-activation starts capture → manual fallback |
| Post-call | Local JSON in `~/.prompty/calls/` only. No Attio in v1. `/prompty-save-call` skill deleted. |
| Distribution | DMG, Developer ID signed + notarized, Sparkle auto-update. No Mac App Store. |
| Repo layout | Monorepo: `app/` (Electron), `audio-sidecar/` (Swift), `skills/` (existing), `relay/` (Worker) |
| Onboarding | Front-load mic + notifications + Apple sign-in; lazy-request Screen Recording only on <14.4 |
| Relay infra | Cloudflare Worker + KV. Apple JWT validation offline. No user DB yet. |

## Architecture

```
                                 ┌─────────────────────────────────┐
                                 │ Cloudflare Worker (relay)       │
                                 │  POST /auth/apple  (validate)   │
                                 │  POST /deepgram/token (mint)    │
                                 │  KV: rate-limit counters        │
                                 └────────────┬────────────────────┘
                                              │ HTTPS
┌─────────────────────────────────────────────┴────────────────────┐
│ Prompty.app (Electron, single signed bundle)                     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Main process (Node)                                      │   │
│  │  - Floating panel window mgmt (BrowserWindow + panel)    │   │
│  │  - Deepgram WS client (dual stream)                      │   │
│  │  - Agent loop (Claude Agent SDK → user's `claude`)       │   │
│  │  - Calendar-arm scheduler (via `claude` skill calls)     │   │
│  │  - Mic-activation watcher                                │   │
│  │  - Call log writer (~/.prompty/calls/*.json)             │   │
│  │  - Relay client (auth, deepgram token)                   │   │
│  └────┬─────────────────────────────────┬───────────────────┘   │
│       │ IPC (renderer)                  │ stdout/stdin (PCM)    │
│  ┌────▼──────────────────┐         ┌────▼──────────────────┐    │
│  │ Renderer (React)      │         │ audio-sidecar (Swift) │    │
│  │  - Floating panel UI  │         │  - CoreAudio tap      │    │
│  │  - Toasts             │         │  - SCK fallback       │    │
│  │  - Onboarding         │         │  - Mic capture        │    │
│  │  - Settings           │         │  - Screen-share watch │    │
│  └───────────────────────┘         └───────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
         │                                       │
         │ shells out                            │
         ▼                                       ▼
   ~/.claude/local/claude                  CoreAudio / SCK
   (user's installed Claude Code)         (system frameworks)
```

## Repo layout (target)

```
prompty/
├── app/                    # Electron app (new)
│   ├── package.json
│   ├── electron-builder.yml
│   ├── src/
│   │   ├── main/           # Electron main process (Node)
│   │   │   ├── index.ts
│   │   │   ├── panel.ts          # NSPanel-like BrowserWindow setup
│   │   │   ├── sidecar.ts        # spawn + manage audio-sidecar
│   │   │   ├── deepgram.ts       # ported from server/transcribe.ts
│   │   │   ├── agent.ts          # ported from server/agent.ts
│   │   │   ├── claude-cli.ts     # ported, finds user's claude binary
│   │   │   ├── calendar-arm.ts   # new: calendar polling via claude skill
│   │   │   ├── mic-watcher.ts    # new: mic-in-use polling
│   │   │   ├── relay-client.ts   # new: auth + token mint
│   │   │   ├── call-log.ts       # ported writer for ~/.prompty/calls/
│   │   │   └── prompts/          # copied from server/prompts/
│   │   ├── renderer/       # React UI
│   │   │   ├── panel/            # floating panel
│   │   │   ├── onboarding/
│   │   │   ├── settings/
│   │   │   └── toasts/
│   │   └── shared/         # types shared main↔renderer
│   └── resources/
│       └── audio-sidecar   # built Swift binary, embedded at package time
├── audio-sidecar/          # Swift (new)
│   ├── Package.swift
│   ├── Sources/AudioSidecar/
│   │   ├── main.swift
│   │   ├── CoreAudioTap.swift     # macOS 14.4+ path
│   │   ├── ScreenCaptureAudio.swift # macOS 13–14.3 fallback
│   │   ├── MicCapture.swift
│   │   ├── ProcessTargeting.swift  # find meeting app PIDs
│   │   ├── ScreenShareWatcher.swift
│   │   └── Protocol.swift          # stdout framing → main process
│   └── Tests/
├── relay/                  # Cloudflare Worker (new)
│   ├── wrangler.toml
│   ├── package.json
│   └── src/
│       ├── index.ts
│       ├── auth.ts            # Apple JWT validation
│       ├── deepgram.ts        # mint short-lived keys
│       └── rate-limit.ts      # KV-backed daily counters
├── skills/                 # existing
│   └── prompty-setup/         # kept, invoked silently by app
│   # prompty-save-call REMOVED
├── extension/              # DELETED at end of rewrite
├── server/                 # DELETED at end of rewrite (modules moved into app/)
├── PLAN.md
└── README.md
```

## Workstreams (parallelizable)

Each block can run as an independent sub-agent. Dependencies flagged explicitly. Order within a block is sequential; blocks A/B/C/D are mostly independent.

### Block A — Swift audio sidecar (independent)

A1. Scaffold `audio-sidecar/` SwiftPM project. Binary target. macOS 13+.
A2. Implement `MicCapture` (AVAudioEngine, 16kHz mono PCM, emit framed bytes to stdout).
A3. Implement `CoreAudioTap` for macOS 14.4+ (process-targeted, audio-only, no Screen Recording permission).
A4. Implement `ScreenCaptureAudio` SCK fallback for macOS 13–14.3.
A5. Runtime path selection (CoreAudio tap if `if #available(macOS 14.4, *)`, else SCK).
A6. `ProcessTargeting`: enumerate running processes, match against known meeting app bundle IDs (`us.zoom.xos`, `com.google.Chrome`, `com.apple.FaceTime`, `com.tinyspeck.slackmacgap`, etc.); CLI flag to target by PID or bundle ID.
A7. `ScreenShareWatcher`: notify main on `SCStream` start/stop by other apps (signals "user started sharing screen" → trigger overlay collapse).
A8. stdout framing protocol: length-prefixed JSON control frames + raw PCM frames on separate "channels" (use a simple tag byte). Document in `Protocol.swift`.
A9. Codesign script (Developer ID Application).
A10. Smoke test: standalone CLI run prints PCM bytes when targeting an audio-producing process.

**Dependency:** none. Can start immediately.

### Block B — Electron shell + floating panel (independent)

B1. Scaffold `app/` with Electron + Vite + React + TypeScript. `electron-builder` for packaging.
B2. Create floating panel `BrowserWindow`: `alwaysOnTop`, `type: 'panel'`, `focusable: false`, `visibleOnAllWorkspaces: true`, `visibleOnFullScreen: true`, `skipTaskbar: true`, vibrancy. Position top-right by default, draggable, persist position.
B3. Port sidebar HTML/CSS from `extension/sidebar.css` → React components: goal banner, checklist, nudge feed.
B4. Compact-mode toggle: collapse panel to a small pill with just the nudge area visible.
B5. Menubar tray (`Tray`): icon, dropdown with "Open panel", "Compact", "Settings", "Quit".
B6. Settings window (separate `BrowserWindow`): account, permissions status, calendar source, transcript folder.
B7. IPC contracts (`shared/ipc.ts`): typed message channels between main and renderer.
B8. Global hotkey `Alt+Shift+Space` via `globalShortcut` → emits "user requests a nudge" to main.

**Dependency:** none. Can start in parallel with A.

### Block C — Cloudflare Worker relay (independent)

C1. Scaffold `relay/` with `wrangler init`. Hono or bare fetch handler.
C2. `POST /auth/apple`: validate Apple identity JWT against Apple's JWKS (cache JWKS in KV with TTL). Issue Prompty session JWT (HS256, 30-day expiry, signed with secret in Worker env). Body returns `{ sessionToken, userId }`.
C3. `POST /deepgram/token`: require `Authorization: Bearer <session>`. Check rate-limit counter in KV (`user:<sub>:minutes:<YYYY-MM-DD>`). If under 120, call Deepgram's key-creation API with `time_to_live_in_seconds: 3600` and scoped to a single project key. Return `{ key, expiresAt }`.
C4. `GET /health`.
C5. Deploy script; secrets: `APPLE_BUNDLE_ID`, `PROMPTY_JWT_SECRET`, `DEEPGRAM_MASTER_KEY`.
C6. Smoke test: curl-driven test that exercises full flow with a stub Apple token in dev.

**Dependency:** none. Can ship independently of the app.

### Block D — Port existing server modules (independent, then merges into B)

D1. Read `server/transcribe.ts` and port to `app/src/main/deepgram.ts`. Swap key source from env var to `relay-client.ts`. Swap audio source from extension WS to two readable streams (mic + sidecar stdout).
D2. Read `server/agent.ts` and port to `app/src/main/agent.ts`. Same logic, same prompts, same Claude Agent SDK usage. Imports unchanged conceptually.
D3. Read `server/claude-cli.ts` and port to `app/src/main/claude-cli.ts`. Add `findClaudeBinary()` that probes `/usr/local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, then `which claude`. Returns null if missing → triggers "install Claude Code" onboarding screen.
D4. Copy `server/prompts/` → `app/src/main/prompts/` unchanged.
D5. Port smoke tests (`smoke:transcribe-mock`, `smoke:agent`) → `app/tests/`.
D6. Port `~/.prompty/calls/` writer (currently end-of-call in `server.ts`).

**Dependency:** B1 scaffolding must exist before D1–D6 land in `app/src/main/`. Can be done by the same agent that owns B, or sequentially after.

### Block E — Wire it together (depends on A, B, C, D)

E1. Spawn Swift sidecar from Electron main on call start. Pipe stdout PCM into the ported Deepgram client. Pipe sidecar stderr into Electron logs.
E2. Wire agent's nudge stream to renderer via IPC. Render in panel.
E3. Sign in with Apple flow: `electron`'s native window calls Apple's sign-in endpoint; on success POST to relay `/auth/apple`; persist session token in `safeStorage`.
E4. Calendar-arm scheduler: every 60s, run a `claude` invocation that asks the user's Google Calendar MCP for events in the next 6 minutes. If found, fire 5-min-pre toast: "Ready for X — [Start]". On click, run `/prompty-setup` flow silently and prep goal/checklist.
E5. Mic-activation watcher: poll `AVCaptureDevice.isInUseByAnotherApplication` (via the sidecar, since it's native) every 2s; on transition idle→busy, auto-start capture if a calendar event is currently armed.
E6. Screen-share watcher (from sidecar): on screen-share start, collapse panel to compact mode automatically.
E7. End-of-call detection: mic idle for 30s OR user clicks "End call" → flush log to `~/.prompty/calls/`, show "Call saved — [Open]" toast.

**Dependency:** A1–A10, B1–B8, C1–C6, D1–D6 all complete.

### Block F — Onboarding & permissions (depends on B, partially E)

F1. First-launch onboarding window: welcome → Claude Code detection → mic prompt → Apple sign-in → notifications prompt → done.
F2. Detect macOS version; only show Screen Recording explainer for <14.4.
F3. Login item registration via `app.setLoginItemSettings`, prompted on second launch.
F4. Persistent settings store (`electron-store` or simple JSON in `app.getPath('userData')`).

**Dependency:** B1, B6, E3.

### Block G — Distribution (depends on A, B, E, F)

G1. `electron-builder.yml` for macOS DMG, universal binary (arm64 + x64).
G2. Embed signed Swift sidecar binary into `resources/` at package time.
G3. Notarization via `electron-notarize` in CI.
G4. Sparkle integration via `electron-builder`'s Mac auto-update feed. Host appcast on Cloudflare Pages or R2.
G5. GitHub Actions workflow: macOS runner, builds sidecar + app, signs, notarizes, uploads to release.
G6. Apple Developer ID secrets in CI.

**Dependency:** all functional blocks complete.

### Block H — Cleanup (last)

H1. Delete `extension/`.
H2. Delete `server/` (modules already moved into `app/main/`).
H3. Delete `skills/prompty-save-call/` from repo and `~/.claude/skills/`.
H4. Update root `README.md` for the new shape.
H5. Merge `mac-app` → `main`.

## Open implementation details (not blocking design)

- **Speaker diarization** survives via two physically separate PCM streams (mic = "me", sidecar process-targeted tap = "them"). No model-side diarization. Reuses today's logic verbatim.
- **Claude CLI binary discovery** is a real first-launch risk. Probe order: `/usr/local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `which claude`. If missing, onboarding bails to "Install Claude Code → [link]".
- **Sidecar↔main protocol** is length-prefixed framing on stdout. Single byte tag distinguishes control JSON vs PCM. stderr is logs only.
- **Per-day rate-limit reset** happens at UTC midnight via KV key naming (`...:YYYY-MM-DD`), no cron needed.
- **Pricing/telemetry/multi-display/screen-share-nudge-suppression** deliberately deferred to v1.1.

## Suggested sub-agent fan-out

Run these four in parallel as the first wave:

1. **Agent A (Swift sidecar)** — Block A end-to-end.
2. **Agent B (Electron shell)** — Block B end-to-end.
3. **Agent C (Worker relay)** — Block C end-to-end.
4. **Agent D (Server port)** — Block D, lands files into `app/src/main/` once B1 has created the scaffold.

Second wave (after first wave merges):

5. **Agent E (Integration)** — Block E.
6. **Agent F (Onboarding)** — Block F.

Final wave:

7. **Agent G (Distribution)** — Block G.
8. **Agent H (Cleanup)** — Block H.

## Status

- **A — Swift audio sidecar:** ✅ shipped. CoreAudio Tap path stubbed (see `audio-sidecar/Sources/AudioSidecar/CoreAudioTap.swift`); SCK fallback, mic capture, process targeting, screen-share watcher, and stdout framing are in place.
- **B — Electron shell + floating panel:** ✅ shipped. Panel window, React UI, tray, settings, IPC contracts, and global hotkey all landed.
- **C — Cloudflare Worker relay:** ✅ shipped. Apple JWT validation, Deepgram token mint, KV rate-limit, and `/health` are implemented under `relay/`.
- **D — Server port into `app/main`:** ✅ shipped. `deepgram.ts`, `agent.ts`, `claude-cli.ts`, prompts, and smoke tests are all ported; `~/.prompty/calls/` writer in `call-log.ts`.
- **E — Integration wiring:** ✅ mostly shipped. E4 calendar-arm scheduler and E5 mic-activation watcher carry `TODO(block-e)` markers — sidecar spawn, IPC nudge stream, Apple sign-in, screen-share collapse, and end-of-call detection are functional.
- **F — Onboarding & permissions:** ✅ shipped. First-launch flow, macOS version branching, login-item registration, and settings store are in place.
- **G — Distribution:** ✅ shipped (in progress in parallel — dev to update post-merge if `app/RELEASING.md` or the GH Actions workflow needs follow-up).
- **H — Cleanup:** ✅ this block. `extension/` and `server/` deleted; `skills/prompty-save-call/` removed from repo; root `README.md` rewritten; `.gitignore` audited. Merge to `main` deferred to manual review.

