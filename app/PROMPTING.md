# Iterating on Prompty's prompts

How to tweak the coach's behavior, test it without a live call, and share changes
with the team. Aimed at anyone comfortable in Claude Code editing `.md` files.

## Where the prompts live

All coaching behavior is prose you edit directly — `system.ts` is just a
slot-filler, no philosophy lives in code:

- `src/main-process/prompts/base.md` — the invariant in-call core (the main file).
  It is deliberately broad: a tool contract (`emit_nudge` / `stay_quiet`), a
  follow-up philosophy, and a pacing-override rule. No per-call specifics live here.
- `src/main-process/prompts/skills/<skill>/in-call.md` — per-skill playbooks
  (today: `discovery`, `hiring`, `user-interview`). A call with no skill runs on
  `base.md` + the call's direction alone.

At runtime the loader checks `~/.prompty/` overrides first, then the bundled
copy. The replay harness and `npm start` both read the **repo** files
directly, so editing `base.md` and re-running either picks the change up
immediately — no build, no `~/.prompty` copy needed.

The agent has exactly two tools: `emit_nudge(text, urgency)` and
`stay_quiet(reason)`. Every turn it must call exactly one of them.

## The three-tier loop

### Tier 1 — `npm run replay` (fast, no live call)

Replays a fixed transcript through the **real** coaching session offline
(`startSession` with mocked audio — real agent, real running summary, real
hotkey one-shot). Each prompt edit shows you the exact nudges in seconds.

Replay still resolves a Deepgram key on startup (even though audio is mocked),
so run it with the mock flag or a real key:

```bash
PROMPTY_MOCK_DEEPGRAM=1 npm run replay   # no key needed (audio is mocked anyway)
```

(If you have `DEEPGRAM_API_KEY` set in your environment, you can omit the flag.)

```bash
npm run replay                          # built-in committed fixture
npm run replay -- ~/.prompty/debug      # every *.jsonl in a directory
npm run replay -- path/to/call-*.jsonl  # one or more recorded sessions
npm run replay -- --parse-only [path]   # load + print, don't call the model
```

**Flags:**

```
--limit N            replay only the first N utterances (sample big calls cheaply)
--skill <name>       impose a skill playbook the transcript didn't store
--direction <text>   impose a direction steer
--direction-file <p> like --direction, but read the whole prompt from a file
```

Since `base.md` is just the tool contract + broad philosophy, the **direction is
the coaching prompt** — and `--direction-file` is the dev loop for it: keep a
scratch `prompt.md`, edit it in your editor, re-run. (The skill playbook, when
there is one, sits right above the direction in the assembled prompt, so pasting
skill + per-call steer into one direction file is a faithful proxy for `--skill`
while you iterate.)

```bash
PROMPTY_MOCK_DEEPGRAM=1 npm run replay -- --direction-file ./scratch-prompt.md \
  tests/fixtures/transcripts/discovery-kafka.jsonl
```

`--skill`/`--direction` matter because replay always loads your *current* repo
prompts: a transcript that stored a skill loads it automatically, but to test a
**new skill or direction against a transcript that didn't store one**, impose it.
Example — test the discovery playbook on a recorded call, first 30 turns only:

```bash
PROMPTY_MOCK_DEEPGRAM=1 npm run replay -- --limit 30 --skill discovery \
  --direction "Explore their workflow pain before pitching" \
  ~/.prompty/debug/call-2026-06-05T12-54-16-748Z.jsonl
```

The timeline shows, per turn: auto-nudges (💡), stay-quiet reasons (·), and — at a
`⌨️ hotkey` point — what the hotkey one-shot (`answerNow`) would say. It's a
**seeing tool, not a scorer**: the model is nondeterministic, so the same
transcript won't reproduce the same nudges run to run. Read it with your judgement;
don't build a regression diff on it.

**A readable log of each replay.** Every `npm run replay` also writes a full
debug capture + a rendered, human-readable `.md` of the session it just ran:

```
~/.prompty/replay/<source-stem>/call-<startedAt>.jsonl   # debug events
~/.prompty/replay/<source-stem>/call-<startedAt>.md      # readable — open this
```

`<source-stem>` is the replayed transcript's name (e.g. `discovery-kafka`), and
`<startedAt>` is the run's timestamp, so repeated replays of the same transcript
sit side-by-side for comparison. The harness prints the `.md` path at the end of
each run. The `.md` contains the **exact resolved system prompt** (your edited
`base.md` + skill playbook + the call's Direction) and a timeline of every turn
with the model's context and raw response — the "why did it say (or not say) that"
view. (This lives under `~/.prompty/replay/`, NOT `~/.prompty/debug/`, so replaying
`~/.prompty/debug` never picks up its own output.)

**Transcripts (the input).** One format — debug-JSONL — from two sources:

1. **Recorded real calls** — set `PROMPTY_DEBUG=1` in your `.env` (the same
   gitignored file as `DEEPGRAM_API_KEY`), take a call, and a
   `~/.prompty/debug/call-*.jsonl` is written (with `agent-turn` `trigger:"hotkey"`
   lines marking every hotkey press). Replay it forever. **These stay local — we
   don't commit real calls.** (`PROMPTY_DEBUG` is an env switch, not a UI setting:
   it ships in every build but is invisible to external users, who never get a
   `.env`.) Note big calls = one model turn per utterance: a 600-utterance log is a
   long, quota-heavy run.
2. **Hand-authored / AI-generated fixtures** — `tests/fixtures/transcripts/*.jsonl`,
   committed and shared. Same debug-JSONL format: a `session-start` line,
   `utterance` lines, and a `{"kind":"agent-turn","trigger":"hotkey"}` line wherever
   you want the hotkey exercised. Record these, hand-write them, or have an AI
   generate one — see the **generation prompt** in
   `tests/fixtures/transcripts/README.md`.

### Tier 2 — `npm start` (real app, current repo prompts, live call)

Builds and launches the actual Electron app with your just-edited prompts bundled
in. Take a real call and see the live behavior. No DMG setup.

Caveat — **mic permission identity**: `npm start` runs via the dev Electron
binary, so macOS attributes the microphone grant to **"Electron"**, not
"Prompty", and they're tracked separately from any installed DMG's grant. Grant
"Electron" mic access once and you're set. Audio capture is also a touch less
reliable than the packaged app; if you hit the mic-silent warning, fall back to a
packaged build.

### Tier 3 — rebuild & share the DMG

Only when you want a prompt change in a teammate's **installed** app. See
`RELEASING.md` for the local signed build + hand-off.

## Team workflow

The prompts are ordinary committed files, reviewed like any code change:

1. Edit `base.md` / a skill's `in-call.md` in Claude Code.
2. `npm run replay` to eyeball the effect; iterate.
3. Optionally `npm start` to feel it on a real call.
4. Commit, open a PR, review the prose diff.

Teammates stay current with **`git pull && npm start`** — always the latest
prompts and code, no DMG round-trip. The DMG is the fallback for anyone without
the toolchain.
