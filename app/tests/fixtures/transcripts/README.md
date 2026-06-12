# Writing synthetic call transcripts (replay fixtures)

These `*.jsonl` files are hand-authored conversations the replay harness
(`npm run replay`) feeds through the real coaching session offline, so you can
watch what the prompt does without running a live call. Committed and shared —
unlike real recordings, which stay local in `~/.prompty/`.

See `../../../PROMPTING.md` for the full iteration loop. This file is just the
fixture *format* and how to author a good one.

## Format

One JSON object per line (the same debug-JSONL format the live debug logger
writes, so a real recording and a hand-authored fixture load through one code
path). Three line kinds:

### 1. `session-start` — the first line, the call setup

```json
{"kind":"session-start","goal":"…","direction":"…","skill":"discovery","checklist":[{"id":"team","text":"How big is the team?","status":"open"}],"attendee":{"name":"Dana","company":"Linear","bio":"Staff eng"}}
```

| field | required | notes |
|---|---|---|
| `goal` | no | the one outcome for the call |
| `direction` | no | the primary steer — prose describing what a good call looks like |
| `skill` | no | `discovery` \| `hiring` \| `user-interview`, or omit for base-only |
| `checklist` | no | array of `{id, text, status}`; status = `open`\|`partial`\|`covered`\|`skipped` |
| `attendee` | no | `{name, company, email, bio, summary}` — any subset |

All optional — a bare `{"kind":"session-start"}` runs on `base.md` alone. You can
also leave these out and impose them at run time with `--skill` / `--goal` /
`--direction` (handy for testing one transcript under several setups).

### 2. `utterance` — a line someone said

```json
{"kind":"utterance","speaker":"them","text":"We finished the Kafka rollout last quarter.","startMs":0,"endMs":0}
```

- `speaker`: **`them`** = the other party, **`me`** = the user being coached.
- `text`: what was said.
- `startMs`/`endMs`: leave `0` — replay is settle-between, timing isn't used.

Lines replay top-to-bottom; each `them`/`me` utterance triggers one agent turn.

### 3. `agent-turn` with `trigger:"hotkey"` — a hotkey press

```json
{"kind":"agent-turn","trigger":"hotkey"}
```

Insert wherever you want to exercise the "what should I ask?" one-shot. Put it at
a natural "your turn" beat (e.g. right after they ask "so what did you want to
dig into?"). Omit it entirely if you're not testing the hotkey.

(Any other line kinds in a real recording — `interim`, `nudge`, auto
`agent-turn`, `summary-update`, `status` — are ignored by the harness; it
regenerates all of that live. You never hand-author them.)

## Writing a GOOD synthetic call

The hard-won lesson: **clean, well-formed transcripts lie.** A fixture where every
line is a tidy complete sentence is unrealistically easy and hides real bugs (a
pristine 10-line fixture never exposed a tool-calling drift that a messy real
call surfaced immediately). To make a fixture earn its keep:

- **Be realistically messy.** Real Deepgram output is fragmented: mid-sentence
  cut-offs, partial thoughts split across lines, filler, false starts
  (`"I clearly"`, `"told her, like, what it is"`, `"but but, yeah"`). Mix these
  in, don't write a polished script.
- **Include dead air, not just gold.** Small talk, acknowledgements (`"Yeah."`,
  `"Nice."`), tangents. A good prompt should stay *quiet* through these — a
  fixture that's all signal can't test restraint.
- **Plant a few real openings.** One or two moments where the prospect reveals
  pain / a buying signal / a checklist-relevant thread, so a healthy prompt has
  something legitimate to deepen or pivot on.
- **Vary length.** Short fixtures (~10 lines) are fast to iterate on but won't
  expose long-session behavior. Keep at least one longer fixture (40+ turns) —
  some failure modes only appear after many turns.
- **Name the scenario in the filename.** `discovery-kafka.jsonl`,
  `hiring-pushy-candidate.jsonl` — one fixture per behavior you want to probe.

## Authoring loop

```bash
# 1. Sanity-check structure without calling the model:
npm run replay -- --parse-only tests/fixtures/transcripts/my-fixture.jsonl

# 2. Run it for real:
npm run replay -- tests/fixtures/transcripts/my-fixture.jsonl
```

## Prefer recording over hand-authoring

The best fixtures are *real*: turn on the `debugMode` setting, take a call, and
`~/.prompty/debug/call-*.jsonl` already has correct structure, real fragmentation,
and hotkey markers. Hand-author only for deliberate edge cases you can't easily
record (or can't share because the real one is sensitive). See
`discovery-kafka.jsonl` in this folder as a worked example.
