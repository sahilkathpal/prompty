# Ruby — Home → Prep Flow Spec

> Status: **DESIGN AGREED, not yet built.** Resolved with Sahil via a grilling
> session on 2026-06-18. Branch context: `ruby-design-merge` (the designer's UI
> rebuild reconciled with functional work — see `project_ruby_design_merge`).
> Sections §1–§6 are decided; §7 lists the two items I resolved by recommendation
> (open to a quick override); §8 is the build delta; §9 is test impact.

## 0. Problem

The designer's redesign split call entry into two surfaces with two separate
states:

- the **home chat bar** (`HomeScreen`'s local `input`, starts empty, clears on
  send), and
- the **prep screen** direction editor (`prep-direction`, bound to app-level
  `direction`) plus the goal/checklist cards (`prepComponents`).

Prep is reachable only via `home-send` → `openPrep(msg)`, and `openPrep` resets:
`setDirection(msg)` + `setPrepComponents([])`. Two consequences:

1. **The "flesh out, or go?" gate isn't wired.** `prep:start` opens the agent but
   triggers no turn; `openPrepAgent` only *stores* the seed. The home text becomes
   a silent user bubble with no reply until the user types again. `prep.md` has a
   generic "open by asking what the call is" line, not the specific fork.
2. **Restored prep is stranded (the "#3 dead-end").** `direction` and
   `prepComponents` are persisted and restored on mount, but the home bar shows
   its own empty `input`, so the restored brief is invisible — and the only path
   to the screen that would show it (`home-send`) calls `openPrep`, which wipes it
   first.

## 1. The model (decided)

1. **Home text → first prep message.** What's in the home bar *is* the working
   direction. Sending it enters prep and `prep:start` fires a **content-aware**
   opening turn that reflects the brief back and ends in the fork.
2. **Turn 1 is strictly the fork.** The opening turn seeds the direction verbatim
   and asks only *"flesh this out, or go?"* — it does **not** fold the text into a
   `Focus:` line and does **not** offer a goal/checklist. Component offers happen
   only on later turns, if the user chooses to flesh out.
3. **"Go" = the Start button.** "Flesh out" is typing; "go" is clicking Start
   (`prep-begin`), always visible on prep. The agent stays **out of the call
   lifecycle** — a bare typed "go"/"yes" is a no-op nudge ("hit Start whenever"),
   never folded into the direction and never starts a call.
4. **One persisted "pending prep" unit.** `direction` + `prepComponents` are a
   single artifact that survives window close/restart and is cleared in **exactly
   two places**: on **call start** (consumed) and on an **explicit discard**
   ("Start fresh"). Nowhere else — no fuzzy "did the text change enough" matching.
5. **Home is progressive.** Clean/empty by default (the designer's home).
   When a pending prep exists, the direction sits in the bar and one quiet muted
   line appears beneath it — *"Pinned: a goal · 2 checklist items"* — with a small
   **Start fresh** (×). Send → into prep; × → clear direction + components, back to
   the clean state.

## 2. State & persistence

- The home bar binds to app-level **`direction`** (drop `HomeScreen`'s separate
  local `input`; seed from restored `direction` on mount). Editing the bar edits
  `direction`; it is the same state the prep `prep-direction` editor shows.
- **`openPrep` stops clearing.** Entering prep becomes navigation only:
  `setScreen(prep)` + `prep:start` with the current `direction`; `prepComponents`
  left intact. (Rename to `enterPrep` to reflect this.)
- Persist the unit together (current `settings.directionDraft` +
  `settings.prepComponents`; restored together on mount). Keep the debounced
  draft write for `direction`; `prepComponents` already persist via
  `prep:set-components`.
- **Clear-on-start** already exists in `startCall` (clears `direction` +
  `prepComponents` and the main process clears the persisted copies).
- **Discard** ("Start fresh") clears `direction` + `prepComponents` (state +
  persisted) and returns to the clean home.

## 3. The opening turn

On `prep:start`, after the agent is opened, Ruby emits **one** opening assistant
turn:

- It reflects the seed direction back in one line and ends in the fork.
- It does **not** rewrite the direction (`Focus:` folding is suppressed for this
  turn) and does **not** pin or offer components.
- It is a **separate path** from `send()` — a normal chat turn keeps its existing
  fold-and-maybe-offer behavior; only this opening turn is special-cased.

`prep.md` gains an explicit instruction for the opening turn (reflect + fork, no
fold, no offer). The opening turn is the *only* guaranteed-present assistant
message; everything after is normal prep.

## 4. Resume behavior

When `prep:start` runs with a **non-empty `prepComponents`** already attached
(the user is resuming a pending prep), the opening turn **acknowledges them**
rather than asking the plain fork — e.g. *"Your goal and checklist are still
here. Want to tweak anything, or are you good to go?"* (§7-B). The agent receives
the existing components on open so it can reference them.

## 5. Home screen surfacing

- **No pending prep** → the clean designer home (bar only). No chrome.
- **Pending prep** → direction in the bar + one muted line beneath:
  `Pinned: <goal?> · <N> checklist items` (omit the parts that are absent) with a
  small **Start fresh** (×). Send → prep; × → discard.
- There is **no Start button on home**. Every call passes through the fork:
  home → send → fork → (flesh out | Start). Resume is the default; starting a
  different call means **Start fresh** (or editing the bar) — acceptable for a
  one-call-at-a-time tool.

## 6. Lifecycle of the pending prep

| Event | Effect |
|---|---|
| Type in home bar | updates `direction` (debounced persist) |
| Send | enter prep, `prep:start` → opening turn; nothing cleared |
| Ruby refines direction / pins components | `direction` / `prepComponents` update + persist |
| Close window / quit | nothing lost; restored on next launch |
| Relaunch | `direction` → home bar; `prepComponents` → shown on resume; "Pinned" line if any |
| **Start call** | consumed — direction + components cleared (state + persisted) |
| **Start fresh (×)** | discarded — direction + components cleared (state + persisted) |

## 7. Resolved-by-recommendation (open to override)

- **7-A — Opening-turn mechanism & mock.** The real agent emits the opening turn
  from `prep.md`. The **mock** (`openMockPrepAgent`) emits a deterministic opening
  bubble incorporating the seed, e.g. `Here's what I've got: "<direction>". Want
  to flesh this out, or hit Start when you're ready?`, and a **resume** variant
  when components are present. This keeps the suite deterministic. Implement via an
  explicit `open()` on the `PrepAgent` (or an opening emit inside `openPrepAgent`),
  distinct from `send()` so the no-fold/no-offer rule holds.
- **7-B — Acknowledge components on resume.** Yes (see §4). The opening turn
  branches on whether components are attached.

## 8. Build delta (from `ruby-design-merge`)

1. Bind home bar to `direction`; remove `HomeScreen`'s local `input`; seed from
   restored `direction`.
2. `openPrep` → `enterPrep`: stop clearing direction/components on entry.
3. Opening turn: `prep:start` emits the content-aware fork (real via `prep.md`,
   mock via a deterministic open emit); suppress `Focus:` folding + component
   offers on turn 1; resume variant when components present.
4. Home "Pinned" line + **Start fresh** discard (conditional on a non-empty
   pending prep).
5. Keep clear-on-start; add clear-on-discard.

## 9. Test impact

- The e2e suite was just re-navigated to the new screen flow (commit `0d45fb5`).
  The opening turn **adds a guaranteed assistant bubble** on entering prep, which
  changes assistant-bubble counts and ordering — specs that assert on
  `prep-msg-assistant` (prep-chat, prep-no-suggest, prep-memory, the `prepArm*`
  helper) will need a pass to account for the opening turn.
- New coverage to add: the opening fork appears on send; "go" typed is a no-op;
  pending prep survives restart **and is visible** (home bar + Pinned line);
  Start fresh discards; call-start still consumes.
- Validate with a local `npm run build && npm run e2e` (the Electron + Swift
  sidecar build is too heavy to run in-session).

## 10. Deferred / not in scope

- Persisting the prep **chat transcript** across restart (only direction +
  components round-trip; the conversation history may start fresh on resume).
- Multiple concurrent pending preps (one-call-at-a-time holds).
