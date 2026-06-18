# Ruby — V1 Gap Plan

> Status: **planned, not started.** Closes the two gaps between the current
> `ruby-rebuild` build and the V1 scope: (1) a post-call transcript view, and
> (2) unifying prep persistence into one persisted-then-cleared brief.
> Everything else in V1 (immediate start, in-call nudges, prep chat, value-gated
> goal/checklist, unordered-coverage checklist, bundled skills, summary card,
> memory) is already built — see `RUBY_MVP.md`.

---

## 1. Scope

Two features. Independent — ship in either order, but Gap 1 is the smaller, fully
self-contained one and is the recommended first cut.

| # | Gap | Surface | Size |
|---|-----|---------|------|
| 1 | Post-call transcript view | renderer only (+1 type field) | small |
| 2 | Unified prep persistence | settings-store + ipc-handlers + renderer | medium |

Out of scope (tracked separately, not part of this plan):
- **Summary "used M" fidelity.** The used-count and nudge attribution are
  *inferred* post-hoc by `summary.ts`, not tracked live. Making them ground-truth
  is a live-tracking change and a separate decision.
- Multiple simultaneous/named preps (a calendar feature, deferred from V1).

---

## 2. Gap 1 — Post-call transcript view  ✅ done

> Shipped: `App.tsx` parses `transcript` (interim lines filtered), and a
> collapsed-by-default `TranscriptSection` renders speaker-labelled lines with
> `mm:ss` timestamps in all three card variants. Covered by
> `tests/e2e/call-transcript.spec.ts`.

### Current state
- The full transcript is already captured and persisted on every call:
  `CallLog.transcript: TranscriptUtterance[]` (`call-log.ts:18`,
  `shared/types.ts:35`).
- `calls:read` returns the full raw log JSON.
- `readCall` in `App.tsx:154` parses `summary`, `title`, `components`,
  `startedAt/endedAt` — but **drops `transcript`**.
- `CallCard` (`App.tsx:~1011`) renders only recap / insights / questionsNotAsked /
  stat.

So the data is on disk; nothing renders it. This is purely a renderer addition.

### Changes
1. **`ParsedCall` type** (`App.tsx`): add `transcript?: TranscriptUtterance[]`.
2. **`readCall`** (`App.tsx:154`): extract `obj.transcript` into the parsed call,
   filtering to `isFinal` utterances (interim results would duplicate lines).
3. **`CallCard`** (`App.tsx`): add a **collapsible Transcript section** below the
   summary, collapsed by default (the summary is the headline; the transcript is
   on-demand). Render speaker-labelled lines — `me` vs `them` styled distinctly —
   each prefixed with an `mm:ss`-into-the-call timestamp (derive from
   `startMs` minus the call's first utterance, mirroring `summary.ts`'s nudge
   timestamp rendering).
4. **Defensive empty state**: older logs predate `transcript`; if absent or empty,
   render nothing (no disclosure toggle) rather than an empty box.
5. **Styles**: scrollable block, reuse existing `S.*` tokens; add `me`/`them`
   line styles.

### Tests
- Unit: `readCall` extracts and `isFinal`-filters transcript from a fixture log.
- E2E: open a past call with a transcript, expand the section, assert utterances
  render with speaker labels.

---

## 3. Gap 2 — Unified prep persistence  ✅ done

> Shipped: `prepComponents` added to `AppSettings`; `ipc-handlers.ts` initialises
> `activePrepComponents` from disk and write-throughs every mutation via
> `setActivePrepComponents`; `call:start` clears the persisted brief
> (directionDraft + prepComponents) and broadcasts a `prep:components` reset;
> the renderer restores components on mount and clears direction + components on
> start. Skill left sticky. Covered by `tests/e2e/prep-persist.spec.ts` (true
> restart: arm → quit → relaunch → restored → clears on start);
> `component-injection.spec.ts` updated for the clear-on-start behavior.
> Note: no separate settings-store unit test — the e2e round-trips through the
> real `electron-store`, which is stronger than mocking it.

### Current state (inconsistent)
The two halves of a "prep" behave oppositely:

| Piece | Where it lives | Survives app restart? | Cleared on call start? |
|-------|----------------|-----------------------|------------------------|
| Direction text | disk — `Settings.directionDraft` (`settings-store`) | **yes** | **no** (lingers) |
| Goal / checklist | memory — `activePrepComponents` (`ipc-handlers.ts:97`) | **no** | yes (`ipc-handlers.ts:201-203`) |
| Skill | disk — `Settings.skill` | yes | **no — sticky by design** |

So a prep done 30 min before a call: direction survives a quit, goal/checklist
evaporate. And direction is never cleared after a call, so it bleeds into the next.

### Target model
**One persistent prep at a time = {direction, goal/checklist}.** Overwritten on
re-prep, **cleared on call start**. Skill is deliberately excluded — it is sticky
and reusable across calls by design (`shared/types.ts:113-116`), so it persists
and is **not** cleared on start. This refines the open question: clearing-on-start
applies to direction + components, not skill.

This serves the "prep for a call in 30 min" case fully: prep now, close the
window, the brief survives, come back and start. One-at-a-time is the correct V1
simplification — it only fails if you need two different calls prepped at once,
which is the deferred calendar feature.

### Changes
1. **Persist components to disk.** Add `prepComponents: PrepComponent[]` to
   `Settings` (`shared/types.ts`, default `[]`) and the `settings-store`. Treat
   `activePrepComponents` as a write-through cache of this value.
2. **Write on arm** (`ipc-handlers.ts`): in `prep:start` reset (line 366),
   `onComponents` (line 373), and `prep:set-components` (line 426), persist
   alongside the in-memory update so components survive an app quit.
3. **Restore on startup** (`ipc-handlers.ts` + `App.tsx`): load persisted
   components into `activePrepComponents` on init, and surface them to the
   renderer on mount — either via `session:state` or a small `prep:get-components`
   handler — so reopening the window shows the armed goal/checklist cards
   (today they only arrive via the live `prep:components` broadcast).
4. **Clear on call start** (`ipc-handlers.ts:201-205`): after folding components
   into `setup`, also clear the *persisted* brief —
   `updateSettings({ directionDraft: "", prepComponents: [] })` — and broadcast so
   an open window resets its direction field and component cards. Today only the
   in-memory `activePrepComponents` is cleared; direction is left untouched.
5. **Renderer reset** (`App.tsx`): on call start, reset the direction editor and
   `prepComponents` state (driven by the broadcast from step 4), so the window
   doesn't show a stale brief for the call that just started.
6. **Overwrite-on-re-prep** already holds: `prep:start` clears
   `activePrepComponents` (line 366) — extend it to clear the persisted copy too.
   Direction overwrite is just the user editing the field (debounced save).

### Edge cases
- **Live call in progress**: `session:state` restores the *live* direction and
  takes precedence over the draft (`App.tsx:185-188`) — preserve that ordering.
- **App quit mid-prep**: components now survive (the core fix).
- **Single main window**: no multi-window contention.

### Tests
- Unit: `settings-store` round-trips `prepComponents`.
- Integration: components armed via `prep:set-components` survive a simulated
  restart (re-read from disk).
- Integration: `call:start` clears persisted `directionDraft` + `prepComponents`
  and broadcasts the reset.
- Integration: a second `prep:start` overwrites the persisted brief.

---

## 4. Open decision to confirm before building

- **Skill stays sticky** (persists across calls, not cleared on start) while
  direction + goal/checklist clear on start. Stated above as the resolved model;
  flagging it explicitly because it's the one place the "clear on start" rule has
  an exception.

## 5. Sequencing

1. **Gap 1** first — small, renderer-only, independently shippable.
2. **Gap 2** second — touches the persistence layer; land behind its own tests.
