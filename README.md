# Prompty

A real-time call coach for macOS. A small floating panel listens to any call — Zoom, Google Meet, FaceTime, Slack huddles, Discord, phone-via-Continuity — and keeps a live **goal**, **checklist**, and stream of **nudges** in front of you while you talk. Only you can see it.

Platform-agnostic by design: audio is captured at the OS level via a Swift sidecar (CoreAudio process tap on macOS 14.4+, ScreenCaptureKit fallback on 13.0–14.3), so Prompty doesn't care which app the call lives in.

## What it does for you

Most calls go sideways the same way: you forget a question you meant to ask, you drift off your goal, you blank when it's your turn to talk, or the perfect follow-up only occurs to you in the shower afterward. Prompty is a coach in your ear for exactly those moments — it watches the live transcript and surfaces the right thing to say *at the moment it fits*, then gets out of the way.

The guiding principle, enforced all the way down to the agent's system prompt: **a bad nudge is worse than no nudge.** Prompty stays quiet by default and only speaks up when it has something that fits the sentence you're on right now.

### In-call — the core experience

While a call is live, the floating panel shows three things and the agent keeps them current from the running transcript:

- **Goal** — the one outcome you set for this call, pinned at the top so you don't lose the thread.
- **Checklist** — the topics you wanted to cover, treated as *parallel tracks to mine*, not a script to run in order. As you talk, the agent marks items `covered` (✓), `partial` (◐), or leaves them `open` (○). You can click any item to cycle its state yourself, or mark it `skipped` (—) to tell the coach it's off-limits for this call.
- **Nudges** — short, actionable suggestions (≤15 words, phrased as something you can actually say). The agent emits **at most one at a time**, and only when it's clearly useful:
  - **deepen** — the conversation just landed on something that matters; here's the follow-up that mines it further. (The most common, most valuable nudge — people give their best answers when followed up on, not interrupted.)
  - **pivot** — what they just said opens a natural bridge to a track you haven't covered. The nudge names the bridge.
  - **missed goal** — you've drifted off your goal for a stretch; here's what to steer back to.
  - **fact reminder** — a detail from your prep/CRM notes just became relevant.
  - **correction** — you said something that contradicts your notes.

**Heads-up bar (teleprompter).** With the heads-up bar on (the default), nudges flash one at a time in a single-line floating bar — shown long enough to read, queued if they bunch up, and an urgent nudge jumps the line. Turn the bar off and nudges instead collect as a quiet feed inside the panel. Either way, nothing pops a notification or makes a sound the other side could notice.

**"What should I ask?" (⌥⇧Space).** Blanked? Hit the hotkey (or the panel button) and the agent picks the single highest-value thing to say *for this exact moment* — not the next item on a list.

**Status at a glance.** A status dot shows the health of the audio pipeline — `listening`, `no audio`, `reconnecting`, or `error` — so you always know whether the coach can actually hear the call.

**Coaching modes.** The agent's behavior is driven by a swappable mode — `default`, `discovery`, `user-interview`, or `hiring` — each a different system prompt tuned for that kind of conversation. Drop your own `~/.prompty/modes/<name>.md` to override or add modes.

### Before the call — prep

Prompty turns your raw intent into a structured goal and checklist *before* you dial in:

- **Prep interview** — a short conversational setup (powered by your local Claude Code) where you describe what the call is for, and the agent drafts the goal and the tracks to mine.
- **Calendar arming** — connect Google Calendar and Prompty watches your upcoming events, arming itself for calls as they approach so the panel is ready when the meeting starts.
- **Context enrichment** — attendee details, prior CRM notes (Attio), and your own manual framing are folded into the agent's context, so reminders and corrections are grounded in what you already know about the person.
- **Mic-activation watcher** — detects when a call actually starts so coaching kicks in at the right time.

### After the call

Each session is written to a local call log (`~/.prompty/calls/*.json`) with a summary, so you have a record of what was covered against what you set out to do.

## Requirements

- macOS 13 (Ventura) or later
- [Claude Code](https://docs.claude.com/en/docs/agents-and-tools/claude-code/overview) installed locally — Prompty shells out to your installed `claude` binary for the agent loop (silent dependency)
- Internet connection (Deepgram for transcription, Anthropic for the LLM)

## Repo layout

```
prompty/
├── app/              # Electron + React app (main process, renderer, IPC, agent loop)
├── audio-sidecar/    # Swift CLI: CoreAudio tap + SCK fallback + mic capture
├── relay/            # Cloudflare Worker: Apple JWT validation, Deepgram token minting
├── skills/           # Claude Code skills invoked silently by the app
│   └── prompty-setup/
└── README.md
```

## Development setup

Build the Swift sidecar:

```sh
cd audio-sidecar
swift build -c release
```

Run the Electron app:

```sh
cd app
npm install
npm run dev
```

The relay is optional in dev — the app's dev paste-token modal lets you bypass it and feed a Deepgram key directly. Deploy the relay when you need end-to-end auth:

```sh
cd relay
npm install
npx wrangler deploy
```

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
│  │  - Heads-up bar       │         │  - SCK fallback       │    │
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

## Smoke tests

From `app/`:

```sh
npm test
```

Runs `smoke:transcribe-mock` (Deepgram client against a recorded fixture) and `smoke:agent` (agent loop against a synthetic transcript).

## Distribution

See `app/RELEASING.md` for the signed-DMG + notarization + Sparkle auto-update flow.

## Last verified

**2026-06-06** — End-to-end app builds and typechecks; manual call testing pending.
