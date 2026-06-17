# Tests

The suite is layered as a pyramid. The first three layers are **deterministic
and consume no Claude quota** — they're what `npm test` runs. The real lanes are
opt-in, cost quota, and are run on demand (before a release).

```
real lane (on-demand, quota) ── npm run e2e:real · npm run replay:real
E2E (mocked, fast) ──────────── npm run e2e          Playwright + Electron, mocked agent/audio/DG
integration (fakes) ─────────── npm run test:int     Vitest: module seams (deepgram/sidecar/journal/session)
unit (pure) ─────────────────── npm run test:unit    Vitest: prompt builders, parsing, state machines
types ───────────────────────── npm run typecheck    tsc --noEmit
swift ───────────────────────── npm run test:swift   SwiftPM: the sidecar wire protocol
```

`npm test` = `typecheck && test:unit && test:int && e2e` — fully offline, no quota.

## Layers

### Unit (`tests/unit/`, Vitest)
Pure logic: system-prompt assembly, hotkey/summary prompt builders, call-log
title derivation, memory CRUD, Deepgram message→utterance mapping + reconnect
backoff, the sidecar frame demuxer, mic-silence detection, post-call summary
JSON parsing/clamping, model selection. No network, no Electron.

### Integration (`tests/integration/`, Vitest)
Module seams driven through their public API with fakes (no real network/process):
- `coach-session` lifecycle + status machine (mock agent, mocked audio/DG)
- auto-consider **coalescing** (the queue contract)
- Deepgram reconnect/pending-buffer against a fake `ws`
- `spawnSidecar` frame routing + respawn against a fake child process
- journal crash-recovery round-trip on a temp dir

The `electron` import is aliased to `tests/fixtures/fake-electron.cjs` in
`vitest.config.ts` so main-process modules import cleanly off-runtime.

### E2E (`tests/e2e/`, Playwright + real Electron)
Drives the **built** app (`npm run build` first) with audio, Deepgram, and the
agent mocked. Shared harness in `tests/e2e/_helpers.ts` (launch, seed, window
plumbing, the `__prompty_e2e` bridge, call-log polling) — import from there
rather than re-inlining per spec.

> **Harness migration:** new specs and `gem`, `checklist-checkoff`,
> `end-call-feedback`, `overlay-end-call`, `hotkey-nudge`, `real-agent` use
> `_helpers.ts`. The remaining specs still carry their own inline copies of the
> same helpers and work as-is; migrate each by deleting its local
> `freshUserDataDir`/`seedSettings`/`launchApp`/`waitForReady`/`get*Page`
> definitions and importing them from `./_helpers` (mechanical, no behavior
> change — the pattern is identical across all of them).

```bash
npm run build      # required: E2E runs the built app
npm run e2e        # all specs except @real
npm run e2e:headed # same, visible windows
npm run e2e:ui     # Playwright UI mode for debugging
```

## Real lanes (opt-in, consume quota)

### `npm run replay:real`
Replays a transcript through the **real** in-call agent offline (mocked audio,
no sidecar/Deepgram) and gates on heuristics: ≥1 nudge over the run, no errors,
no malformed nudges. Exits non-zero on failure.

```bash
npm run replay:real                                   # the committed fixtures
npm run replay:real -- tests/fixtures/transcripts/hiring-staff-eng.jsonl
npm run replay:real -- ~/.prompty/debug               # a recorded session dir
```

Plain `npm run replay` (no `--assert`) is the non-gating "watch what it does"
dev loop. See `fixtures/transcripts/README.md` for the fixture format.

### `npm run e2e:real`
The `@real`-tagged Playwright spec launches the app with the **real** agent
(`PROMPTY_MOCK_AGENT` off) and asserts a real nudge reaches the overlay on a
hotkey press. Audio/Deepgram stay mocked, so no `DEEPGRAM_API_KEY` is needed,
but the `claude` CLI must be installed. Excluded from `npm run e2e` by the
`--grep-invert @real` filter.

## Recording a real fixture

```bash
PROMPTY_DEBUG=1 <run a real call>          # writes ~/.prompty/debug/call-*.jsonl
npm run replay -- ~/.prompty/debug/call-XXXX.jsonl   # replay it
```

Recorded calls stay **local** (`~/.prompty/`). Before committing one to
`fixtures/transcripts/`, scrub names, companies, and anything sensitive — the
fixtures are shared. Hand-authored fixtures (same JSONL format) are the safer
default; insert `{"kind":"agent-turn","trigger":"hotkey"}` to exercise the
hotkey path.

## Known boundaries (hand-verified, not automated)

- **CoreAudio capture** (`CoreAudioTap.swift` / `MicCapture.swift`) needs real
  audio hardware + macOS permission; the wire *protocol* is covered on both ends
  (`npm run test:swift` and `tests/unit/sidecar-protocol.test.ts`), but live
  capture is verified by hand.
- **Onboarding** is bypassed in E2E mode (the `__prompty_e2e` bridge requires
  `PROMPTY_E2E=1`, which skips onboarding). A dedicated non-E2E harness that
  drives the onboarding window directly is the right way to cover it.
