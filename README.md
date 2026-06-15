# Prompty (Ruby)

A real-time call coach for macOS. A small floating gem listens to any call — Zoom, Google Meet, FaceTime, Slack huddles, Discord, phone-via-Continuity — and hands you the next good follow-up question while you talk. Only you can see it; the gem is hidden from screen shares.

Audio is captured at the OS level by a Swift sidecar (a CoreAudio process tap), so Prompty doesn't care which app the call lives in.

The product name is **Ruby**; the code stays `prompty`.

## What it does

You're in a conversation where getting good information out of the other person is the point — a discovery call, a user interview, a 1:1. At the moment you'd otherwise say "makes sense, so anyway…", Ruby surfaces the one follow-up that mines what they just said.

The guiding principle, enforced down to the agent's system prompt: **a bad nudge is worse than no nudge.** Ruby is silent by default and only speaks up when it has something that fits the sentence you're on right now.

## The loop

### Start — manual

Ruby does nothing until you reach for it. Start a call with the global hotkey or the menubar item. There is no background mic-watching, no foreground-app polling, no calendar awareness.

Two optional inputs, both free-text and both off by default:

- **Direction** — a free-text box: who you're talking to, what you're after, how readily Ruby should speak up. A stated pacing preference ("only interrupt if critical" / "jump in often") overrides Ruby's default quiet bar.
- **Skill** — an opt-in playbook (`discovery`, `hiring`, `user-interview`). Never the default. You can also drop your own `~/.prompty/skills/<name>/in-call.md` to add or override a skill.

### In-call — the gem

A small ruby gem sits top-right. A faint glow means it's listening. A status tone shows the health of the audio pipeline: `listening`, `no audio`, `reconnecting`, or `error`, so you always know whether Ruby can hear the call.

The gem has three states:

- **Anchor** — at rest, just the gem. Nothing accumulates.
- **Bloom** — when there's something to say, one ephemeral note blooms beneath the gem and fades after a few seconds. At most one note at a time.
- **History** — click the gem to expand a quiet scrollback of the notes surfaced this call; click away to collapse.

Two ways to reach the engine: **proactive** notes (high bar — Ruby decides) and the **on-demand hotkey** (low bar — you asked, so it answers). Cadence is the agent's judgment plus a short display debounce. Nothing pops a notification or makes a sound the other side could notice, and the gem window is hidden from screen share via content-protection.

### After the call — one summary card

Each call is written to `~/.prompty/calls/` with no required input. The card has three sections:

- **Recap** — a few lines.
- **Insights & quotes** — Ruby-assisted ones marked `✦` with a trailing clause naming the nudge that surfaced them. Attribution under-claims when unsure.
- **Questions you didn't ask** — the notes Ruby surfaced that you never picked up.

Plus one quiet stat line: "Ruby surfaced N, you used M."

## Requirements

- macOS 14.4 (Sonoma) or later — the CoreAudio process tap requires it.
- [Claude Code](https://docs.claude.com/en/docs/agents-and-tools/claude-code/overview) installed locally — Prompty shells out to your installed `claude` binary for the agent loop.
- An internet connection (Deepgram for transcription, Anthropic for the agent).
- A Deepgram API key.

## Setup

The Deepgram key is read from `process.env.DEEPGRAM_API_KEY`. Put it in a gitignored `.env` at the repo root:

```sh
cp .env.example .env
# edit .env and set DEEPGRAM_API_KEY=...
```

## Repo layout

```
prompty/
├── app/                          # Electron + React app
│   └── src/main-process/prompts/ # the in-app coaching prompts (base.md + skills/)
├── audio-sidecar/                # Swift CLI: CoreAudio process tap + mic capture
└── README.md
```

## Development

Build the Swift sidecar:

```sh
cd audio-sidecar
swift build -c release
```

Run the Electron app in dev (set the key in `.env` first):

```sh
cd app
npm install
npm run dev
```

`npm run dev` runs via the dev Electron binary; macOS attributes the microphone grant to "Electron" (grant it once). To build and launch the packaged app with your current prompts bundled in:

```sh
npm start
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Prompty.app (Electron)                                           │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Main process (Node)                                      │   │
│  │  - Gem overlay window mgmt (BrowserWindow)               │   │
│  │  - Deepgram WS client (dual stream: mic + tap)           │   │
│  │  - Agent loop (Claude Agent SDK → user's `claude`)       │   │
│  │  - Call log + summary writer (~/.prompty/calls/)         │   │
│  │  - DEEPGRAM_API_KEY read from .env / process env         │   │
│  └────┬─────────────────────────────────┬───────────────────┘   │
│       │ IPC (renderer)                  │ stdout/stdin (PCM)    │
│  ┌────▼──────────────────┐         ┌────▼──────────────────┐    │
│  │ Renderer (React)      │         │ audio-sidecar (Swift) │    │
│  │  - Gem overlay UI     │         │  - CoreAudio tap      │    │
│  │  - Direction + skills │         │  - Mic capture        │    │
│  └───────────────────────┘         └───────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
         │                  │                       │
         │ shells out       │ HTTPS                 │
         ▼                  ▼                       ▼
   ~/.claude/local/claude   api.deepgram.com    CoreAudio
   (user's Claude Code)     (transcription)     (system frameworks)
```

Transcription runs against Deepgram over a WebSocket (two streams — your mic and the system-audio tap). The agent loop runs locally via your installed `claude` binary.

## Smoke tests

From `app/`:

```sh
npm test
```

Runs the transcribe-mock, agent, coach-session, hotkey-answer, system-prompt, and debug-logger/debug-capture smoke checks.

## Prompts and distribution

- `app/PROMPTING.md` — how to edit and test the coaching prompts (including the offline replay harness).
- `app/RELEASING.md` — the local signed-build flow for handing a DMG to a design partner.
