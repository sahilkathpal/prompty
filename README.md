# Prompty

Real-time teleprompter for Google Meet calls. Defines a goal up front, transcribes both sides of the call live, uses Claude to nudge you with segues / forgotten goals / facts from context.

## Status

End-to-end working: dual-stream audio capture (mic + tab) → live transcription → in-call coaching agent → toast nudges over Meet → transcript log saved locally → post-call Attio note via skill. Verified on real calls.

## Repo layout

```
prompty/
├── server/         # Node backend. Local HTTP + WS on 127.0.0.1:7878.
├── extension/      # Chrome MV3 extension, plain JS, load unpacked.
└── skills/         # Claude Code skills for pre-call setup and post-call save.
```

## Setup

### 1. Secrets

Copy `.env.example` to `.env` at the repo root and fill in your Deepgram key:

```
DEEPGRAM_API_KEY=dg-...
```

That's the only server-side secret. CRM, Calendar, and Gmail context come through the `/prompty-setup` skill via your Claude Code MCPs — configure those in Claude Code, not here.

`.env` is gitignored. Loaded via Node's built-in `--env-file-if-exists`.

### 2. Backend

```bash
cd server
npm install
npm run start         # ws://127.0.0.1:7878
```

### 3. Extension

1. Open `chrome://extensions/`, enable Developer mode.
2. Click "Load unpacked", select the `extension/` directory.
3. Pin the Prompty icon to the Chrome toolbar.

### 4. Claude Code skills

Install the two skills so `/prompty-setup` and `/prompty-save-call` show up in Claude Code:

```bash
mkdir -p ~/.claude/skills
cp -r skills/prompty-setup ~/.claude/skills/
cp -r skills/prompty-save-call ~/.claude/skills/
```

The setup skill is **capability-first** — it uses whichever CRM, calendar, and email MCPs you've connected to Claude Code (Attio/HubSpot/Salesforce, Google Calendar/Outlook, Gmail/Outlook, etc.). Missing capabilities degrade gracefully; the skill will just ask you for the info instead.

## Using it

Pre-call and post-call live in Claude Code now (via two skills); the extension just runs the call.

1. Make sure the backend is running (`cd server && npm run start`) — the skill POSTs to it.
2. In Claude Code, run `/prompty-setup`. The skill grabs your next Calendar event, pulls Attio context, grills your goal if it's vague, and pushes `{goal, checklist, context}` to the backend over HTTP.
3. Open the Meet tab — the sidebar shows the goal + checklist that was just pushed.
4. Click the Prompty toolbar icon once (this grants `activeTab`, which `tabCapture` needs as a user gesture). Then click "Start call" in the sidebar — Chrome prompts to share the tab's audio.
5. Talk. Toast nudges fade in at the top of the Meet window as the agent decides they're worth surfacing. Press `Alt+Shift+Space` to ask "what should I ask?".
6. Click "End call" — transcript + nudge log saved to `~/.prompty/calls/<stamp>-<attendee>.json`.
7. In Claude Code, run `/prompty-save-call`. The skill reads the latest log, composes a post-call note, finds the person in Attio (never creates a new record), and attaches the note.

The skills live at `~/.claude/skills/prompty-setup/` and `~/.claude/skills/prompty-save-call/`. Vendored copies sit in `prompty/skills/` for self-containment.

## Smoke tests

The server has self-contained smoke tests for the two critical pieces.

**Transcription** (mock Deepgram — no key needed):
```bash
cd server
npm run smoke:transcribe-mock
```

**Transcription against real Deepgram** (needs `DEEPGRAM_API_KEY` in `.env`):
```bash
npm run smoke:transcribe
```
Auto-synthesizes two short speech clips via macOS `say` if no fixtures are present. Drop your own 16kHz mono PCM `.wav` files at `server/test-fixtures/them.wav` and `server/test-fixtures/me.wav` to test against real recordings instead.

Last verified 2026-06-01: pass. Both streams transcribed correctly with zero errors.

**Agent nudge loop** (calls Claude via the Agent SDK — consumes Max-plan quota):
```bash
cd server
npm run smoke:agent
```
Last verified 2026-06-01: pass. 2 nudges + 2 checklist updates + 0 errors across 3 canned turns. Latency 3.9–5.3s/turn.

Context fetching and goal grilling are no longer server-side — both moved into Claude Code skills (`/prompty-setup`).

One SDK gotcha worth knowing for the in-call agent: set `pathToClaudeCodeExecutable` to the installed `claude` binary — the SDK's bundled `cli.js` doesn't carry your Claude.ai OAuth context. Handled by `server/claude-cli.ts`.

## Architecture notes

- The backend is the source of truth for the nudge loop. The extension is a thin audio + UI shim.
- The Agent SDK call uses your Claude Max subscription via the local `claude` CLI — no API billing. Watch for rate-limit ceilings on long calls.
- Audio is never persisted. Only transcript + nudge log are written, to `~/.prompty/calls/{stamp}-{attendee}.json`.
- The sidebar and toast overlay live in separate shadow DOM hosts so Meet's styles can't bleed in.
- In-call coaching style is mode-driven. Bundled modes (`server/prompts/modes/*.md`): `default`, `discovery`, `user-interview` (Mom Test), `hiring`. Drop your own at `~/.prompty/modes/<name>.md` to override or add — backend reads them per call, no rebuild.
